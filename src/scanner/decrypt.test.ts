import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

const tmp = mkdtempSync(resolve(tmpdir(), "plasalid-walker-"));

vi.mock("../config.js", () => ({
  getDataDir: () => tmp,
}));

import { scanDataDir } from "./decrypt.js";

describe("scanDataDir", () => {
  beforeEach(() => {
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
  });

  it("walks PDFs recursively and emits forward-slashed relative paths", () => {
    mkdirSync(resolve(tmp, "a", "b"), { recursive: true });
    writeFileSync(resolve(tmp, "a", "b", "x.pdf"), "");
    const files = scanDataDir();
    expect(files[0].relPath).toBe("a/b/x.pdf");
  });
});
