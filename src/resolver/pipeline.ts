import { getDb } from "../db/connection.js";
import { runResolveAgent } from "../ai/agent.js";
import { listOpenUnknowns, listOpenUnknownsByKind } from "../db/queries/unknowns.js";
import {
  statusSpinner,
  makePromptUser,
  makeAgentOnProgress,
} from "../cli/ux.js";
import { buildResolveUserMessage } from "./prompts.js";

export interface ResolveOptions {
  accountId?: string;
  from?: string;
  to?: string;
  kind?: string;
  interactive?: boolean;
  /** Hard cap on unknowns handed to the agent in one run. Default 200. */
  limit?: number;
}

/**
 * Hand every open unknown to the resolve agent in a single invocation. The
 * agent surveys, applies memory-driven and heuristic resolutions silently,
 * groups what remains, asks the user once per group, and reports back via
 * mark_resolve_done. The pipeline just sets up plumbing and prints the report.
 */
export async function runResolve(opts: ResolveOptions = {}): Promise<string> {
  const db = getDb();
  const unknowns = opts.kind
    ? listOpenUnknownsByKind(db, [opts.kind], opts.limit ?? 200)
    : listOpenUnknowns(db, opts.limit ?? 200);

  if (unknowns.length === 0) return "No open unknowns.";

  const interactive = opts.interactive ?? true;
  const spinner = statusSpinner(`Resolving ${unknowns.length} unknown(s)...`);
  const promptUser = interactive ? makePromptUser(spinner) : undefined;

  let summary = "";
  try {
    await runResolveAgent({
      db,
      prompt: { accountId: opts.accountId, from: opts.from, to: opts.to },
      initialMessages: [{ role: "user", content: buildResolveUserMessage(unknowns) }],
      agentCtx: { interactive, promptUser, onComplete: (s) => { summary = s; } },
      onProgress: makeAgentOnProgress(spinner),
    });
    spinner.succeed("Resolve done.");
  } catch (err: any) {
    spinner.fail(`Resolve failed: ${err.message}`);
    throw err;
  }
  return summary;
}
