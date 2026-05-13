import { config } from "../config.js";
import { readContext } from "./context.js";

interface RedactionEntry {
  real: string;
  token: string;
}

function buildRedactions(): RedactionEntry[] {
  const entries: RedactionEntry[] = [];
  const seen = new Set<string>();

  function add(real: string, token: string) {
    const trimmed = real.trim();
    if (trimmed.length < 2 || seen.has(trimmed.toLowerCase())) return;
    seen.add(trimmed.toLowerCase());
    entries.push({ real: trimmed, token });
  }

  const userName = config.userName;
  if (userName && userName !== "User") {
    add(userName, "[USER]");
    const parts = userName.split(/\s+/);
    if (parts.length > 1) {
      add(parts[0], "[USER_FIRST]");
      add(parts[parts.length - 1], "[USER_LAST]");
    }
  }

  const context = readContext();
  if (context) {
    const familyMatch = context.match(/## Family\n([\s\S]*?)(?=\n##|$)/);
    if (familyMatch) {
      const lines = familyMatch[1].split("\n").filter(l => l.trim().startsWith("-"));
      for (const line of lines) {
        const text = line.replace(/^-\s*/, "").trim();
        if (!text || text.startsWith("(") || text.toLowerCase() === userName.toLowerCase()) continue;
        const nameMatch = text.match(/^(?:partner|spouse|wife|husband|child|kid|son|daughter|dependent)[:\s]+(.+)/i)
          || text.match(/^([\p{Lu}\p{Lo}][\p{L}\s]+)/u);
        if (nameMatch) {
          const name = nameMatch[1].replace(/\s*\(.*\)/, "").trim();
          if (name && name.toLowerCase() !== userName.toLowerCase()) {
            add(name, "[PARTNER]");
          }
        }
      }
    }

    const incomeMatch = context.match(/## Income\n([\s\S]*?)(?=\n##|$)/);
    if (incomeMatch) {
      const lines = incomeMatch[1].split("\n").filter(l => l.trim().startsWith("-"));
      for (const line of lines) {
        const text = line.replace(/^-\s*/, "").trim();
        if (!text || text.startsWith("(")) continue;
        const employerMatch = text.match(/(?:employer|works? (?:at|for)|employed (?:at|by))[:\s]+([A-Z][\w\s&.,-]+?)(?:\s*[-–—|,;(\n]|$)/i)
          || text.match(/\bfrom ([A-Z][A-Za-z\s&.,-]+?)(?:\s*[-–—|,;(\n]|$)/)
          || text.match(/\bat ([A-Z][A-Za-z\s&.,-]+?)(?:\s*[-–—|,;(\n]|$)/);
        if (employerMatch) {
          add(employerMatch[1].trim(), "[EMPLOYER]");
        }
      }
    }
  }

  entries.sort((a, b) => b.real.length - a.real.length);
  return entries;
}

// Patterns for numeric / identifier PII commonly found in Thai financial data.
const NUMERIC_PII_PATTERNS: [RegExp, string][] = [
  // Thai national ID with dashes: 1-2345-67890-12-3
  [/\b\d-\d{4}-\d{5}-\d{2}-\d\b/g, "[NATID]"],
  // Thai national ID without dashes (13 digits) — must precede the generic ACCT pattern.
  [/\b\d{13}\b/g, "[NATID]"],
  // Thai mobile numbers: 0[689]xxxxxxxx (10 digits starting 06/08/09)
  [/\b0[689]\d{8}\b/g, "[PHONE]"],
  // 16-digit credit card (with optional separators)
  [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[CARD]"],
  // 10–12 digit account / routing numbers at a word boundary
  [/\b\d{10,12}\b(?=\s|$|[,.])/g, "[ACCT]"],
];

export function redact(text: string): string {
  const redactions = buildRedactions();
  let result = text;
  for (const { real, token } of redactions) {
    result = result.replaceAll(real, token);
  }
  for (const [pattern, replacement] of NUMERIC_PII_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function unredact(text: string): string {
  const redactions = buildRedactions();
  let result = text;
  for (const { real, token } of redactions) {
    result = result.replaceAll(token, real);
  }
  return result;
}
