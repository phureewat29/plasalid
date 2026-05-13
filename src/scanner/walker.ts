import { readdirSync, statSync } from "fs";
import { resolve, basename, relative, sep } from "path";
import { getDataDir } from "../config.js";

export interface ScannedFile {
  path: string;
  name: string;
  /** Path relative to the data dir, forward-slashed. */
  relPath: string;
}

const SUPPORTED_EXTS = new Set([".pdf"]);

function walk(dir: string, root: string, out: ScannedFile[]): void {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = resolve(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full, root, out);
    } else if (s.isFile()) {
      const ext = entry.slice(entry.lastIndexOf(".")).toLowerCase();
      if (!SUPPORTED_EXTS.has(ext)) continue;
      const rel = relative(root, full).split(sep).join("/");
      out.push({ path: full, name: basename(full), relPath: rel });
    }
  }
}

/** Walk the data directory recursively and return every supported file found. */
export function scanDataDir(): ScannedFile[] {
  const out: ScannedFile[] = [];
  const root = getDataDir();
  walk(root, root, out);
  return out;
}
