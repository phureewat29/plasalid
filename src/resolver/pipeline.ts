import chalk from "chalk";
import { getDb } from "../db/connection.js";
import { runResolveAgent } from "../ai/agent.js";
import {
  countOpenUnknowns,
  listOpenUnknowns,
  listOpenUnknownsByKind,
  type CountOpenUnknownsScope,
  type OpenUnknownRow,
} from "../db/queries/unknowns.js";
import {
  statusSpinner,
  makePromptUser,
  makeAgentOnProgress,
} from "../cli/ux.js";
import { runPasses } from "../lib/runPasses.js";
import { buildResolveUserMessage } from "./prompts.js";

export interface ResolveOptions {
  accountId?: string;
  from?: string;
  to?: string;
  kind?: string;
  /** Hard cap on unknowns handed to the agent in one pass. Default 200. */
  limit?: number;
}

const MAX_PASSES = 3;

/**
 * Drain every open unknown by looping the resolve agent until the DB says
 * we're done. Completion and stall detection both read from
 * `countOpenUnknowns(db)` — the LLM has no "I'm done" signal; we trust state,
 * not narration. The loop driver (`runPasses`) owns counting / cap / stall;
 * the hooks below own everything else.
 */
export async function runResolve(opts: ResolveOptions = {}): Promise<string> {
  const db = getDb();
  const scope: CountOpenUnknownsScope = opts.kind ? { kind: opts.kind } : {};
  const startOpen = countOpenUnknowns(db, scope);
  if (startOpen === 0) return "No unknowns to resolve.";

  const spinner = statusSpinner(`Resolving ${startOpen} unknown(s)...`);
  const promptUser = makePromptUser(spinner);
  const onProgress = makeAgentOnProgress(spinner);

  try {
    const finalOpen = await runPasses<number>({
      initial: startOpen,
      maxAttempts: MAX_PASSES,
      isDone:    (open) => open === 0,
      isStalled: (curr, prev) => curr >= prev,
      onPass: async (pass, open) => {
        spinner.text = `Resolving ${open} unknown(s) — pass ${pass}...`;
        await runResolveAgent({
          db,
          prompt: { accountId: opts.accountId, from: opts.from, to: opts.to },
          initialMessages: [
            { role: "user", content: buildResolveUserMessage(listFor(db, opts, scope)) },
          ],
          agentCtx: { interactive: true, promptUser },
          onProgress,
        });
        return countOpenUnknowns(db, scope);
      },
      onStall:   (open) => spinner.info(
        `Resolve made no progress (${open} left). Re-run \`plasalid resolve\` or inspect the data.`,
      ),
      onSuccess: ()     => spinner.succeed("Resolve done."),
      onFail:    (open) => spinner.fail(
        `Resolve left ${open} unknown(s) open after ${MAX_PASSES} pass(es).`,
      ),
    });
    return summarize(startOpen, finalOpen);
  } catch (err: any) {
    spinner.fail(`Resolve failed: ${err.message}`);
    throw err;
  }
}

function listFor(
  db: ReturnType<typeof getDb>,
  opts: ResolveOptions,
  scope: CountOpenUnknownsScope,
): OpenUnknownRow[] {
  const limit = opts.limit ?? 200;
  return scope.kind
    ? listOpenUnknownsByKind(db, [scope.kind], limit)
    : listOpenUnknowns(db, limit);
}

function summarize(startOpen: number, stillOpen: number): string {
  const resolved = startOpen - stillOpen;
  if (stillOpen === 0) return chalk.green(`Resolved ${resolved} unknown(s).`);
  return chalk.yellow(`Resolved ${resolved} of ${startOpen}; ${stillOpen} still open.`);
}
