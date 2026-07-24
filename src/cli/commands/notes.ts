import type { Command } from "commander";
import type { Memory } from "../../db/queries/notes.js";
import { emitList, fail, requireYes, runAction, type Column } from "../output.js";
import { openDb } from "../db.js";
import * as z from "zod";
import { parseInput, str, num } from "../../lib/validate.js";

const VALID_CATEGORIES = ["general", "preference", "life_event"] as const;

const NOTE_COLUMNS: Column<Memory>[] = [
  { header: "ID", value: (r) => String(r.id), align: "right" },
  { header: "Category", value: (r) => r.category },
  { header: "Content", value: (r) => r.content },
  { header: "Created At", value: (r) => r.created_at },
];

async function listNotes(): Promise<void> {
  const { getMemories } = await import("../../db/queries/notes.js");
  const db = await openDb();
  emitList(getMemories(db), NOTE_COLUMNS);
}

const ADD_NOTE_SPEC = z.object({
  content: str(),
  category: z.enum(VALID_CATEGORIES).default("general"),
});

async function addNote(opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(ADD_NOTE_SPEC, opts);

  const { getMemories, saveMemory } = await import("../../db/queries/notes.js");
  const db = await openDb();
  saveMemory(db, parsed.content, parsed.category);
  const saved = getMemories(db)
    .filter((m) => m.content === parsed.content && m.category === parsed.category)
    .sort((a, b) => b.id - a.id)[0];
  emitList(saved ? [saved] : [], NOTE_COLUMNS);
}

/** Positional `<id>` args aren't commander opts; parsed through the same spec
 *  API with an ad hoc raw object so the coercion message stays consistent. */
const NOTE_ID_SPEC = z.object({ id: num() });
const NOTE_ID_LABELS = { id: "note id" };

async function removeNote(id: string, opts: { yes?: boolean }): Promise<void> {
  requireYes(opts, "removing this note");
  const parsed = parseInput(NOTE_ID_SPEC, { id }, { labels: NOTE_ID_LABELS });

  const { deleteMemory } = await import("../../db/queries/notes.js");
  const db = await openDb();
  const deleted = deleteMemory(db, parsed.id);
  if (!deleted) fail("NOT_FOUND", `note "${id}" not found`);
  emitList([deleted], NOTE_COLUMNS);
}

export function registerNotes(program: Command): void {
  const notes = program.command("notes").description("Manage notes");

  notes.command("list").description("List notes").action(runAction(listNotes));

  notes
    .command("add")
    .description("Add a note")
    .option("--content <text>", "note content")
    .option("--category <cat>", "note category")
    .action(runAction(addNote));

  notes
    .command("rm <id>")
    .description("Remove a note")
    .option("--yes", "skip confirmation")
    .action(runAction(removeNote));
}
