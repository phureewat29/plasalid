import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { userName: "Alpaca", displayCurrency: "THB", displayLocale: "th-TH" },
}));
vi.mock("./context.js", () => ({
  readContext: vi.fn().mockReturnValue(null),
}));

import Database from "libsql";
import { migrate } from "../db/schema.js";
import { createAccount } from "../db/queries/account_balance.js";
import { saveMemory } from "./memory.js";
import {
  buildChatSystemPrompt,
  buildReviewSystemPrompt,
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
    saveMemory(db, "Lazada Thailand is shopping.", "scanning_hint");
    saveMemory(db, "Spotify is Subscription.", "scanning_hint");
    saveMemory(db, "Wife is Corgi.", "general");
    saveMemory(db, "Prefer THB only.", "preference");
  });

  describe("buildChatSystemPrompt", () => {
    it("composes the expected sections in order", () => {
      const out = buildChatSystemPrompt(db);
      expect(out).toContain("Your name is Plasalid");
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

    it("shows memory category prefixes (chat sees all categories)", () => {
      const out = buildChatSystemPrompt(db);
      expect(out).toContain("[scanning_hint]");
      expect(out).toContain("[general]");
      expect(out).toContain("[preference]");
    });
  });

  describe("buildReviewSystemPrompt", () => {
    it("composes the expected sections in order", () => {
      const out = buildReviewSystemPrompt(db, { dryRun: false });
      expect(out).toContain("You are Plasalid's reviewer");
      expect(out).toContain("Today is ");
      expect(out).toContain("## Current chart of accounts");
      expect(out).toContain("## Scope");
      expect(out).toContain("Rules you've already learned");
    });

    it("contains no emoji", () => {
      const out = buildReviewSystemPrompt(db, { dryRun: false });
      expect(out).not.toMatch(EMOJI_RE);
    });

    it("renders dryRun flag in the scope section", () => {
      const out = buildReviewSystemPrompt(db, { dryRun: true });
      expect(out).toMatch(/dry run: yes/);
    });
  });

  describe("buildRecordSystemPrompt", () => {
    it("composes the expected sections in order and echoes the utterance", () => {
      const out = buildRecordSystemPrompt(db, { utterance: "spend 100 coffee" });
      expect(out).toContain("You are Plasalid's recorder");
      expect(out).toContain("## What the user said");
      expect(out).toContain("> spend 100 coffee");
    });

    it("filters memories to scanning_hint + general + preference, hiding category labels", () => {
      const out = buildRecordSystemPrompt(db, { utterance: "noop" });
      expect(out).toContain("Lazada Thailand is shopping.");
      expect(out).toContain("Wife is Corgi.");
      expect(out).toContain("Prefer THB only.");
      expect(out).not.toContain("[scanning_hint]");
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
      expect(out).toContain("You are Plasalid's scanner");
      expect(out).toContain("## File context");
      expect(out).toContain("stmt.pdf");
      expect(out).toContain("## Taxonomy hints");
    });

    it("filters memories to scanning_hint + general (no preference)", () => {
      const out = buildScanSystemPrompt(db, { fileName: "stmt.pdf" });
      expect(out).toContain("Lazada Thailand is shopping.");
      expect(out).toContain("Wife is Corgi.");
      expect(out).not.toContain("Prefer THB only.");
    });

    it("contains no emoji", () => {
      const out = buildScanSystemPrompt(db, { fileName: "stmt.pdf" });
      expect(out).not.toMatch(EMOJI_RE);
    });
  });
});
