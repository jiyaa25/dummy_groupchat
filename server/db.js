const { Pool } = require('pg');
require('./env');

const DB_HOST = process.env.DB_HOST || '172.17.0.63';
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_NAME = process.env.DB_NAME || 'chat_db';
const DB_USER = process.env.DB_USER || 'student';
const DB_PASSWORD = process.env.DB_PASSWORD || 'password123';
const ALLOW_MOCK_DB = process.env.ALLOW_MOCK_DB === 'true';

const pool = new Pool({
    user: DB_USER, host: DB_HOST, database: DB_NAME, password: DB_PASSWORD, port: DB_PORT,
    connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, max: 25,
    keepAlive: true, keepAliveInitialDelayMillis: 10000
});
pool.on('error', err => console.error('[DB Pool Error]', err.message));

// Mock storage is deliberately opt-in and exists only for local unit testing.
const mockMessages = [];
let mockId = 1;
const mockDb = {
    async query(text, params = []) {
        const q = text.toLowerCase();
        if (q.startsWith('create') || q.startsWith('alter') || q.startsWith('delete')) return { rows: [], rowCount: 0 };
        if (q.includes('select max(id)')) return { rows: [{ max: mockMessages.length ? Math.max(...mockMessages.map(m => m.id)) : 0 }] };
        if (q.includes('insert into messages')) {
            const message_id = params[7];
            const existing = mockMessages.find(m => m.message_id === message_id);
            if (existing) return { rows: [], rowCount: 0 };
            const row = { id: mockId++, room_id: params[0], sender: params[1], ciphertext: params[2], nonce: params[3], signature: params[4], public_key: params[5], origin_node: params[6], message_id, timestamp: new Date() };
            mockMessages.push(row); return { rows: [row], rowCount: 1 };
        }
        if (q.includes('where message_id')) return { rows: mockMessages.filter(m => m.message_id === params[0]) };
        if (q.includes('where id >')) return { rows: mockMessages.filter(m => m.id > (params[0] || 0)).sort((a,b) => a.id-b.id) };
        if (q.includes('order by id asc')) return { rows: [...mockMessages].sort((a,b) => a.id-b.id) };
        return { rows: [] };
    }
};

async function query(text, params) {
    if (ALLOW_MOCK_DB) {
        try { return await pool.query(text, params); }
        catch (err) { if (['ECONNREFUSED','28P01'].includes(err.code) || /connect/i.test(err.message)) return mockDb.query(text, params); throw err; }
    }
    return pool.query(text, params);
}

async function initDb() {
    // The table definition is intentionally compatible with the Lab-5 table:
    // do not destroy existing data when moving to Lab 6.
    await query(`
        CREATE TABLE IF NOT EXISTS messages (
            id BIGSERIAL PRIMARY KEY,
            message_id VARCHAR(64) NOT NULL,
            room_id VARCHAR(100) NOT NULL DEFAULT 'LOBBY',
            sender VARCHAR(100) NOT NULL,
            ciphertext TEXT NOT NULL,
            nonce VARCHAR(100) NOT NULL,
            signature TEXT,
            public_key TEXT,
            origin_node VARCHAR(100),
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    // Safe migration for an older Lab-5 database that did not yet have message_id.
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_id VARCHAR(64);`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS room_id VARCHAR(100) DEFAULT 'LOBBY';`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS signature TEXT;`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS public_key TEXT;`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin_node VARCHAR(100);`);
    await query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS timestamp TIMESTAMPTZ DEFAULT NOW();`);

    // Give old rows stable IDs before the unique index is created.
    await query(`
        UPDATE messages
        SET message_id = 'legacy-' || id::text
        WHERE message_id IS NULL OR btrim(message_id) = '';
    `);

    // If an earlier experimental version created duplicate IDs, keep the oldest row.
    await query(`
        DELETE FROM messages a USING messages b
        WHERE a.message_id = b.message_id AND a.id > b.id;
    `);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_message_id ON messages(message_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id ASC);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp ASC);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room_id, timestamp ASC);`);
    console.log('[DB] Schema initialized/migrated; message_id is UNIQUE.');
}

module.exports = { query, initDb, pool, get isMock() { return ALLOW_MOCK_DB && pool.totalCount === 0; } };
