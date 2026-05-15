import { getDb } from "../db/connection.js";
import { runReviewAgent } from "../ai/agent.js";
import {
  statusSpinner,
  makePromptUser,
  makeAgentOnProgress,
} from "../cli/ux.js";
import { buildReviewUserMessage, type ReviewScope } from "./prompts.js";

export interface ReviewOptions {
  accountId?: string;
  from?: string;
  to?: string;
  dryRun?: boolean;
  interactive?: boolean;
}

export interface ReviewSummary {
  summary: string;
  dryRun: boolean;
}

/**
 * Walk the existing journal with the review-profile agent: surface open
 * concerns, detect correlated transactions and recurrences, propose fixes,
 * apply them (or print "would do X" stubs when dryRun is on) after the user
 * confirms one step at a time.
 */
export async function runReview(opts: ReviewOptions = {}): Promise<ReviewSummary> {
  const db = getDb();
  const interactive = opts.interactive ?? true;
  const dryRun = !!opts.dryRun;
  const scope: ReviewScope = {
    accountId: opts.accountId,
    from: opts.from,
    to: opts.to,
    dryRun,
  };

  const spinner = statusSpinner(`Reviewing${dryRun ? " (dry-run)" : ""}...`);
  const promptUser = interactive ? makePromptUser(spinner) : undefined;

  let summary = "";
  try {
    await runReviewAgent({
      db,
      prompt: scope,
      initialMessages: [
        { role: "user", content: buildReviewUserMessage(scope) },
      ],
      agentCtx: {
        interactive,
        dryRun,
        promptUser,
        onComplete: (s) => { summary = s; },
      },
      onProgress: makeAgentOnProgress(spinner),
    });
    spinner.succeed(dryRun ? "Review complete (dry-run — no writes)." : "Review complete.");
  } catch (err: any) {
    spinner.fail(`Review failed: ${err.message}`);
    throw err;
  }

  return { summary, dryRun };
}
