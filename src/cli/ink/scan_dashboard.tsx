import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

/**
 * Chunk-aware events the CLI publishes into the dashboard. The engine fires
 * onWorkerStart/End per chunk; we aggregate into ONE row per file. Real-time
 * tx and unknown counters tick as the scanner's shared buffer grows.
 */
export type DashboardEvent =
  | { type: "chunk-start"; fileId: string; fileName: string; pageNumber: number; totalPages: number }
  | { type: "chunk-end"; fileId: string; ok: boolean }
  | { type: "tx-appended"; fileId: string }
  | { type: "unknown-appended"; fileId: string };

export class ScanDashboardController {
  private subscribers: Array<(e: DashboardEvent) => void> = [];

  publish(event: DashboardEvent): void {
    for (const sub of this.subscribers) sub(event);
  }

  subscribe(handler: (e: DashboardEvent) => void): () => void {
    this.subscribers.push(handler);
    return () => {
      this.subscribers = this.subscribers.filter(s => s !== handler);
    };
  }
}

interface FileRowState {
  fileName: string;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  txAdded: number;
  unknownsAdded: number;
}

function statusOf(row: FileRowState): "scanning" | "done" | "partial" | "failed" {
  const finished = row.completedChunks + row.failedChunks;
  if (finished < row.totalChunks) return "scanning";
  if (row.failedChunks === 0) return "done";
  if (row.failedChunks === row.totalChunks) return "failed";
  return "partial";
}

interface Props {
  controller: ScanDashboardController;
  totalFiles: number;
  parallel: number;
}

/**
 * Live scan dashboard. ONE row per file, in-place updates as its chunks flow.
 * Replaces per-chunk console.log noise so the user sees aggregate progress
 * instead of N × 2 status lines.
 */
export function ScanDashboard({ controller, totalFiles, parallel }: Props) {
  const [rows, setRows] = useState<Map<string, FileRowState>>(() => new Map());

  useEffect(() => {
    return controller.subscribe(event => {
      setRows(prev => {
        const next = new Map(prev);
        const existing = next.get(event.fileId);

        switch (event.type) {
          case "chunk-start": {
            if (!existing) {
              next.set(event.fileId, {
                fileName: event.fileName,
                totalChunks: event.totalPages,
                completedChunks: 0,
                failedChunks: 0,
                txAdded: 0,
                unknownsAdded: 0,
              });
            }
            break;
          }
          case "chunk-end": {
            if (!existing) break;
            next.set(event.fileId, {
              ...existing,
              completedChunks: existing.completedChunks + (event.ok ? 1 : 0),
              failedChunks: existing.failedChunks + (event.ok ? 0 : 1),
            });
            break;
          }
          case "tx-appended": {
            if (!existing) break;
            next.set(event.fileId, { ...existing, txAdded: existing.txAdded + 1 });
            break;
          }
          case "unknown-appended": {
            if (!existing) break;
            next.set(event.fileId, { ...existing, unknownsAdded: existing.unknownsAdded + 1 });
            break;
          }
        }
        return next;
      });
    });
  }, [controller]);

  return (
    <Box flexDirection="column">
      <Text>Scanning {totalFiles} file(s) ({parallel} in parallel)</Text>
      {Array.from(rows.entries()).map(([fileId, row]) => (
        <FileRow key={fileId} row={row} />
      ))}
    </Box>
  );
}

function FileRow({ row }: { row: FileRowState }) {
  const status = statusOf(row);
  const finished = row.completedChunks + row.failedChunks;
  const tail = `${row.txAdded} transactions${row.unknownsAdded > 0 ? `, ${row.unknownsAdded} unknowns` : ""}`;

  if (status === "scanning") {
    return (
      <Text>
        {"  "}<Text color="yellow"><Spinner type="dots" /></Text>{" "}
        {row.fileName}{" "}
        <Text dimColor>
          {finished} of {row.totalChunks} pages · {tail} so far
        </Text>
      </Text>
    );
  }

  if (status === "done") {
    return (
      <Text>
        {"  "}<Text color="green">✓</Text> {row.fileName}{" "}
        <Text dimColor>
          {row.completedChunks} of {row.totalChunks} pages · {tail}
        </Text>
      </Text>
    );
  }

  if (status === "failed") {
    return (
      <Text>
        {"  "}<Text color="red">✗</Text> {row.fileName}{" "}
        <Text dimColor>
          0 of {row.totalChunks} pages · every chunk failed
        </Text>
      </Text>
    );
  }

  // partial
  return (
    <Text>
      {"  "}<Text color="yellow">⚠</Text> {row.fileName}{" "}
      <Text dimColor>
        {row.completedChunks} of {row.totalChunks} pages · {row.failedChunks} chunks failed · {tail}
      </Text>
    </Text>
  );
}
