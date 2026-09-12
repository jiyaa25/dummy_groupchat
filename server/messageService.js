const crypto = require("crypto");
const db = require("./db");
const { encrypt, decrypt } = require("./crypto");

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

    // Ensure stable message_id (UUID if not supplied)
    const finalMessageId = messageId ? String(messageId).trim() : crypto.randomUUID();
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
        return {
            inserted: true,
            duplicate: false,
            message: {
                id: row.id,
                message_id: row.message_id,
                room_id: row.room_id,
                sender: row.sender,
                origin_node: row.origin_node,
                timestamp: row.timestamp,
                text: text
            }
        };
    }

    // Duplicate detected: fetch existing record idempotently
    const fetchSql = `SELECT * FROM messages WHERE message_id = $1 LIMIT 1;`;
    const existing = await db.query(fetchSql, [finalMessageId]);
    const row = existing.rows[0] || {};
    const decryptedContent = row.ciphertext && row.nonce ? decrypt(row.ciphertext, row.nonce) : text;

    return {
        inserted: false,
        duplicate: true,
        message: {
            id: row.id,
            message_id: row.message_id || finalMessageId,
            room_id: row.room_id || roomId,
            sender: row.sender || sender,
            origin_node: row.origin_node || originNode,
            timestamp: row.timestamp || new Date(),
            text: decryptedContent
        }
    };
}

/**
 * Retrieves all stored messages in chronological order and decrypts them.
 * @returns {Promise<Array<object>>}
 */
async function getAllDecryptedMessages() {
    const res = await db.query(`SELECT * FROM messages ORDER BY id ASC;`);
    return res.rows.map(row => {
        const decrypted = decrypt(row.ciphertext, row.nonce);
        return {
            id: row.id,
            message_id: row.message_id,
            "client-name": row.sender,
            sender: row.sender,
            msg: decrypted,
            message: decrypted,
            room_id: row.room_id,
            origin_node: row.origin_node,
            timestamp: row.timestamp
        };
    });
}

/**
 * Retrieves messages after a specific sequential ID for sync.
 * @param {number} lastId 
 * @returns {Promise<Array<object>>}
 */
async function getMessagesAfterId(lastId = 0) {
    const res = await db.query(`SELECT * FROM messages WHERE id > $1 ORDER BY id ASC;`, [lastId]);
    return res.rows.map(row => ({
        ...row,
        decryptedContent: decrypt(row.ciphertext, row.nonce)
    }));
}

module.exports = {
    saveMessage,
    getAllDecryptedMessages,
    getMessagesAfterId
};
