import chalk from "chalk";
import { randomUUID } from "crypto";
import { getDb } from "../../db/connection.js";
import { runRecordAgent } from "../../ai/agent.js";
import { makePromptUser, makeAgentOnProgress, statusSpinner } from "../ux.js";
import { listActions, type ActionLogRow } from "../../db/queries/action-log.js";
import { formatAmount } from "../../currency.js";
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
  const correlationId = `cr:${randomUUID()}`;

  const initialMessages: NormalizedMessage[] = [
    { role: "user", content: utterance },
  ];

  try {
    const text = await runRecordAgent({
      db,
      initialMessages,
      prompt: { utterance },
      agentCtx: {
        command: "record",
        correlationId,
        userInput: utterance,
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
    renderActionSummary(correlationId);
  } catch (err: any) {
    spinner.fail(err?.message ?? "Record failed.");
    process.exitCode = 1;
  }
}

function renderActionSummary(correlationId: string): void {
  const actions = listActions(getDb(), { correlationId });
  if (actions.length === 0) return;
  console.log("");
  console.log(
    chalk.dim(
      `Logged ${actions.length} action${actions.length === 1 ? "" : "s"} (${correlationId}):`,
    ),
  );
  for (const a of actions) {
    console.log(chalk.dim(`  · ${describeAction(a)}`));
  }
}

function describeAction(a: ActionLogRow): string {
  const payload = safeJson(a.payload_json);
  switch (a.action_type) {
    case "create_account": {
      const name = payload?.row?.name ? ` — ${payload.row.name}` : "";
      return `create_account ${a.target_id}${name}`;
    }
    case "update_account_metadata": {
      const fields =
        payload?.after && typeof payload.after === "object"
          ? Object.keys(payload.after).join(", ")
          : "";
      return `update_account_metadata ${a.target_id}${fields ? ` — ${fields}` : ""}`;
    }
    case "record_transaction": {
      const date = payload?.transaction?.date ?? "";
      const desc = payload?.transaction?.description ?? "";
      const total = totalDebit(payload?.postings);
      const amount =
        total != null
          ? ` ${formatTotal(total, currencyOf(payload?.postings))}`
          : "";
      return `record_transaction ${a.target_id} — ${[date, desc].filter(Boolean).join(" ")}${amount}`;
    }
    case "adjust_balance": {
      const before = payload?.before_balance;
      const after = payload?.after_balance;
      const currency = currencyOf(payload?.postings);
      if (typeof before === "number" && typeof after === "number") {
        return `adjust_balance ${payload?.account_id ?? a.target_id} — ${formatTotal(before, currency)} → ${formatTotal(after, currency)}`;
      }
      return `adjust_balance ${a.target_id}`;
    }
    case "create_merchant": {
      const name = payload?.canonical_name ?? "";
      return `create_merchant ${a.target_id}${name ? ` — ${name}` : ""}`;
    }
    case "update_merchant_default": {
      return `update_merchant_default ${a.target_id} — ${payload?.before ?? "(none)"} → ${payload?.after ?? "(none)"}`;
    }
    default:
      return `${a.action_type} ${a.target_id}`;
  }
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function totalDebit(postings: any): number | null {
  if (!Array.isArray(postings)) return null;
  return postings.reduce((sum, p) => sum + (Number(p?.debit) || 0), 0);
}

function currencyOf(postings: any): string {
  if (Array.isArray(postings) && postings[0]?.currency)
    return String(postings[0].currency);
  return "THB";
}

function formatTotal(amount: number, currency: string): string {
  return formatAmount(amount, currency);
}
