import type { Command } from "commander";
import { existsSync } from "fs";
import { getContextPath, readContext } from "../../context.js";
import { currentMode, emit, runAction } from "../output.js";

export function registerContext(program: Command): void {
  const context = program.command("context").description("Inspect harness context");

  context
    .command("show")
    .description("Show the current context")
    .action(
      runAction(async () => {
        const path = getContextPath();
        const mode = currentMode();

        if (!existsSync(path)) {
          if (mode.json) {
            emit({ exists: false, path });
            return;
          }
          process.stdout.write(`No context file yet.\npath\t${path}\n`);
          return;
        }

        const content = readContext();
        if (mode.json) {
          emit({ exists: true, path, content });
          return;
        }
        process.stdout.write(content);
      }),
    );

  context
    .command("path")
    .description("Show the context file path")
    .action(
      runAction(async () => {
        const path = getContextPath();
        const mode = currentMode();
        if (mode.json) {
          emit({ path });
          return;
        }
        process.stdout.write(path + "\n");
      }),
    );
}
