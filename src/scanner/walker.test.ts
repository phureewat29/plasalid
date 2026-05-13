import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

const tmp = mkdtempSync(resolve(tmpdir(), "plasalid-walker-"));

vi.mock("../config.js", () => ({
  getDataDir: () => tmp,
}));

import { scanDataDir } from "./walker.js";

describe("walker", () => {
  beforeEach(() => {
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
  });

  it("walks PDFs anywhere under the data dir", () => {
    writeFileSync(resolve(tmp, "kbank.pdf"), "");
    mkdirSync(resolve(tmp, "2026", "01"), { recursive: true });
    writeFileSync(resolve(tmp, "2026", "01", "ktc.pdf"), "");
    const files = scanDataDir();
    const rels = files.map(f => f.relPath).sort();
    expect(rels).toEqual(["2026/01/ktc.pdf", "kbank.pdf"]);
  });

  it("ignores non-PDF extensions and dotfiles", () => {
    writeFileSync(resolve(tmp, "ignored.csv"), "");
    writeFileSync(resolve(tmp, ".hidden.pdf"), "");
    writeFileSync(resolve(tmp, "kbank.pdf"), "");
    const files = scanDataDir();
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("kbank.pdf");
  });

  it("returns forward-slashed relative paths", () => {
    mkdirSync(resolve(tmp, "a", "b"), { recursive: true });
    writeFileSync(resolve(tmp, "a", "b", "x.pdf"), "");
    const files = scanDataDir();
    expect(files[0].relPath).toBe("a/b/x.pdf");
  });
});
