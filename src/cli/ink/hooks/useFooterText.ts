import { useEffect, useMemo, useState } from "react";
import chalk from "chalk";
import type Database from "libsql";

const HINTS = [
  "try: what's my net worth?",
  "try: am I spending more than I earn?",
  "try: how much did I save last month?",
  "try: where did my money go last month?",
  "try: biggest expense this month?",
  "try: top spending categories this month?",
  "try: total credit card debt?",
  "try: next bill due?",
  "try: list my subscriptions",
  "try: how much liquid cash do I have?",
  "try: net worth trend this year?",
  "try: open concerns from last scan?",
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
    const parts = [`${chalk.cyan("<°(((><")}`];
    if (scanStr) parts.push(scanStr);
    parts.push(HINTS[idx]);
    parts.push("ctrl+c to exit");
    return parts.join("  |  ");
  }, [db, tick, hintIdx]);
}
