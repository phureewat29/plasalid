import { useEffect, useMemo, useState } from "react";
import type Database from "libsql";

const HINTS = [
  "try: what is my net worth?",
  "try: how much did I spend on food this month?",
  "try: when is my credit card due?",
  "try: show me transactions over 5000 baht",
  "try: which credit card has the highest balance?",
  "try: how much income did I receive last month?",
  "try: list all accounts",
];

export function useFooterText(db: Database.Database): string {
  const [tick, setTick] = useState(0);
  const [hintIdx] = useState(() => Math.floor(Math.random() * HINTS.length));

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => {
    const lastScan = db
      .prepare(
        `SELECT MAX(scanned_at) AS ts FROM scanned_files WHERE status = 'scanned'`,
      )
      .get() as { ts: string | null };

    let scanStr = "";
    if (lastScan?.ts) {
      const diffMs = Date.now() - new Date(lastScan.ts + "Z").getTime();
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) scanStr = "scanned just now";
      else if (mins < 60) scanStr = `scanned ${mins}m ago`;
      else if (mins < 1440) scanStr = `scanned ${Math.floor(mins / 60)}h ago`;
      else scanStr = `scanned ${Math.floor(mins / 1440)}d ago`;
    }

    const idx = (hintIdx + tick) % HINTS.length;
    const parts = ["Plasalid"];
    if (scanStr) parts.push(scanStr);
    parts.push(HINTS[idx]);
    parts.push("ctrl+c to exit");
    return parts.join("  |  ");
  }, [db, tick, hintIdx]);
}
