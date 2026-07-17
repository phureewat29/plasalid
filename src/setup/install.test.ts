import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installSkillPack,
  getVersion,
  SkillPackVersionError,
} from "./install.js";
import { SKILL_MD, SCHEMAS_MD, renderTaxonomyMd, AGENTS_MD_BLOCK } from "./templates/index.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Minimal frontmatter parser (no yaml dep): key: value pairs between the fences. */
function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  expect(m, "SKILL.md should start with a --- frontmatter block").toBeTruthy();
  const out: Record<string, string> = {};
  for (const line of m![1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

describe("templates", () => {
  it("SKILL_MD carries name/description/version frontmatter", () => {
    const fm = parseFrontmatter(SKILL_MD("1.2.3"));
    expect(fm.name).toBe("plasalid");
    expect(fm.description.length).toBeGreaterThan(20);
    expect(fm.version).toBe("1.2.3");
  });

  it("SKILL_MD teaches the transaction model: direction table, row_index, and linked splits", () => {
    const skill = SKILL_MD("1.2.3");
    // The direction table header (Debit account / Credit account columns).
    expect(skill).toContain("Debit account");
    expect(skill).toContain("Credit account");
    // Idempotency contract + compound form.
    expect(skill).toContain("row_index");
    expect(skill).toContain("linked");
  });

  it("SKILL_MD carries the 'When you are blocked' playbook and current command names", () => {
    const skill = SKILL_MD("1.2.3");
    // The blocked-environment playbook, keyed off the transcript failures.
    expect(skill).toContain("When you are blocked");
    // The salient PDF-rasterizer fallback (F3/F6) must name --dpi.
    expect(skill).toContain("--dpi");
    // Manual entry uses the `transactions` noun...
    expect(skill).toContain("transactions add");
    // ...and there is no legacy `record` command reference left behind.
    expect(skill).not.toContain("record ");
  });

  it("SKILL_MD carries the Setup bootstrap section (install + first-run for a bare environment)", () => {
    const skill = SKILL_MD("1.2.3");
    expect(skill).toContain("## Setup");
    expect(skill).toContain("node --version");
    expect(skill).toContain("npm install -g plasalid");
  });

  it("SCHEMAS_MD documents the currency_mismatch drop and idempotent duplicate result", () => {
    expect(SCHEMAS_MD).toContain("currency_mismatch");
    expect(SCHEMAS_MD).toContain("duplicate");
  });

  it("renderTaxonomyMd reflects the live registry (a known institution + a root)", () => {
    const md = renderTaxonomyMd();
    expect(md).toContain("Kasikornbank");
    expect(md).toContain("KBANK");
    expect(md).toContain("asset"); // an account root
  });

  it("AGENTS_MD_BLOCK is wrapped in versioned begin/end markers", () => {
    const block = AGENTS_MD_BLOCK("9.9.9");
    expect(block).toContain("<!-- BEGIN plasalid-skill v9.9.9 -->");
    expect(block.trimEnd().endsWith("<!-- END plasalid-skill -->")).toBe(true);
  });
});

describe("installSkillPack — claude", () => {
  it("writes SKILL.md, references, and VERSION; result points at the skill dir", () => {
    const dir = tmp("plasalid-install-claude-");
    try {
      const result = installSkillPack({ claude: true, dir });
      const skillDir = join(dir, "skills", "plasalid");

      expect(result.installed).toHaveLength(1);
      expect(result.installed[0]).toMatchObject({ kind: "claude", path: skillDir, version: getVersion() });

      for (const rel of [
        "SKILL.md",
        "VERSION",
        "references/commands.md",
        "references/schemas.md",
        "references/taxonomy.md",
      ]) {
        expect(existsSync(join(skillDir, rel)), `${rel} should exist`).toBe(true);
      }

      expect(readFileSync(join(skillDir, "VERSION"), "utf8").trim()).toBe(getVersion());
      const fm = parseFrontmatter(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
      expect(fm.name).toBe("plasalid");
      expect(fm.version).toBe(getVersion());
      expect(readFileSync(join(skillDir, "references/taxonomy.md"), "utf8")).toContain("Kasikornbank");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to claude when neither target flag is given", () => {
    const dir = tmp("plasalid-install-default-");
    try {
      const result = installSkillPack({ dir });
      expect(result.installed.map((t) => t.kind)).toEqual(["claude"]);
      expect(existsSync(join(dir, "skills", "plasalid", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent when re-installed at the same version", () => {
    const dir = tmp("plasalid-install-idem-");
    try {
      installSkillPack({ claude: true, dir });
      // Second install must not throw and must leave VERSION intact.
      expect(() => installSkillPack({ claude: true, dir })).not.toThrow();
      expect(readFileSync(join(dir, "skills", "plasalid", "VERSION"), "utf8").trim()).toBe(getVersion());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws SkillPackVersionError on a version clash without --force, succeeds with it", () => {
    const dir = tmp("plasalid-install-clash-");
    try {
      installSkillPack({ claude: true, dir });
      const versionPath = join(dir, "skills", "plasalid", "VERSION");
      writeFileSync(versionPath, "0.0.1\n"); // simulate an older install

      let err: unknown;
      try {
        installSkillPack({ claude: true, dir });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SkillPackVersionError);
      expect((err as SkillPackVersionError).installedVersion).toBe("0.0.1");
      expect((err as SkillPackVersionError).cliVersion).toBe(getVersion());

      // --force overwrites and re-stamps VERSION.
      expect(() => installSkillPack({ claude: true, dir, force: true })).not.toThrow();
      expect(readFileSync(versionPath, "utf8").trim()).toBe(getVersion());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installSkillPack — codex", () => {
  it("creates AGENTS.md with a single block when none exists", () => {
    const dir = tmp("plasalid-codex-create-");
    try {
      const result = installSkillPack({ codex: true, dir });
      const agentsPath = join(dir, "AGENTS.md");
      expect(result.installed).toMatchObject([{ kind: "codex", path: agentsPath }]);

      const content = readFileSync(agentsPath, "utf8");
      expect((content.match(/BEGIN plasalid-skill/g) ?? []).length).toBe(1);
      expect(content).toContain("END plasalid-skill");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends to an existing AGENTS.md without clobbering prior content", () => {
    const dir = tmp("plasalid-codex-append-");
    try {
      const agentsPath = join(dir, "AGENTS.md");
      writeFileSync(agentsPath, "# My project\n\nExisting guidance.\n");
      installSkillPack({ codex: true, dir });

      const content = readFileSync(agentsPath, "utf8");
      expect(content).toContain("Existing guidance.");
      expect((content.match(/BEGIN plasalid-skill/g) ?? []).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces the block in place on re-install (no duplicate blocks)", () => {
    const dir = tmp("plasalid-codex-replace-");
    try {
      installSkillPack({ codex: true, dir });
      installSkillPack({ codex: true, dir });
      const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
      expect((content.match(/BEGIN plasalid-skill/g) ?? []).length).toBe(1);
      expect((content.match(/END plasalid-skill/g) ?? []).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// CLI integration (subprocess)

// install.test.ts lives in src/setup/ -> repo root is two levels up.
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      "npx",
      ["tsx", "src/cli/index.ts", ...args],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
    child.stdin?.end();
  });
}

describe("setup CLI (subprocess)", () => {
  it(
    "--print emits raw SKILL.md with parseable frontmatter",
    async () => {
      const res = await runCli(["setup", "--print"]);
      expect(res.code).toBe(0);
      expect(res.stdout.startsWith("---\n")).toBe(true);
      const fm = parseFrontmatter(res.stdout);
      expect(fm.name).toBe("plasalid");
      expect(fm.version.length).toBeGreaterThan(0);
    },
    30000,
  );

  it(
    "--dir installs the pack and reports it as JSON",
    async () => {
      const dir = tmp("plasalid-cli-install-");
      try {
        const res = await runCli(["setup", "--dir", dir, "--json"]);
        expect(res.code).toBe(0);
        const parsed = JSON.parse(res.stdout.trim());
        expect(parsed.installed[0]).toMatchObject({ kind: "claude", path: join(dir, "skills", "plasalid") });
        expect(existsSync(join(dir, "skills", "plasalid", "SKILL.md"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30000,
  );
});
