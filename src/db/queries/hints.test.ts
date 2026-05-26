import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import { listHints, replaceHints, seedDefaultHintsIfEmpty } from "./hints.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

describe("hints queries", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("replaceHints fully swaps the table contents in one transaction", () => {
    replaceHints(db, ["try: a", "try: b", "try: c"]);
    expect(listHints(db)).toEqual(["try: a", "try: b", "try: c"]);

    replaceHints(db, ["try: x", "try: y"]);
    expect(listHints(db)).toEqual(["try: x", "try: y"]);
  });

  it("seedDefaultHintsIfEmpty only inserts on an empty table", () => {
    seedDefaultHintsIfEmpty(db, ["try: default-1", "try: default-2"]);
    expect(listHints(db)).toEqual(["try: default-1", "try: default-2"]);

    seedDefaultHintsIfEmpty(db, ["try: should-not-appear"]);
    expect(listHints(db)).toEqual(["try: default-1", "try: default-2"]);
  });
});
