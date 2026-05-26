import { useEffect, useState } from "react";
import { getDb } from "../../../db/connection.js";
import { listHints, seedDefaultHintsIfEmpty } from "../../../db/queries/hints.js";
import { DEFAULT_HINTS } from "../../../ai/hints.js";

const TRY_PREFIX = /^try:\s*/i;

function loadHints(): string[] {
  const db = getDb();
  seedDefaultHintsIfEmpty(db, DEFAULT_HINTS);
  const rows = listHints(db);
  const source = rows.length > 0 ? rows : DEFAULT_HINTS;
  return source.map((raw) => raw.replace(TRY_PREFIX, "").toLowerCase());
}

export function useHint(): string {
  const [hints] = useState<string[]>(loadHints);
  const [tick, setTick] = useState(0);
  const [start] = useState(() => Math.floor(Math.random() * Math.max(hints.length, 1)));

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  if (hints.length === 0) return "";
  return hints[(start + tick) % hints.length];
}
