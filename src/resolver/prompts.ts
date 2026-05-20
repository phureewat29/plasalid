import type { OpenUnknownRow } from "../db/queries/unknowns.js";

/**
 * Kickoff message handed to the resolve agent. Data only — one line per
 * unknown, with all the fields the persona's six-step workflow needs (id,
 * kind, transaction/account/file ids, prompt, options). Instructions live in
 * RESOLVE_PERSONA; the system prompt already carries memory rules.
 */
export function buildResolveUserMessage(unknowns: OpenUnknownRow[]): string {
  const lines = [`${unknowns.length} open unknown(s) to resolve.`, ``, `Unknowns:`];
  for (const c of unknowns) {
    const options = parseOptions(c.options_json);
    const optionsStr = options.length > 0 ? ` | options=[${options.join(" / ")}]` : "";
    lines.push(
      `- ${c.id} | kind=${c.kind ?? "(none)"} | tx=${c.transaction_id ?? "(none)"} | acct=${c.account_id ?? "(none)"} | file=${c.file_id ?? "(none)"}${optionsStr}`,
      `    prompt: ${c.prompt.replace(/\n/g, " ")}`,
    );
  }
  return lines.join("\n");
}

function parseOptions(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === "string") : [];
  } catch {
    return [];
  }
}
