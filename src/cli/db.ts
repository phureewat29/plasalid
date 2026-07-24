import type Database from "libsql";

/**
 * Open (and memoize) the singleton libsql handle. The dynamic import keeps
 * libsql's native binding off the startup path of commands that never touch
 * the database (see status.ts).
 */
export async function openDb(): Promise<Database.Database> {
  const { getDb } = await import("../db/connection.js");
  return getDb();
}
