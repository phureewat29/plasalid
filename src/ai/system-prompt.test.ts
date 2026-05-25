import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { userName: "Alpaca", displayCurrency: "THB", displayLocale: "th-TH" },
}));
vi.mock("./context.js", () => ({
  readContext: vi.fn().mockReturnValue(null),
}));

import Database from "libsql";
import { migrate } from "../db/schema.js";
import { createAccount } from "../db/queries/account-balance.js";
import { saveMemory } from "./memory.js";
import { recordQuestion, deferQuestion } from "../db/queries/questions.js";
import {
  buildChatSystemPrompt,
  buildClarifySystemPrompt,
  buildRecordSystemPrompt,
  buildScanSystemPrompt,
} from "./system-prompt.js";

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;

function isTableLine(line: string): boolean {
  if (/^\s*\|/.test(line) && /\|\s*$/.test(line.trim())) return true;
  if (/^[\s|:-]+$/.test(line) && /-{3,}/.test(line)) return true;
  return false;
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "asset:kbank", name: "KBank Savings", type: "asset", parent_id: "asset", subtype: "bank" });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  return db;
}

describe("system prompt builders", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    saveMemory(db, "Wife is Corgi.", "general");
    saveMemory(db, "Prefer THB only.", "preference");
  });

  describe("buildChatSystemPrompt", () => {
    it("composes the expected sections in order", () => {
      const out = buildChatSystemPrompt(db);
      expect(out).toContain("You are Plasalid,");
      expect(out).toContain("Today is ");
      expect(out).toContain("## About Alpaca");
      expect(out).toContain("## Accounts on file");
      expect(out).toContain("Things to remember about Alpaca");
    });

    it("contains no emoji", () => {
      const out = buildChatSystemPrompt(db);
      expect(out).not.toMatch(EMOJI_RE);
    });

    it("never produces table-shaped lines", () => {
      const out = buildChatSystemPrompt(db);
      const tableLines = out.split("\n").filter(isTableLine);
      expect(tableLines).toEqual([]);
    });

    it("shows memory category prefixes for user-facing memories (chat sees all)", () => {
      const out = buildChatSystemPrompt(db);
      expect(out).toContain("[general]");
      expect(out).toContain("[preference]");
    });

    it("omits the open-questions hint when the backlog is empty", () => {
      const out = buildChatSystemPrompt(db);
      expect(out).not.toContain("## Open clarify questions");
    });

    it("surfaces the open-questions hint when count > 0", () => {
      recordQuestion(db, { file_id: null, transaction_id: null, account_id: null, kind: "uncategorized", prompt: "What is this?" });
      const out = buildChatSystemPrompt(db);
      expect(out).toContain("## Open clarify questions");
      expect(out).toContain("1 open question");
      expect(out).toContain("plasalid clarify");
    });

    it("excludes deferred questions from the open-questions hint", () => {
      const id = recordQuestion(db, { file_id: null, transaction_id: null, account_id: null, kind: "uncategorized", prompt: "Snoozed" });
      deferQuestion(db, id, 7);
      const out = buildChatSystemPrompt(db);
      expect(out).not.toContain("## Open clarify questions");
    });
  });

  describe("buildClarifySystemPrompt", () => {
    it("composes the expected sections in order", () => {
      const out = buildClarifySystemPrompt(db, {});
      expect(out).toContain("You are Plasalid,");
      expect(out).toContain("Today is ");
      expect(out).toContain("## Current chart of accounts");
      expect(out).toContain("## Scope");
    });

    it("contains no emoji", () => {
      const out = buildClarifySystemPrompt(db, {});
      expect(out).not.toMatch(EMOJI_RE);
    });
  });

  describe("buildRecordSystemPrompt", () => {
    it("composes the expected sections in order and echoes the utterance", () => {
      const out = buildRecordSystemPrompt(db, { utterance: "spend 100 coffee" });
      expect(out).toContain("You are Plasalid,");
      expect(out).toContain("## What the user said");
      expect(out).toContain("> spend 100 coffee");
    });

    it("renders general/preference memories without category labels", () => {
      const out = buildRecordSystemPrompt(db, { utterance: "noop" });
      expect(out).toContain("Wife is Corgi.");
      expect(out).toContain("Prefer THB only.");
      expect(out).not.toContain("[general]");
      expect(out).not.toContain("[preference]");
    });

    it("collapses newlines in the utterance so the prompt stays single-block", () => {
      const out = buildRecordSystemPrompt(db, { utterance: "line one\nline two" });
      expect(out).toContain("> line one line two");
    });
  });

  describe("buildScanSystemPrompt", () => {
    it("composes the expected sections in order", () => {
      const out = buildScanSystemPrompt(db, { fileName: "stmt.pdf" });
      expect(out).toContain("You are Plasalid,");
      expect(out).toContain("## File context");
      expect(out).toContain("stmt.pdf");
      expect(out).toContain("## Taxonomy hints");
    });

    it("renders general memories and hides preference", () => {
      const out = buildScanSystemPrompt(db, { fileName: "stmt.pdf" });
      expect(out).toContain("Wife is Corgi.");
      expect(out).not.toContain("Prefer THB only.");
    });

    it("contains no emoji", () => {
      const out = buildScanSystemPrompt(db, { fileName: "stmt.pdf" });
      expect(out).not.toMatch(EMOJI_RE);
    });
  });
});
