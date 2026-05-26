import type Database from "libsql";
import { getActiveModel } from "../config.js";
import { replaceHints } from "../db/queries/hints.js";
import { getProvider } from "./providers/index.js";
import {
  renderChartOfAccounts,
  renderMemories,
} from "./prompt-sections.js";

export const DEFAULT_HINTS: readonly string[] = [
  "try: what's my net worth?",
  "try: how many months of runway do I have?",
  "try: which debt costs me the most?",
  "try: when am I credit card free?",
  "try: what's my savings rate?",
  "try: how far am I from retiring?",
  "try: any unused subscriptions?",
  "try: fixed vs variable spend?",
  "try: biggest category jump this week?",
  "try: what changed this month?",
  "try: gaining ground or losing it?",
  "try: which account drives my net worth?",
  "try: top 5 shopping this month?",
  "try: how much went to food this month?",
  "try: average daily burn rate?",
  "try: how much cash did I withdraw?",
  "try: how big should my emergency fund be?",
  "try: any duplicate charges?",
  "try: total spent this year?",
  "try: biggest one-off purchase this year?",
  "try: where can I cut expense easily?",
  "try: idle cash sitting anywhere?",
  "try: any account untouched in 6 months?",
  "try: checking vs savings split?",
  "try: transfers between my accounts?",
  "try: which account grew the most?",
  "try: total debt right now?",
  "try: how much went to interest last month?",
  "try: any debt growing instead of shrinking?",
  "try: avalanche or snowball — what's faster?",
  "try: am I paying more than the minimum?",
];

const HINT_PERSONA = `You generate 10 short "try: …" chat suggestions for the user to type into Plasalid's chat.

Each suggestion is a one-line question about the user's money — phrased so it would surface a useful read.

Rules:
- Every suggestion starts with the literal prefix "try: ".
- Each is under 80 characters total (including the prefix).
- English only. ASCII punctuation only.
- About CATEGORIES, ACCOUNTS, FINANCIAL HEALTH, or the user's stated interests — never about a specific transaction id, merchant id, or single statement row.
- Anchor the suggestions in the user's actual chart of accounts and memories provided in the context. Reuse the category and account names the user actually has.
- Mix themes. Cover net worth, savings rate, debt, category trends, subscriptions, runway, account-level behavior, savings vs investing. Do not repeat a theme.
- Sound natural and friendly — like a friend who read the statements nudging.

Output: a JSON array of exactly 10 strings. No prose around the array, no markdown fence, no explanation.`;

const MAX_HINT_LENGTH = 80;
const REQUIRED_COUNT = 10;
const ASCII_SAFE = /^[\x20-\x7E]+$/;

export async function refreshHints(db: Database.Database): Promise<void> {
  const system = buildSystemPrompt(db);
  const response = await getProvider().sendMessage({
    model: getActiveModel(),
    system,
    messages: [
      {
        role: "user",
        content: "Generate the 10 suggestions now, anchored to my accounts and memories above.",
      },
    ],
    tools: [],
    maxTokens: 1024,
  });

  const text = extractText(response.content);
  const hints = parseAndValidate(text);
  if (hints.length !== REQUIRED_COUNT) {
    throw new Error(`expected ${REQUIRED_COUNT} hints, got ${hints.length}`);
  }
  replaceHints(db, hints);
}

function buildSystemPrompt(db: Database.Database): string {
  const sections = [
    HINT_PERSONA,
    renderChartOfAccounts(db, { withBalance: true, emptyState: "scan" }),
    renderMemories(db, {
      header: "Things to remember about the user",
      showCategory: true,
    }),
  ];
  return sections.filter((s): s is string => !!s).join("\n\n");
}

function extractText(content: { type: string; text?: string }[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map(b => b.text)
    .join("");
}

function parseAndValidate(text: string): string[] {
  const stripped = stripCodeFence(text.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`hint generator returned non-JSON: ${stripped.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("hint generator did not return an array");
  }
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed.startsWith("try: ")) continue;
    if (trimmed.length > MAX_HINT_LENGTH) continue;
    if (!ASCII_SAFE.test(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

function stripCodeFence(s: string): string {
  // Models sometimes wrap JSON in ```json ... ``` even when told not to.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  return fenced ? fenced[1].trim() : s;
}
