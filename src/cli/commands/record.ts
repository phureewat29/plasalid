import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { runRecordAgent } from "../../ai/agent.js";
import { makePromptUser, makeAgentOnProgress, statusSpinner } from "../ux.js";
import type { NormalizedMessage } from "../../ai/provider.js";

export interface RecordCommandOptions {
  utterance: string;
}

export async function runRecordCommand(
  opts: RecordCommandOptions,
): Promise<void> {
  const utterance = opts.utterance.trim();
  if (!utterance) {
    console.error(chalk.red(`Usage: plasalid record "<what happened>"`));
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const spinner = statusSpinner("Thinking...");
  const promptUser = makePromptUser(spinner);
  const onProgress = makeAgentOnProgress(spinner);

  const initialMessages: NormalizedMessage[] = [
    { role: "user", content: utterance },
  ];

  try {
    const text = await runRecordAgent({
      db,
      initialMessages,
      prompt: { utterance },
      agentCtx: {
        interactive: !!process.stdout.isTTY,
        promptUser,
      },
      onProgress,
    });
    spinner.succeed("Done.");
    if (text) {
      console.log("");
      console.log(text);
    }
  } catch (err: unknown) {
    spinner.fail(err instanceof Error ? err.message : "Record failed.");
    process.exitCode = 1;
  }
}
