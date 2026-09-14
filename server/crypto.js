const crypto = require('crypto');

// Lab-5 compatible message encryption/signature layer.
// The same MASTER_KEY/SALT must be used by every backend so all nodes can
// decrypt messages stored in the shared PostgreSQL database.
const MASTER_KEY_SECRET = process.env.MASTER_KEY || process.env.CRYPTO_SECRET || 'password';
const MASTER_SALT = process.env.MASTER_SALT || process.env.CRYPTO_SALT || 'salt';
const MASTER_KEY = crypto.scryptSync(MASTER_KEY_SECRET, MASTER_SALT, 32);

function encrypt(text) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, nonce);
    const ciphertext = Buffer.concat([
        cipher.update(String(text), 'utf8'),
        cipher.final()
    ]);
    const authTag = cipher.getAuthTag();
    return {
        ciphertext: Buffer.concat([ciphertext, authTag]).toString('hex'),
        nonce: nonce.toString('hex')
    };
}

function decrypt(ciphertextWithTag, nonceHex) {
    try {
        const raw = Buffer.from(ciphertextWithTag, 'hex');
        if (raw.length < 16) throw new Error('Invalid ciphertext');
        const ciphertext = raw.subarray(0, -16);
        const authTag = raw.subarray(-16);
        const nonce = Buffer.from(nonceHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, nonce);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (err) {
        return '[Decryption Error]';
    }
}

function verifySignature(message, signatureHex, publicKeyJWK) {
    try {
        if (!signatureHex || !publicKeyJWK) return false;
        const key = crypto.createPublicKey({ key: publicKeyJWK, format: 'jwk' });
        const verifier = crypto.createVerify('SHA256');
        verifier.update(String(message));
        verifier.end();
        return verifier.verify(
            { key, dsaEncoding: 'ieee-p1363' },
            Buffer.from(signatureHex, 'hex')
        );
    } catch (err) {
        return false;
    }
}

module.exports = { encrypt, decrypt, verifySignature };
