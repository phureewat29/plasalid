import type { Command } from "commander";
import type { Memory } from "../../db/queries/notes.js";
import { emitList, fail, requireYes, runAction, type Column } from "../output.js";
import * as z from "zod";
import { parseInput, str, num } from "../../lib/validate.js";

const VALID_CATEGORIES = ["general", "preference", "life_event"] as const;

const NOTE_COLUMNS: Column<Memory>[] = [
  { header: "id", value: (r) => String(r.id), align: "right" },
  { header: "category", value: (r) => r.category },
  { header: "content", value: (r) => r.content },
  { header: "created_at", value: (r) => r.created_at },
];

const ADD_NOTE_SPEC = z.object({
  content: str(),
  category: z.enum(VALID_CATEGORIES).default("general"),
});

/** Positional `<id>` args aren't commander opts; parsed through the same spec
 *  API with an ad hoc raw object so the coercion message stays consistent. */
const NOTE_ID_SPEC = z.object({ id: num() });
const NOTE_ID_LABELS = { id: "note id" };

export function registerNotes(program: Command): void {
  const notes = program.command("notes").description("Manage notes");

  notes
    .command("list")
    .description("List notes")
    .action(
      runAction(async () => {
        const { getDb } = await import("../../db/connection.js");
        const { getMemories } = await import("../../db/queries/notes.js");
        const db = getDb();
        emitList(getMemories(db), NOTE_COLUMNS);
      }),
    );

  notes
    .command("add")
    .description("Add a note")
    .option("--content <text>", "note content")
    .option("--category <cat>", "note category")
    .action(
      runAction(async (opts: Record<string, unknown>) => {
        const parsed = parseInput(ADD_NOTE_SPEC, opts);

        const { getDb } = await import("../../db/connection.js");
        const { getMemories, saveMemory } = await import("../../db/queries/notes.js");
        const db = getDb();
        saveMemory(db, parsed.content, parsed.category);
        const saved = getMemories(db)
          .filter((m) => m.content === parsed.content && m.category === parsed.category)
          .sort((a, b) => b.id - a.id)[0];
        emitList(saved ? [saved] : [], NOTE_COLUMNS);
      }),
    );

  notes
    .command("rm <id>")
    .description("Remove a note")
    .option("--yes", "skip confirmation")
    .action(
      runAction(async (id: string, opts: { yes?: boolean }) => {
        requireYes(opts, "removing this note");
        const parsed = parseInput(NOTE_ID_SPEC, { id }, { labels: NOTE_ID_LABELS });

        const { getDb } = await import("../../db/connection.js");
        const { deleteMemory } = await import("../../db/queries/notes.js");
        const db = getDb();
        const deleted = deleteMemory(db, parsed.id);
        if (!deleted) fail("NOT_FOUND", `note "${id}" not found`);
        emitList([deleted], NOTE_COLUMNS);
      }),
    );
}
