import type { Command } from "commander";
import { config } from "../../config.js";
import {
  type Column,
  emitList,
  emitObject,
  fail,
  readSecretFromStdin,
  requireYes,
  runAction,
} from "../output.js";
import { openDb } from "../db.js";

/**
 * `vault`: manages file-password patterns for unlocking encrypted statements
 * non-interactively. Passwords are encrypted at rest (see pdf.ts's
 * savePassword); this surface never prints plaintext.
 */

interface AddOpts {
  passwordStdin?: boolean;
}

async function vaultAdd(pattern: string, _opts: AddOpts): Promise<void> {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch (err) {
    fail("USAGE", `invalid regex pattern: ${(err as Error).message}`);
  }

  const password = await readSecretFromStdin();
  if (!password) {
    fail("INPUT_REQUIRED", "no password on stdin", {
      hint: "pipe the password via --password-stdin, e.g. `printf %s 'secret' | plasalid vault add <pattern> --password-stdin`",
    });
  }

  const db = await openDb();
  const { savePassword } = await import("../../ingest/pdf.js");
  const id = savePassword(db, pattern, password, config.dbEncryptionKey);
  emitObject({ id, pattern });
}

async function vaultList(): Promise<void> {
  const db = await openDb();
  const { listPasswords } = await import("../../db/queries/vault.js");
  const rows = listPasswords(db);

  const columns: Column<(typeof rows)[number]>[] = [
    { header: "ID", value: (r) => r.id },
    { header: "PATTERN", value: (r) => r.pattern },
    { header: "USES", value: (r) => String(r.use_count), align: "right" },
    { header: "LAST_USED", value: (r) => r.last_used_at ?? "-" },
  ];
  emitList(rows, columns);
}

interface RmOpts {
  yes?: boolean;
}

async function vaultRm(patternOrId: string, opts: RmOpts): Promise<void> {
  requireYes(opts, `removing vault entry "${patternOrId}"`);
  const db = await openDb();
  const { deletePassword } = await import("../../db/queries/vault.js");
  if (!deletePassword(db, patternOrId)) {
    fail("NOT_FOUND", `no vault entry matching "${patternOrId}"`);
  }
  emitObject({ pattern_or_id: patternOrId, removed: true });
}

export function registerVault(program: Command): void {
  const vault = program.command("vault").description("Manage the credential vault");

  vault
    .command("add <pattern>")
    .description("Add a vault entry for a file pattern (password read from stdin)")
    .option("--password-stdin", "read a password from stdin")
    .action(runAction(vaultAdd));

  vault
    .command("list")
    .description("List vault entries (never prints stored passwords)")
    .action(runAction(vaultList));

  vault
    .command("rm <patternOrId>")
    .description("Remove a vault entry")
    .option("--yes", "skip confirmation")
    .action(runAction(vaultRm));
}
