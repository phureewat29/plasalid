import type { Command } from "commander";
import type { Memory } from "../../db/queries/notes.js";
import { emitList, fail, requireYes, runAction, type Column } from "../output.js";

const VALID_CATEGORIES = ["general", "preference", "life_event"];

const NOTE_COLUMNS: Column<Memory>[] = [
  { header: "id", value: (r) => String(r.id), align: "right" },
  { header: "category", value: (r) => r.category },
  { header: "content", value: (r) => r.content },
  { header: "created_at", value: (r) => r.created_at },
];

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
      runAction(async (opts: any) => {
        if (!opts.content) fail("USAGE", "--content is required");
        const category = opts.category ?? "general";
        if (!VALID_CATEGORIES.includes(category)) {
          fail("USAGE", `--category must be one of ${VALID_CATEGORIES.join(", ")}, got "${category}"`);
        }

        const { getDb } = await import("../../db/connection.js");
        const { getMemories, saveMemory } = await import("../../db/queries/notes.js");
        const db = getDb();
        saveMemory(db, opts.content, category);
        const saved = getMemories(db)
          .filter((m) => m.content === opts.content && m.category === category)
          .sort((a, b) => b.id - a.id)[0];
        emitList(saved ? [saved] : [], NOTE_COLUMNS);
      }),
    );

  notes
    .command("rm <id>")
    .description("Remove a note")
    .option("--yes", "skip confirmation")
    .action(
      runAction(async (id: string, opts: any) => {
        requireYes(opts, "removing this note");
        const noteId = Number(id);
        if (!Number.isFinite(noteId)) fail("USAGE", `note id must be a number, got "${id}"`);

        const { getDb } = await import("../../db/connection.js");
        const { deleteMemory } = await import("../../db/queries/notes.js");
        const db = getDb();
        const deleted = deleteMemory(db, noteId);
        if (!deleted) fail("NOT_FOUND", `note "${id}" not found`);
        emitList([deleted], NOTE_COLUMNS);
      }),
    );
}
