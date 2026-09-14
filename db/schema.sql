-- Lab 6 schema/migration for the shared PostgreSQL database on SYS2.
-- This schema preserves Lab-5 data and makes message_id globally unique.

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

ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_id VARCHAR(64);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS room_id VARCHAR(100) DEFAULT 'LOBBY';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS signature TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS public_key TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin_node VARCHAR(100);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS timestamp TIMESTAMPTZ DEFAULT NOW();

UPDATE messages SET message_id = 'legacy-' || id::text
WHERE message_id IS NULL OR btrim(message_id) = '';

DELETE FROM messages a USING messages b
WHERE a.message_id = b.message_id AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_message_id ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id ASC);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room_id, timestamp ASC);
