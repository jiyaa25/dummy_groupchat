const crypto = require("crypto");

// Configurable master key derivation (preserves backward compatibility)
const SECRET = process.env.CRYPTO_SECRET || "password";
const SALT = process.env.CRYPTO_SALT || "salt";
const MASTER_KEY = crypto.scryptSync(SECRET, SALT, 32);

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Appends 16-byte auth tag (32 hex chars) to ciphertext hex string.
 * @param {string} text Plaintext to encrypt
 * @returns {{ ciphertext: string, nonce: string }}
 */
function encrypt(text) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, nonce);
    let ciphertext = cipher.update(text, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const authTagHex = cipher.getAuthTag().toString('hex');
    return {
        ciphertext: ciphertext + authTagHex,
        nonce: nonce.toString('hex')
    };
}

/**
 * Decrypts AES-256-GCM ciphertext hex with nonce hex.
 * Extracts last 32 hex chars as auth tag for verification.
 * @param {string} encData Hex encoded ciphertext + auth tag
 * @param {string} nonceHex 12-byte nonce hex
 * @returns {string} Decrypted plaintext or fallback error indicator
 */
function decrypt(encData, nonceHex) {
    try {
        if (!encData || !nonceHex || encData.length < 32) {
            return "[Invalid Encrypted Data]";
        }
        const nonce = Buffer.from(nonceHex, 'hex');
        const tag = Buffer.from(encData.slice(-32), 'hex');
        const ciphertext = encData.slice(0, -32);
        const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, nonce);
        decipher.setAuthTag(tag);
        return decipher.update(ciphertext, 'hex', 'utf8') + decipher.final('utf8');
    } catch (e) {
        return "[Decryption Error: Tampered or Invalid Key]";
    }
}

/**
 * Verifies ECDSA signature over SHA-256 against client's exported JWK public key.
 * @param {string} message 
 * @param {string} signatureHex 
 * @param {object|string} publicKeyJWK 
 * @returns {boolean}
 */
function verifySignature(message, signatureHex, publicKeyJWK) {
    try {
        if (!message || !signatureHex || !publicKeyJWK) return false;
        const jwk = typeof publicKeyJWK === 'string' ? JSON.parse(publicKeyJWK) : publicKeyJWK;
        const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        const v = crypto.createVerify('SHA256');
        v.update(message);
        return v.verify({ key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signatureHex, 'hex'));
    } catch (e) {
        return false;
    }
}

module.exports = {
    encrypt,
    decrypt,
    verifySignature,
    MASTER_KEY
};
