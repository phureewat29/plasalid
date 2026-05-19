import { describe, it, expect } from "vitest";
import { QUOTES, pickQuote } from "./quotes.js";

describe("QUOTES", () => {
  it("contains at least 40 entries", () => {
    expect(QUOTES.length).toBeGreaterThanOrEqual(40);
  });

  it("every entry has non-empty text and author", () => {
    for (const q of QUOTES) {
      expect(q.text.trim().length).toBeGreaterThan(0);
      expect(q.author.trim().length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate quote text", () => {
    const seen = new Set<string>();
    for (const q of QUOTES) {
      expect(seen.has(q.text), `duplicate: "${q.text}"`).toBe(false);
      seen.add(q.text);
    }
  });

  it("contains no emoji glyphs", () => {
    const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;
    for (const q of QUOTES) {
      expect(q.text).not.toMatch(emojiRe);
      expect(q.author).not.toMatch(emojiRe);
    }
  });
});

describe("pickQuote", () => {
  it("returns an entry from QUOTES", () => {
    for (let i = 0; i < 30; i++) {
      expect(QUOTES).toContain(pickQuote());
    }
  });
});
