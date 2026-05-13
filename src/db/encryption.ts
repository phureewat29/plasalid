import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const SECRET_KEY_SALT = "plasalid-secret-v1";
const FORMAT_PREFIX = "gcm:";

/** Generate a 32-byte hex string suitable for use as a libsql encryption key. */
export function generateKey(): string {
  return randomBytes(32).toString("hex");
}

function deriveSecretKey(dbKey: string): Buffer {
  return scryptSync(dbKey, SECRET_KEY_SALT, 32);
}

/**
 * Encrypt a secret (e.g. PDF password) at the application layer using AES-256-GCM.
 * Key is derived from the DB encryption key via scrypt. When `dbKey` is empty
 * (user opted out of DB encryption), this is a passthrough.
 *
 * Output format: `gcm:<iv-hex>:<tag-hex>:<ciphertext-hex>`
 */
export function encryptSecret(plaintext: string, dbKey: string): string {
  if (!dbKey) return plaintext;
  const key = deriveSecretKey(dbKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${FORMAT_PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

export function decryptSecret(ciphertext: string, dbKey: string): string {
  if (!dbKey || !ciphertext.startsWith(FORMAT_PREFIX)) return ciphertext;
  const rest = ciphertext.slice(FORMAT_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted secret.");
  }
  const [ivHex, tagHex, ctHex] = parts;
  const key = deriveSecretKey(dbKey);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}
