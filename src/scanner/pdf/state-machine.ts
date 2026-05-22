import type { StoredPassword } from "./password-store.js";

/**
 * Pure state machine for the unlock phase of a single file scan. Side effects
 * (mupdf calls, prompts, DB reads) live in the orchestrator; this module only
 * encodes the transition logic so it can be exhaustively unit-tested.
 */

export const MAX_PASSWORD_ATTEMPTS = 10;

export type UnlockOutcome =
  | { kind: "plaintext" }
  | { kind: "from-store"; storedId: string }
  | { kind: "from-user"; password: string };

export type UnlockState =
  | { kind: "init" }
  | { kind: "trying-stored"; candidates: StoredPassword[] }
  | { kind: "awaiting-user"; attempt: number }
  | { kind: "done"; decrypted: Buffer; outcome: UnlockOutcome }
  | { kind: "failed"; reason: string };

export type UnlockEvent =
  | { kind: "INSPECTED_PLAINTEXT"; bytes: Buffer }
  | { kind: "INSPECTED_ENCRYPTED"; candidates: StoredPassword[] }
  | { kind: "STORED_UNLOCK_OK"; decrypted: Buffer; usedStoredId: string }
  | { kind: "STORED_UNLOCK_EXHAUSTED" }
  | { kind: "USER_CANCELLED" }
  | { kind: "UNLOCK_OK"; decrypted: Buffer; password: string }
  | { kind: "UNLOCK_FAIL" };

export function isTerminal(state: UnlockState): boolean {
  return state.kind === "done" || state.kind === "failed";
}

/**
 * Pure transition. Throws if the event doesn't make sense for the current state;
 * the orchestrator never produces such combinations, so reaching the throw is a
 * programmer error worth surfacing loudly.
 */
export function transition(state: UnlockState, event: UnlockEvent): UnlockState {
  switch (state.kind) {
    case "init":
      if (event.kind === "INSPECTED_PLAINTEXT") {
        return { kind: "done", decrypted: event.bytes, outcome: { kind: "plaintext" } };
      }
      if (event.kind === "INSPECTED_ENCRYPTED") {
        return { kind: "trying-stored", candidates: event.candidates };
      }
      break;

    case "trying-stored":
      if (event.kind === "STORED_UNLOCK_OK") {
        return {
          kind: "done",
          decrypted: event.decrypted,
          outcome: { kind: "from-store", storedId: event.usedStoredId },
        };
      }
      if (event.kind === "STORED_UNLOCK_EXHAUSTED") {
        return { kind: "awaiting-user", attempt: 1 };
      }
      break;

    case "awaiting-user":
      if (event.kind === "USER_CANCELLED") {
        return { kind: "failed", reason: "password required" };
      }
      if (event.kind === "UNLOCK_OK") {
        return {
          kind: "done",
          decrypted: event.decrypted,
          outcome: { kind: "from-user", password: event.password },
        };
      }
      if (event.kind === "UNLOCK_FAIL") {
        if (state.attempt >= MAX_PASSWORD_ATTEMPTS) {
          return {
            kind: "failed",
            reason: `incorrect password after ${MAX_PASSWORD_ATTEMPTS} attempts`,
          };
        }
        return { kind: "awaiting-user", attempt: state.attempt + 1 };
      }
      break;

    case "done":
    case "failed":
      // Terminal — no further transitions.
      break;
  }
  throw new Error(`Invalid unlock transition: ${state.kind} + ${event.kind}`);
}
