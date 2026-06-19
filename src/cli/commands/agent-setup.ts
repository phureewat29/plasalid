import type { Command } from "commander";
import { currentMode, emit, fail, runAction } from "../output.js";
import {
  installSkillPack,
  getVersion,
  SkillPackVersionError,
  type InstallOptions,
} from "../../agent-setup/install.js";
import { SKILL_MD } from "../../agent-setup/templates.js";

interface AgentSetupOptions {
  claude?: boolean;
  codex?: boolean;
  global?: boolean;
  dir?: string;
  force?: boolean;
  print?: boolean;
}

export function registerAgentSetup(program: Command): void {
  program
    .command("agent-setup")
    .description("Install the skill pack so external agent CLIs can drive the harness")
    .option("--claude", "install the Claude Code skill (default when no target is given)")
    .option("--codex", "install/patch the codex AGENTS.md block")
    .option("--global", "install to the home dir (~/.claude) instead of the cwd (./.claude)")
    .option("--dir <path>", "override the install base directory")
    .option("--force", "overwrite an installed skill dir whose version differs")
    .option("--print", "print SKILL.md to stdout as raw markdown and exit (ignores --json)")
    .action(
      runAction(async (opts: AgentSetupOptions) => {
        // --print dumps the raw SKILL.md so a human/agent can inspect it without
        // touching the filesystem. It is markdown, not NDJSON, even under --json.
        if (opts.print) {
          process.stdout.write(SKILL_MD(getVersion()));
          if (!SKILL_MD(getVersion()).endsWith("\n")) process.stdout.write("\n");
          return;
        }

        const installOpts: InstallOptions = {
          claude: opts.claude,
          codex: opts.codex,
          global: opts.global,
          dir: opts.dir,
          force: opts.force,
        };

        let result;
        try {
          result = installSkillPack(installOpts);
        } catch (err) {
          if (err instanceof SkillPackVersionError) {
            fail("INVALID", err.message, {
              hint: "re-run with --force to overwrite the installed skill pack",
              details: {
                installed_version: err.installedVersion,
                cli_version: err.cliVersion,
                path: err.path,
              },
            });
          }
          throw err;
        }

        const mode = currentMode();
        if (mode.json) {
          emit({ installed: result.installed });
        } else {
          for (const t of result.installed) {
            process.stdout.write(`${t.kind}\t${t.path}\t${t.version}\n`);
          }
        }
      }),
    );
}
