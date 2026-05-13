import { getDb } from "../db/connection.js";
import { runReconcileAgent } from "../ai/agent.js";
import {
  statusSpinner,
  makePromptUser,
  makeAgentOnProgress,
} from "../cli/ux.js";
import { buildReconcileUserMessage, type ReconcileScope } from "./prompts.js";

export interface ReconcileOptions {
  accountId?: string;
  from?: string;
  to?: string;
  dryRun?: boolean;
  interactive?: boolean;
}

export interface ReconcileSummary {
  summary: string;
  dryRun: boolean;
}

/**
 * Walk the existing journal with the reconcile-profile agent: detect duplicate
 * entries, similar accounts, and unused accounts; propose fixes; apply them
 * (or print "would do X" stubs when dryRun is on) after the user confirms.
 */
export async function runReconcile(opts: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const db = getDb();
  const interactive = opts.interactive ?? true;
  const dryRun = !!opts.dryRun;
  const scope: ReconcileScope = {
    accountId: opts.accountId,
    from: opts.from,
    to: opts.to,
    dryRun,
  };

  const spinner = statusSpinner(`Reconciling${dryRun ? " (dry-run)" : ""}...`);
  const promptUser = interactive ? makePromptUser(spinner) : undefined;

  let summary = "";
  try {
    await runReconcileAgent({
      db,
      prompt: scope,
      initialMessages: [
        { role: "user", content: buildReconcileUserMessage(scope) },
      ],
      agentCtx: {
        interactive,
        dryRun,
        promptUser,
        onComplete: (s) => { summary = s; },
      },
      onProgress: makeAgentOnProgress(spinner),
    });
    spinner.succeed(dryRun ? "Reconcile complete (dry-run — no writes)." : "Reconcile complete.");
  } catch (err: any) {
    spinner.fail(`Reconcile failed: ${err.message}`);
    throw err;
  }

  return { summary, dryRun };
}
