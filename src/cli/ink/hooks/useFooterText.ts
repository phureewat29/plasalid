import { useEffect, useMemo, useState } from "react";
import chalk from "chalk";
import { getActiveModel } from "../../../config.js";

const HINTS = [
  "try: what's my net worth?",
  "try: how many months of runway do I have?",
  "try: which debt costs me the most?",
  "try: when am I credit card free?",
  "try: what's my savings rate?",
  "try: how far am I from retiring?",
  "try: any unused subscriptions?",
  "try: fixed vs variable spend?",
  "try: biggest category jump this week?",
  "try: what changed this month?",
  "try: gaining ground or losing it?",
  "try: which account drives my net worth?",
  "try: top 5 shopping this month?",
  "try: how much went to food this month?",
  "try: average daily burn rate?",
  "try: how much cash did I withdraw?",
  "try: how big should my emergency fund be?",
  "try: any duplicate charges?",
  "try: total spent this year?",
  "try: biggest one-off purchase this year?",
  "try: where can I cut expense easily?",
  "try: idle cash sitting anywhere?",
  "try: any account untouched in 6 months?",
  "try: checking vs savings split?",
  "try: transfers between my accounts?",
  "try: which account grew the most?",
  "try: total debt right now?",
  "try: how much went to interest last month?",
  "try: any debt growing instead of shrinking?",
  "try: avalanche or snowball — what's faster?",
  "try: am I paying more than the minimum?",
];

export function useFooterText(): string {
  const [tick, setTick] = useState(0);
  const [hintIdx] = useState(() => Math.floor(Math.random() * HINTS.length));
  const model = getActiveModel();

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => {
    const idx = (hintIdx + tick) % HINTS.length;
    const parts = [
      chalk.cyan("<°(((><"),
      chalk.dim(HINTS[idx]),
      chalk.dim(model),
      chalk.dim("ctrl+c to exit"),
    ];
    return parts.join(chalk.dim("  |  "));
  }, [tick, hintIdx, model]);
}
