const crypto = require("crypto");
const db = require("./db");
const { encrypt, decrypt } = require("./crypto");

/**
 * Ultra-fast in-memory cache of decrypted messages.
 * Pre-serializes JSON for instantaneous GET /feed delivery (< 5ms) without event loop blocking.
 */
let messageCache = [];
let messageIdMap = new Map(); // message_id -> cached message object
let cacheInitialized = false;
let initPromise = null;
let cachedFeedJson = null;

function invalidateFeedCache() {
    cachedFeedJson = null;
}

/**
 * Returns pre-serialized feed JSON string.
 * Recomputed lazily only when new messages are added.
 */
function getFeedJson() {
    if (!cachedFeedJson) {
        cachedFeedJson = JSON.stringify({
            status: "success",
            count: messageCache.length,
            messages: messageCache
        });
    }
    return cachedFeedJson;
}

/**
 * Initializes the in-memory message cache from PostgreSQL.
 * Called once during backend bootstrap.
 */
async function initMessageCache() {
    if (cacheInitialized) return messageCache.length;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            console.log("[Cache] Initializing in-memory message cache from database...");
            const res = await db.query("SELECT * FROM messages ORDER BY id ASC;");
            messageCache = [];
            messageIdMap.clear();

            for (const row of res.rows) {
                const text = row.ciphertext && row.nonce ? decrypt(row.ciphertext, row.nonce) : "";
                const msgObj = {
                    id: String(row.id),
                    message_id: row.message_id,
                    "client-name": row.sender,
                    sender: row.sender,
                    msg: text,
                    message: text,
                    room_id: row.room_id || "LOBBY",
                    origin_node: row.origin_node || "SYS2",
                    timestamp: row.timestamp
                };
                messageCache.push(msgObj);
                messageIdMap.set(row.message_id, msgObj);
            }

            cacheInitialized = true;
            invalidateFeedCache();
            console.log(`[Cache] Cache populated with ${messageCache.length} messages.`);
            return messageCache.length;
        } catch (err) {
            console.error("[Cache] Failed to initialize message cache:", err.message);
            throw err;
        } finally {
            initPromise = null;
        }
    })();

    return initPromise;
}

/**
 * Appends a message to the in-memory cache if not already present.
 */
function appendToCache(msgObj) {
    if (!msgObj || !msgObj.message_id) return;
    if (messageIdMap.has(msgObj.message_id)) return;

    messageIdMap.set(msgObj.message_id, msgObj);
    messageCache.push(msgObj);
    // Different backend processes can commit concurrently; keep the shared feed
    // in database sequence order rather than local arrival order.
    messageCache.sort((a, b) => Number(a.id) - Number(b.id));
    invalidateFeedCache();
}

/**
 * Returns the current size of the cache.
 */
function getCacheSize() {
    return messageCache.length;
}

/**
 * Persists a message with strict unique message_id constraint and idempotent conflict handling.
 * @param {object} params
 * @returns {Promise<{ inserted: boolean, message: object, duplicate: boolean }>}
 */
async function saveMessage({
    roomId = "LOBBY",
    sender,
    text,
    signature = null,
    publicKey = null,
    originNode = "SYS2",
    messageId = null
}) {
    if (!sender || typeof sender !== "string") {
        throw new Error("Invalid sender name");
    }
    if (text === undefined || text === null || typeof text !== "string") {
        throw new Error("Invalid message content");
    }

    // Ensure stable message_id (UUID if not supplied). Truncate to 64 chars to match DB schema.
    const rawId = messageId ? String(messageId).trim() : crypto.randomUUID();
    const finalMessageId = rawId.slice(0, 64);

    // Fast-path in-memory duplicate check
    if (messageIdMap.has(finalMessageId)) {
        const existingMsg = messageIdMap.get(finalMessageId);
        return {
            inserted: false,
            duplicate: true,
            message: existingMsg
        };
    }

    // AES-256-GCM encryption
    const { ciphertext, nonce } = encrypt(text);
    const pubKeyStr = publicKey ? (typeof publicKey === "string" ? publicKey : JSON.stringify(publicKey)) : null;

    // Atomic insert with ON CONFLICT (message_id) DO NOTHING
    const insertSql = `
        INSERT INTO messages (room_id, sender, ciphertext, nonce, signature, public_key, origin_node, message_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (message_id) DO NOTHING
        RETURNING *;
    `;

    const res = await db.query(insertSql, [
        roomId,
        sender,
        ciphertext,
        nonce,
        signature,
        pubKeyStr,
        originNode,
        finalMessageId
    ]);

    if (res.rows && res.rows.length > 0) {
        const row = res.rows[0];
        const newMsg = {
            id: String(row.id),
            message_id: row.message_id,
            "client-name": row.sender,
            sender: row.sender,
            msg: text,
            message: text,
            room_id: row.room_id || roomId,
            origin_node: row.origin_node || originNode,
            timestamp: row.timestamp
        };

        appendToCache(newMsg);

        return {
            inserted: true,
            duplicate: false,
            message: newMsg
        };
    }

    // DB Conflict: message already exists in DB
    const fetchSql = `SELECT * FROM messages WHERE message_id = $1 LIMIT 1;`;
    const existing = await db.query(fetchSql, [finalMessageId]);
    const row = existing.rows[0] || {};
    const decryptedContent = row.ciphertext && row.nonce ? decrypt(row.ciphertext, row.nonce) : text;

    const existingMsg = {
        id: String(row.id || ""),
        message_id: row.message_id || finalMessageId,
        "client-name": row.sender || sender,
        sender: row.sender || sender,
        msg: decryptedContent,
        message: decryptedContent,
        room_id: row.room_id || roomId,
        origin_node: row.origin_node || originNode,
        timestamp: row.timestamp || new Date()
    };

    appendToCache(existingMsg);

    return {
        inserted: false,
        duplicate: true,
        message: existingMsg
    };
}

/**
 * Retrieves all stored messages in chronological order.
 * @returns {Promise<Array<object>>}
 */
async function getAllDecryptedMessages() {
    if (!cacheInitialized) {
        await initMessageCache();
    }
    return messageCache.slice();
}

/**
 * Retrieves messages after a specific sequential ID for cross-node synchronization.
 * Decrypts only new messages and appends them to the in-memory cache.
 * @param {number} lastId 
 * @returns {Promise<Array<object>>}
 */
async function getMessagesAfterId(lastId = 0) {
    const res = await db.query(`SELECT * FROM messages WHERE id > $1 ORDER BY id ASC;`, [lastId]);
    const newItems = [];

    for (const row of res.rows) {
        let msgObj = messageIdMap.get(row.message_id);
        if (!msgObj) {
            const decrypted = row.ciphertext && row.nonce ? decrypt(row.ciphertext, row.nonce) : "";
            msgObj = {
                id: String(row.id),
                message_id: row.message_id,
                "client-name": row.sender,
                sender: row.sender,
                msg: decrypted,
                message: decrypted,
                room_id: row.room_id || "LOBBY",
                origin_node: row.origin_node || "SYS2",
                timestamp: row.timestamp,
                decryptedContent: decrypted
            };
            appendToCache(msgObj);
        }
        newItems.push({
            ...row,
            decryptedContent: msgObj.msg
        });
    }

    return newItems;
}

module.exports = {
    initMessageCache,
    saveMessage,
    getAllDecryptedMessages,
    getMessagesAfterId,
    getCacheSize,
    getFeedJson,
    invalidateFeedCache
};
