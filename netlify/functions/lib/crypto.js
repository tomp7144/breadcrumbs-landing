const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
// ENCRYPTION_KEY must be a 64-character hex string (32 bytes) stored in env.
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

function encrypt(plainObject) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const json = JSON.stringify(plainObject);
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decrypt(encryptedString) {
  const [ivHex, authTagHex, ciphertextHex] = encryptedString.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  const json = decipher.update(ciphertext, null, 'utf8') + decipher.final('utf8');
  return JSON.parse(json);
}

module.exports = { encrypt, decrypt };
