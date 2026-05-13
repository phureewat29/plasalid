import type Database from "libsql";
import { sanitizeForPrompt } from "../sanitize.js";
import type { AgentExecutionContext, ToolDefinition, ToolModule } from "./types.js";

const DEFS: ToolDefinition[] = [
  {
    name: "mark_file_scanned",
    description: "Call this once the file is fully processed and all journal entries are posted. Summary text is shown to the user.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Short summary of what was recorded." },
      },
      required: ["summary"],
    },
  },
];

const LABELS: Record<string, string> = {
  mark_file_scanned: "Finalizing file",
};

async function execute(
  _db: Database.Database,
  name: string,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  if (name !== "mark_file_scanned") return undefined;
  ctx?.onComplete?.(input.summary || "");
  return `Marked file as scanned. Summary: ${sanitizeForPrompt(input.summary || "")}`;
}

export const scanTools: ToolModule = { DEFS, LABELS, execute };
