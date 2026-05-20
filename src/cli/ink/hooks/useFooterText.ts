import { useEffect, useMemo, useState } from "react";
import chalk from "chalk";
import type Database from "libsql";

const HINTS = [
  "try: what's my net worth, and where is most of it sitting?",
  "try: how many months could I live off my savings if income stopped today?",
  "try: am I saving more this year than last?",
  "try: which debt costs me the most each month in interest?",
  "try: at my current pace, when am I credit-card-free?",
  "try: what's my savings rate this year?",
  "try: at this savings rate, how far am I from retiring?",
  "try: any subscriptions I probably haven't used in months?",
  "try: how much of my spend is fixed vs variable?",
  "try: which category jumped the most this quarter?",
  "try: this month vs last month — what changed?",
  "try: am I building wealth faster than I'm burning it?",
  "try: if I throw an extra ฿5k a month at my highest-rate debt, when am I done?",
  "try: which account is doing the heavy lifting on my net worth growth?",
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
