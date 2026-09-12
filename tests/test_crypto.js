const assert = require("assert");
const crypto = require("crypto");
const { encrypt, decrypt, verifySignature } = require("../server/crypto");

console.log("=== Running Cryptography & Security Tests ===");

// 1. AES-256-GCM Encryption & Decryption
const testPlaintext = "Distributed Systems Phase 2 Secure Message 12345!";
const { ciphertext, nonce } = encrypt(testPlaintext);

assert.ok(ciphertext, "Ciphertext should be generated");
assert.ok(nonce, "Nonce should be generated");
assert.strictEqual(nonce.length, 24, "Nonce should be 12 bytes (24 hex characters)");

const decrypted = decrypt(ciphertext, nonce);
assert.strictEqual(decrypted, testPlaintext, "Decrypted message must match original plaintext");
console.log("✓ AES-256-GCM Encryption & Decryption verified");

// 2. Tamper Detection
const tamperedCiphertext = "aa" + ciphertext.slice(2);
const tamperedDecrypted = decrypt(tamperedCiphertext, nonce);
assert.ok(tamperedDecrypted.includes("Decryption Error"), "Tampered ciphertext must fail authentication tag check");
console.log("✓ Cryptographic Tamper Detection verified");

// 3. ECDSA Keygen & Verification
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256'
});
const jwkPublic = publicKey.export({ format: 'jwk' });

const sign = crypto.createSign('SHA256');
sign.update(testPlaintext);
const signatureBuffer = sign.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
const signatureHex = signatureBuffer.toString('hex');

const isValid = verifySignature(testPlaintext, signatureHex, jwkPublic);
assert.strictEqual(isValid, true, "Valid ECDSA signature must be verified as true");

const isInvalid = verifySignature("Different Message Text", signatureHex, jwkPublic);
assert.strictEqual(isInvalid, false, "Altered message signature must verify as false");
console.log("✓ ECDSA Signature Generation & Verification verified");

console.log("✓ ALL CRYPTOGRAPHY TESTS PASSED!\n");
