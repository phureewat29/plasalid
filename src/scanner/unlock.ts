import type Database from "libsql";
import inquirer from "inquirer";
import { basename } from "path";
import { config } from "../config.js";
import { statusSpinner } from "../cli/ux.js";
import {
  findCandidates,
  savePassword,
  recordUse,
  suggestPattern,
  type StoredPassword,
} from "./password-store.js";
import {
  transition,
  isTerminal,
  type UnlockState,
  type UnlockEvent,
  type UnlockOutcome,
} from "./state-machine.js";
import { isEncrypted, unlock } from "./pdf-unlock.js";

export interface UnlockCtx {
  db: Database.Database;
  filePath: string;
  bytes: Buffer;
  interactive: boolean;
}

/**
 * Drive the pure unlock state machine to a terminal state, returning the
 * decrypted bytes and the outcome (plaintext / from-store / from-user) so the
 * caller can persist passwords or record stored-key usage.
 */
export async function unlockIfNeeded(
  ctx: UnlockCtx,
): Promise<{ decrypted: Buffer; outcome: UnlockOutcome }> {
  let state: UnlockState = { kind: "init" };
  while (!isTerminal(state)) {
    const event = await stepUnlock(state, ctx);
    state = transition(state, event);
  }
  if (state.kind === "failed") {
    throw new Error(state.reason);
  }
  if (state.kind !== "done") {
    throw new Error(`unlock loop exited in non-terminal state ${state.kind}`);
  }
  return { decrypted: state.decrypted, outcome: state.outcome };
}

async function stepUnlock(
  state: UnlockState,
  ctx: UnlockCtx,
): Promise<UnlockEvent> {
  switch (state.kind) {
    case "init": {
      const spinner = statusSpinner(`Inspecting ${basename(ctx.filePath)}...`);
      try {
        const encrypted = await isEncrypted(ctx.bytes);
        if (!encrypted) {
          spinner.succeed(`${basename(ctx.filePath)} is not encrypted.`);
          return { kind: "INSPECTED_PLAINTEXT", bytes: ctx.bytes };
        }
        const candidates = findCandidates(
          ctx.db,
          ctx.filePath,
          config.dbEncryptionKey,
        );
        spinner.info(
          `${basename(ctx.filePath)} is encrypted (${candidates.length} saved password${candidates.length === 1 ? "" : "s"} match).`,
        );
        return { kind: "INSPECTED_ENCRYPTED", candidates };
      } catch (err) {
        spinner.fail("Inspection failed.");
        throw err;
      }
    }

    case "trying-stored":
      return await tryStoredPasswords(ctx.bytes, state.candidates);

    case "awaiting-user": {
      if (!ctx.interactive) {
        return { kind: "USER_CANCELLED" };
      }
      const password = await promptForPassword(
        basename(ctx.filePath),
        state.attempt,
      );
      if (!password) {
        return { kind: "USER_CANCELLED" };
      }
      const spinner = statusSpinner("Decrypting...");
      const result = await unlock(ctx.bytes, password);
      if (result.ok && result.decrypted) {
        spinner.succeed("Decrypted.");
        return { kind: "UNLOCK_OK", decrypted: result.decrypted, password };
      }
      spinner.fail(`Incorrect password (attempt ${state.attempt}/3).`);
      return { kind: "UNLOCK_FAIL" };
    }

    default:
      throw new Error(`stepUnlock called with terminal state ${state.kind}`);
  }
}

async function tryStoredPasswords(
  bytes: Buffer,
  candidates: StoredPassword[],
): Promise<UnlockEvent> {
  if (candidates.length === 0) {
    return { kind: "STORED_UNLOCK_EXHAUSTED" };
  }
  const spinner = statusSpinner(
    `Trying saved password 1/${candidates.length}...`,
  );
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    spinner.text = `Trying saved password ${i + 1}/${candidates.length} (pattern ${cand.pattern})`;
    const result = await unlock(bytes, cand.password);
    if (result.ok && result.decrypted) {
      spinner.succeed(
        `Unlocked with saved password (pattern ${cand.pattern}).`,
      );
      return {
        kind: "STORED_UNLOCK_OK",
        decrypted: result.decrypted,
        usedStoredId: cand.id,
      };
    }
  }
  spinner.info("No saved password matched. Asking the user.");
  return { kind: "STORED_UNLOCK_EXHAUSTED" };
}

async function promptForPassword(
  fileName: string,
  attempt: number,
): Promise<string> {
  const message =
    attempt === 1
      ? `This PDF is encrypted. Password for ${fileName}:`
      : `Password for ${fileName} (attempt ${attempt}/3):`;
  const { password } = await inquirer.prompt([
    { type: "password", name: "password", mask: "*", message },
  ]);
  return String(password ?? "").trim();
}

/**
 * After a successful unlock, persist the outcome:
 *   from-store  → bump usage counter on the stored password
 *   from-user   → save the new password under a filename-pattern key
 *   plaintext   → no-op
 */
export function persistUnlockOutcome(
  db: Database.Database,
  filePath: string,
  outcome: UnlockOutcome,
): void {
  if (outcome.kind === "from-store") {
    recordUse(db, outcome.storedId);
    return;
  }
  if (outcome.kind === "from-user") {
    const pattern = suggestPattern(filePath);
    const spinner = statusSpinner(`Saving password for pattern ${pattern}...`);
    try {
      savePassword(db, pattern, outcome.password, config.dbEncryptionKey);
      spinner.succeed(`Saved password for pattern ${pattern} in secure vault.`);
    } catch (err: any) {
      spinner.fail(`Could not save password: ${err.message}`);
      throw err;
    }
  }
}
