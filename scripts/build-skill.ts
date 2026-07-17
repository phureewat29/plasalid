import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { installSkillPack, getVersion } from "../src/setup/install.js";

/** Abort the build with a one-line reason. */
function fail(reason: string): never {
  console.error(`build-skill: ${reason}`);
  process.exit(1);
}

/** Run a shell command, streaming its output; a non-zero exit aborts the build. */
function run(command: string, cwd?: string): void {
  execSync(command, { stdio: "inherit", cwd });
}

const outDir = resolve("dist-skill");
const version = getVersion();

rmSync(outDir, { recursive: true, force: true });

const result = installSkillPack({ claude: true, dir: outDir, force: true });
const skillDir = result.installed[0]?.path;
if (!skillDir) fail("installSkillPack did not report a claude target");

const zipName = `plasalid-skill-${version}.zip`;
const zipPath = resolve(outDir, zipName);
rmSync(zipPath, { force: true });

// Zip from inside the skill dir (cwd) so SKILL.md sits at the archive root.
run(`zip -r "../../${zipName}" .`, skillDir);

console.log(`build-skill: artifact ${zipPath}`);
console.log(`build-skill: version ${version}`);
console.log("Upload this zip as a custom skill (claude.ai / Claude Desktop capabilities).");
