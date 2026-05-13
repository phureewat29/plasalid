import chalk from "chalk";
import { config } from "../config.js";
import { banner } from "./format.js";
import { printLogo } from "./logo.js";

export async function startChat(): Promise<void> {
  const { getDb } = await import("../db/connection.js");
  const db = getDb();

  console.log("");
  printLogo();
  console.log("");
  console.log(banner());
  console.log("");

  const accountCount = db
    .prepare(`SELECT COUNT(*) AS n FROM accounts`)
    .get() as { n: number };
  if (accountCount.n === 0) {
    console.log(
      chalk.yellow(
        "No accounts scanned yet. Run `plasalid data` to open the data folder, drop PDFs in, then run `plasalid scan`.",
      ),
    );
    console.log("");
    console.log(
      chalk.dim(
        "You can still chat, but I won't have any data to answer questions about.",
      ),
    );
    console.log("");
  } else {
    console.log(
      chalk.dim(
        `Hi ${config.userName}. Ask me anything about your financial data.`,
      ),
    );
    console.log("");
  }

  const { runChatApp } = await import("./ink/mount.js");
  await runChatApp({ db });
}
