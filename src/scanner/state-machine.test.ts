import { describe, it, expect } from "vitest";
import {
  transition,
  isTerminal,
  MAX_PASSWORD_ATTEMPTS,
  type UnlockState,
} from "./state-machine.js";

const BUF = Buffer.from("hello");

describe("unlock state machine", () => {
  it("init + plaintext → done(plaintext)", () => {
    const next = transition({ kind: "init" }, { kind: "INSPECTED_PLAINTEXT", bytes: BUF });
    expect(next).toEqual({
      kind: "done",
      decrypted: BUF,
      outcome: { kind: "plaintext" },
    });
    expect(isTerminal(next)).toBe(true);
  });

  it("init + encrypted → trying-stored", () => {
    const next = transition({ kind: "init" }, { kind: "INSPECTED_ENCRYPTED", candidates: [] });
    expect(next).toEqual({ kind: "trying-stored", candidates: [] });
  });

  it("trying-stored + unlock-ok → done(from-store)", () => {
    const next = transition(
      { kind: "trying-stored", candidates: [] },
      { kind: "STORED_UNLOCK_OK", decrypted: BUF, usedStoredId: "fp:1" },
    );
    expect(next).toEqual({
      kind: "done",
      decrypted: BUF,
      outcome: { kind: "from-store", storedId: "fp:1" },
    });
  });

  it("trying-stored + exhausted → awaiting-user(attempt=1)", () => {
    const next = transition(
      { kind: "trying-stored", candidates: [] },
      { kind: "STORED_UNLOCK_EXHAUSTED" },
    );
    expect(next).toEqual({ kind: "awaiting-user", attempt: 1 });
  });

  it("awaiting-user + user-cancelled → failed", () => {
    const next = transition(
      { kind: "awaiting-user", attempt: 1 },
      { kind: "USER_CANCELLED" },
    );
    expect(next).toEqual({ kind: "failed", reason: "password required" });
  });

  it("awaiting-user + unlock-ok → done(from-user)", () => {
    const next = transition(
      { kind: "awaiting-user", attempt: 2 },
      { kind: "UNLOCK_OK", decrypted: BUF, password: "secret" },
    );
    expect(next).toEqual({
      kind: "done",
      decrypted: BUF,
      outcome: { kind: "from-user", password: "secret" },
    });
  });

  it("awaiting-user + fail (under cap) → awaiting-user(attempt+1)", () => {
    const next = transition(
      { kind: "awaiting-user", attempt: 1 },
      { kind: "UNLOCK_FAIL" },
    );
    expect(next).toEqual({ kind: "awaiting-user", attempt: 2 });
  });

  it("awaiting-user + fail (at cap) → failed", () => {
    const next = transition(
      { kind: "awaiting-user", attempt: MAX_PASSWORD_ATTEMPTS },
      { kind: "UNLOCK_FAIL" },
    );
    expect(next.kind).toBe("failed");
    if (next.kind === "failed") {
      expect(next.reason).toMatch(/3 attempts/);
    }
  });

  it("isTerminal recognizes done and failed", () => {
    expect(isTerminal({ kind: "done", decrypted: BUF, outcome: { kind: "plaintext" } })).toBe(true);
    expect(isTerminal({ kind: "failed", reason: "x" })).toBe(true);
    expect(isTerminal({ kind: "init" })).toBe(false);
    expect(isTerminal({ kind: "awaiting-user", attempt: 1 })).toBe(false);
  });

  it("throws on invalid (state, event) pairs", () => {
    const cases: { state: UnlockState; event: any }[] = [
      { state: { kind: "init" }, event: { kind: "UNLOCK_OK", decrypted: BUF, password: "x" } },
      { state: { kind: "trying-stored", candidates: [] }, event: { kind: "USER_CANCELLED" } },
      { state: { kind: "awaiting-user", attempt: 1 }, event: { kind: "STORED_UNLOCK_EXHAUSTED" } },
    ];
    for (const { state, event } of cases) {
      expect(() => transition(state, event)).toThrow(/Invalid unlock transition/);
    }
  });
});
