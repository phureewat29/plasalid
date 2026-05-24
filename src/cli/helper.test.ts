import { describe, it, expect } from "vitest";
import { displayWidth, padRight, truncateMiddle } from "./helper.js";

describe("displayWidth", () => {
  it("counts ASCII at 1 cell per code point", () => {
    expect(displayWidth("hello")).toBe(5);
    expect(displayWidth("")).toBe(0);
  });

  it("ignores Thai combining marks (\\p{M})", () => {
    // บริษัท = ບ(C) ຣ(C) ິ(M) ษ(C) ັ(M) ທ(C) → 4 base chars
    expect(displayWidth("บริษัท")).toBe(4);
    // คริปโตมายด์ = ค(C) ร(C) ิ(M) ป(C) โ(V, narrow) ต(C) ม(C) า(V, narrow) ย(C) ด(C) ์(M) → 9 visible cells
    expect(displayWidth("คริปโตมายด์")).toBe(9);
  });

  it("handles mixed strings", () => {
    expect(displayWidth("scb-บริษัท-202602.pdf")).toBe(
      "scb--202602.pdf".length + 4, // "scb-" + 4 Thai consonants (mark ignored) + "-202602.pdf"
    );
  });
});

describe("padRight", () => {
  it("pads ASCII to length", () => {
    expect(padRight("hi", 5)).toBe("hi   ");
  });

  it("does not pad strings already at or beyond width", () => {
    expect(padRight("hello", 5)).toBe("hello");
    expect(padRight("hello world", 5)).toBe("hello world");
  });

  it("pads by display width so Thai aligns with surrounding columns", () => {
    const out = padRight("บริษัท", 10); // 4 visible cells → 6 spaces
    expect(displayWidth(out)).toBe(10);
    expect(out.endsWith("      ")).toBe(true);
  });
});

describe("truncateMiddle", () => {
  it("returns the string unchanged when short enough", () => {
    expect(truncateMiddle("hello", 10)).toBe("hello");
  });

  it("middle-truncates with an ellipsis when too long", () => {
    expect(truncateMiddle("abcdefghij", 7)).toBe("abc…hij");
  });
});
