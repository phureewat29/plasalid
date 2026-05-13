import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { dirname, resolve } from "path";
import { getPlasalidDir } from "../config.js";

export function getContextPath(): string {
  return resolve(getPlasalidDir(), "context.md");
}

export function readContext(): string {
  const p = getContextPath();
  if (!existsSync(p)) return "";
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

export function writeContext(content: string): void {
  const p = getContextPath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, content, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
}

export function createContextTemplate(userName: string): void {
  if (existsSync(getContextPath())) return;
  writeContext(
    `# Plasalid context for ${userName}\n\n## Family\n- ${userName}\n\n## Income\n- (Optional: add your primary income source so Plasalid can mark it as PII when sending data to the model.)\n\n## Notes\n- (Free-form notes about your accounts, bank preferences, or anything Plasalid should keep in mind when scanning.)\n`,
  );
}
