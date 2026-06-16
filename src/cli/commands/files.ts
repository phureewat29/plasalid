import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { listScannedFiles } from "../../db/queries/files.js";

/**
 * Open the scanned-files browser. The user-facing surface for dropping a
 * file's data: same `d`-confirm-`y/n` loop as the rules browser, but
 * typed for scanned_files rows so the layout shows path / status /
 * provider / model / scanned_at.
 */
export async function showFiles(): Promise<void> {
  const db = getDb();
  const files = listScannedFiles(db);
  if (files.length === 0) {
    console.log(
      "No scanned files yet.\n\n" +
        chalk.dim(
          "Drop PDFs into ~/.plasalid/data/ and run `plasalid scan`.",
        ),
    );
    return;
  }
  const [{ runBrowser }, { FilesBrowser }, { createElement }] = await Promise.all([
    import("../ink/runBrowser.js"),
    import("../ink/FilesBrowser.js"),
    import("react"),
  ]);
  await runBrowser(createElement(FilesBrowser, { files, db }));
}
