import { describe, it, expect } from "vitest";
import { generateKey, encryptSecret, decryptSecret } from "./encryption.js";

describe("generateKey", () => {
  it("returns a 64-character lowercase hex string", () => {
    const key = generateKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different value each call", () => {
    expect(generateKey()).not.toBe(generateKey());
  });
});

describe("encryptSecret / decryptSecret", () => {
  const dbKey = generateKey();

  it("round-trips a plaintext secret", () => {
    const ct = encryptSecret("hunter2", dbKey);
    expect(ct).toMatch(/^gcm:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(decryptSecret(ct, dbKey)).toBe("hunter2");
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const a = encryptSecret("same", dbKey);
    const b = encryptSecret("same", dbKey);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, dbKey)).toBe("same");
    expect(decryptSecret(b, dbKey)).toBe("same");
  });

  it("rejects decryption under a different key", () => {
    const ct = encryptSecret("topsecret", dbKey);
    const wrong = generateKey();
    expect(() => decryptSecret(ct, wrong)).toThrow();
  });

  it("passes through when dbKey is empty (encryption disabled)", () => {
    expect(encryptSecret("topsecret", "")).toBe("topsecret");
    expect(decryptSecret("topsecret", "")).toBe("topsecret");
  });

  it("treats malformed input as plaintext when prefix is missing", () => {
    expect(decryptSecret("not-encrypted", "anything")).toBe("not-encrypted");
  });
});
