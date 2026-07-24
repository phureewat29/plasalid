import { describe, it, expect } from "vitest";
import { deriveTransactionId, deriveGroupId } from "./ids.js";

describe("deriveTransactionId / deriveGroupId", () => {
  it("is deterministic", () => {
    expect(deriveTransactionId("hashX", 1, 0)).toBe(deriveTransactionId("hashX", 1, 0));
  });

  it("varies by row index and leg index", () => {
    expect(deriveTransactionId("hashX", 1, 0)).not.toBe(deriveTransactionId("hashX", 1, 1));
    expect(deriveTransactionId("hashX", 1, 0)).not.toBe(deriveTransactionId("hashX", 1, 0, 0));
    expect(deriveTransactionId("hashX", 1, 0, 0)).not.toBe(deriveTransactionId("hashX", 1, 0, 1));
  });

  it("prefixes tx: / tg: and shares the hash between the legless id and the group id", () => {
    const tfid = deriveTransactionId("hashX", 1, 0);
    const gid = deriveGroupId("hashX", 1, 0);
    expect(tfid.startsWith("tx:")).toBe(true);
    expect(gid.startsWith("tg:")).toBe(true);
    expect(tfid.slice(3)).toBe(gid.slice(3));
  });
});
