const { Pool } = require("pg");
require("dotenv").config();

const DB_HOST = process.env.DB_HOST || "172.17.0.63";
const DB_PORT = parseInt(process.env.DB_PORT || "5432", 10);
const DB_NAME = process.env.DB_NAME || "chat_db";
const DB_USER = process.env.DB_USER || "student";
const DB_PASSWORD = process.env.DB_PASSWORD || "password123";

let pool = null;
const ALLOW_MOCK_DB = process.env.ALLOW_MOCK_DB === "true";
let useMock = ALLOW_MOCK_DB;
let mockMessages = [];
let mockIdSeq = 1;

try {
    pool = new Pool({
        user: DB_USER,
        host: DB_HOST,
        database: DB_NAME,
        password: DB_PASSWORD,
        port: DB_PORT,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 10000,
        max: 20
    });
} catch (e) {
    if (ALLOW_MOCK_DB) {
        console.warn("[DB] Pool creation failed; mock mode enabled for tests:", e.message);
        useMock = true;
    } else {
        throw e;
    }
}

// In-memory mock storage is available only when ALLOW_MOCK_DB=true (for isolated tests).
const mockDb = {
    async query(text, params = []) {
        const lower = text.toLowerCase().trim();
        
        if (lower.startsWith("create table") || lower.startsWith("alter table") || lower.startsWith("create index")) {
            return { rows: [], rowCount: 0 };
        }
        
        if (lower.includes("select max(id)")) {
            const max = mockMessages.length > 0 ? Math.max(...mockMessages.map(m => m.id)) : 0;
            return { rows: [{ max }] };
        }

        if (lower.includes("insert into messages")) {
            // Check ON CONFLICT on message_id
            // params: [room_id, sender, ciphertext, nonce, signature, public_key, origin_node, message_id]
            const roomId = params[0] || 'LOBBY';
            const sender = params[1];
            const ciphertext = params[2];
            const nonce = params[3];
            const signature = params[4] || null;
            const publicKey = params[5] || null;
            const originNode = params[6] || 'Node';
            const messageId = params[7];

            const existing = mockMessages.find(m => m.message_id === messageId);
            if (existing) {
                return { rows: [], rowCount: 0 };
            }

            const newMsg = {
                id: mockIdSeq++,
                message_id: messageId,
                room_id: roomId,
                sender: sender,
                ciphertext: ciphertext,
                nonce: nonce,
                signature: signature,
                public_key: publicKey,
                origin_node: originNode,
                timestamp: new Date()
            };
            mockMessages.push(newMsg);
            return { rows: [newMsg], rowCount: 1, isDuplicate: false };
        }

        if (lower.includes("select * from messages where id >")) {
            const afterId = params[0] || 0;
            const filtered = mockMessages.filter(m => m.id > afterId).sort((a, b) => a.id - b.id);
            return { rows: filtered };
        }

        if (lower.includes("select * from messages order by id asc") || lower.includes("select * from messages")) {
            return { rows: [...mockMessages].sort((a, b) => a.id - b.id) };
        }

        return { rows: [] };
    }
};

async function query(text, params) {
    if (useMock) {
        return mockDb.query(text, params);
    }
    try {
        return await pool.query(text, params);
    } catch (err) {
        if (ALLOW_MOCK_DB && (err.code === 'ECONNREFUSED' || err.code === '28P01' || err.message.includes('connect'))) {
            console.warn("[DB] PostgreSQL unavailable; mock mode is explicitly enabled for tests.");
            useMock = true;
            return mockDb.query(text, params);
        }
        throw err;
    }
}

async function initDb() {
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                message_id VARCHAR(64) UNIQUE NOT NULL,
                room_id VARCHAR(50) DEFAULT 'LOBBY',
                sender VARCHAR(100) NOT NULL,
                ciphertext TEXT NOT NULL,
                nonce VARCHAR(64) NOT NULL,
                signature TEXT,
                public_key TEXT,
                origin_node VARCHAR(50),
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Handle migration if table existed from phase 1 without message_id
        await query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name='messages' AND column_name='message_id'
                ) THEN
                    ALTER TABLE messages ADD COLUMN message_id VARCHAR(64) UNIQUE;
                END IF;
            END $$;
        `).catch(() => {});

        await query(`CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id);`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id);`).catch(() => {});
        console.log("[DB] Schema initialized successfully with UNIQUE(message_id)");
    } catch (err) {
        console.error("[DB] PostgreSQL initialization failed:", err.message);
        if (!ALLOW_MOCK_DB) throw err;
    }
}

module.exports = {
    query,
    initDb,
    get isMock() { return useMock; }
};
