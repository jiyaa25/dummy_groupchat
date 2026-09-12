const assert = require("assert");
const crypto = require("crypto");
const { saveMessage, getAllDecryptedMessages } = require("../server/messageService");
const db = require("../server/db");

async function runIdempotencyTests() {
    console.log("=== Running Idempotency & Unique message_id Tests ===");

    await db.initDb();

    const uniqueId = "test-uuid-" + crypto.randomUUID();
    const sender = "Alice";
    const msgText = "Hello Distributed Systems!";

    // 1. Initial Insert
    const firstAttempt = await saveMessage({
        roomId: "LOBBY",
        sender: sender,
        text: msgText,
        originNode: "SYS2",
        messageId: uniqueId
    });

    assert.strictEqual(firstAttempt.inserted, true, "First message insertion should succeed");
    assert.strictEqual(firstAttempt.duplicate, false, "First message should not be flagged as duplicate");
    assert.strictEqual(firstAttempt.message.message_id, uniqueId, "Message ID must match");
    console.log("✓ Initial message insertion succeeded with unique message_id");

    // 2. Retry Attempt with the exact same message_id (Simulating LB retry / network retransmission)
    const retryAttempt = await saveMessage({
        roomId: "LOBBY",
        sender: sender,
        text: msgText,
        originNode: "SYS3", // e.g. retried on another node
        messageId: uniqueId
    });

    assert.strictEqual(retryAttempt.inserted, false, "Duplicate insertion must not create a new row");
    assert.strictEqual(retryAttempt.duplicate, true, "Retry must be detected as duplicate");
    assert.strictEqual(retryAttempt.message.message_id, uniqueId, "Returned message must retain original message_id");
    assert.strictEqual(retryAttempt.message.text, msgText, "Returned message text must match original");
    console.log("✓ Repeated submission with same message_id safely handled idempotently (No duplicate row)");

    // 3. Verify in feed query that only ONE instance exists
    const feed = await getAllDecryptedMessages();
    const matching = feed.filter(m => m.message_id === uniqueId);
    assert.strictEqual(matching.length, 1, "Exactly one message record must exist in DB for this message_id");
    console.log("✓ Database feed confirms exactly 1 unique record stored");

    console.log("✓ ALL IDEMPOTENCY TESTS PASSED!\n");
}

if (require.main === module) {
    runIdempotencyTests().catch(err => {
        console.error("Test failed:", err);
        process.exit(1);
    });
}

module.exports = { runIdempotencyTests };
