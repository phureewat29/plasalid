import { useMemo, useState } from "react";
import type Database from "libsql";
import { Text } from "ink";
import chalk from "chalk";
import { padRight, truncateMiddle } from "../helper.js";
import { ListBrowser, type ListBrowserAdapter } from "./ListBrowser.js";
import { keyOf } from "./keys.js";
import { getDataDir } from "../../config.js";
import {
  deleteScannedFile,
  type ScannedFileRow,
} from "../../db/queries/files.js";
import { countTransactionsBySourceFile } from "../../db/queries/transactions.js";
import { countQuestions } from "../../db/queries/questions.js";

export interface FilesBrowserProps {
  files: ScannedFileRow[];
  db: Database.Database;
}

const COL = {
  status: 9,
  provenance: 28,
  scannedAt: 20,
} as const;

const MIN_PATH_WIDTH = 16;
const MAX_PATH_WIDTH = 50;

const STATUS_COLOR: Record<ScannedFileRow["status"], (s: string) => string> = {
  scanned: chalk.green,
  failed: chalk.red,
  pending: chalk.gray,
};

interface ConfirmState {
  fileId: string;
  path: string;
  cascadeTx: number;
  cascadeQuestions: number;
}

export function FilesBrowser({ files: initialFiles, db }: FilesBrowserProps) {
  const [files, setFiles] = useState<ScannedFileRow[]>(initialFiles);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const adapter = useMemo<ListBrowserAdapter<ScannedFileRow>>(() => {
    const commitDelete = (): void => {
      if (!confirm) return;
      deleteScannedFile(db, confirm.fileId);
      setFiles(prev => prev.filter(f => f.id !== confirm.fileId));
      setConfirm(null);
    };
    const cancelConfirm = (): void => setConfirm(null);

    const CONFIRM_KEYS: Record<string, () => void> = {
      y:      commitDelete,
      n:      cancelConfirm,
      escape: cancelConfirm,
    };
    const BROWSE_KEYS: Record<string, (cursorItem: ScannedFileRow | null) => boolean> = {
      d: (cursorItem) => {
        if (!cursorItem) return false;
        setConfirm({
          fileId: cursorItem.id,
          path: cursorItem.path,
          cascadeTx: countTransactionsBySourceFile(db, cursorItem.id),
          // includeDeferred: true so the count matches what ON DELETE CASCADE will actually drop.
          cascadeQuestions: countQuestions(db, { file_id: cursorItem.id, includeDeferred: true }),
        });
        return true;
      },
    };

    return {
      title: "Scanned files",
      items: files,
      getId: f => f.id,
      renderRow: (f, ctx) => renderFileRow(f, ctx.isCursor, ctx.cols),
      matches: (f, needle) =>
        f.path.toLowerCase().includes(needle) ||
        (f.provider ?? "").toLowerCase().includes(needle) ||
        (f.model ?? "").toLowerCase().includes(needle),
      emptyMessage: "No scanned files match the current filter.",
      summary: confirm ? (
        <Text color="yellow">
          {`Delete ${truncateMiddle(confirm.path, 60)}? (y/n)  Cascade removes ${confirm.cascadeTx} transaction(s) and ${confirm.cascadeQuestions} question(s).`}
        </Text>
      ) : undefined,
      onKey: (input, key, { cursorItem }) => {
        const k = keyOf(input, key).toLowerCase();
        if (confirm !== null) {
          CONFIRM_KEYS[k]?.();
          return true;
        }
        return BROWSE_KEYS[k]?.(cursorItem) ?? false;
      },
    };
  }, [files, confirm, db]);

  return <ListBrowser adapter={adapter} />;
}

function renderFileRow(f: ScannedFileRow, isCursor: boolean, cols: number): string {
  const marker = isCursor ? "▸" : " ";
  const status = STATUS_COLOR[f.status](padRight(f.status, COL.status));

  const provenanceRaw = f.provider && f.model ? `${f.provider}/${f.model}` : f.status === "failed" ? "(failed)" : "(not stamped)";
  const provenance = chalk.dim(padRight(truncateMiddle(provenanceRaw, COL.provenance), COL.provenance));

  const scannedAtRaw = f.scanned_at ?? "—";
  const scannedAt = chalk.dim(padRight(scannedAtRaw, COL.scannedAt));

  // Layout: "M status(9)  path(flex)  provenance(28)  scannedAt(20)"
  const fixedWidth = 1 + 1 + COL.status + 2 + 2 + COL.provenance + 2 + COL.scannedAt;
  const pathBudget = Math.max(
    MIN_PATH_WIDTH,
    Math.min(MAX_PATH_WIDTH, cols - fixedWidth - 2),
  );
  const pathRaw = truncateMiddle(relativeFromDataDir(f.path), pathBudget);
  const pathPadded = padRight(pathRaw, pathBudget);
  const path = isCursor ? chalk.cyan.bold(pathPadded) : pathPadded;

  return `${marker} ${status}  ${path}  ${provenance}  ${scannedAt}`;
}

/** Strip the configured data-dir prefix so the path column shows just the
 *  meaningful tail (subdirs + filename). Falls back to the absolute path
 *  for files that somehow live outside the data dir. */
function relativeFromDataDir(absolutePath: string): string {
  const dataDir = getDataDir().replace(/\/+$/, "");
  if (absolutePath === dataDir) return absolutePath;
  const prefix = dataDir + "/";
  return absolutePath.startsWith(prefix)
    ? absolutePath.slice(prefix.length)
    : absolutePath;
}

