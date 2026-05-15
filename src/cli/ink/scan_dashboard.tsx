import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export type ScanDashboardEvent =
  | { type: "scan-start"; fileName: string }
  | { type: "scan-progress"; fileName: string; step: string }
  | { type: "scan-end"; fileName: string; status: "scanned" | "failed"; entries: number; concerns: number; error?: string };

/**
 * Subscribe / publish channel between the pipeline (which knows nothing about
 * UI) and the dashboard (which knows nothing about the pipeline). The CLI
 * creates one of these, fans events into it, and hands it to the component.
 */
export class ScanDashboardController {
  private subscribers: Array<(e: ScanDashboardEvent) => void> = [];

  publish(event: ScanDashboardEvent): void {
    for (const sub of this.subscribers) sub(event);
  }

  subscribe(handler: (e: ScanDashboardEvent) => void): () => void {
    this.subscribers.push(handler);
    return () => {
      this.subscribers = this.subscribers.filter(s => s !== handler);
    };
  }
}

type RowState =
  | { kind: "scanning"; step: string }
  | { kind: "done"; entries: number; concerns: number }
  | { kind: "failed"; error: string };

interface Props {
  controller: ScanDashboardController;
  totalFiles: number;
  parallel: number;
}

/**
 * Multi-row live dashboard for the scan phase. Rows appear when a file starts
 * scanning, update as steps flow, and freeze when the agent loop ends. Counts
 * shown are the in-buffer counts at scan-end; correlation may add concerns
 * later, which the terse summary reflects.
 */
export function ScanDashboard({ controller, totalFiles, parallel }: Props) {
  const [rows, setRows] = useState<Map<string, RowState>>(() => new Map());

  useEffect(() => {
    return controller.subscribe(event => {
      setRows(prev => {
        const next = new Map(prev);
        switch (event.type) {
          case "scan-start":
            next.set(event.fileName, { kind: "scanning", step: "starting..." });
            break;
          case "scan-progress":
            next.set(event.fileName, { kind: "scanning", step: event.step });
            break;
          case "scan-end":
            next.set(
              event.fileName,
              event.status === "scanned"
                ? { kind: "done", entries: event.entries, concerns: event.concerns }
                : { kind: "failed", error: event.error ?? "failed" },
            );
            break;
        }
        return next;
      });
    });
  }, [controller]);

  return (
    <Box flexDirection="column">
      <Text>Scanning {totalFiles} file(s) ({parallel} in parallel)</Text>
      {Array.from(rows.entries()).map(([name, state]) => (
        <FileRow key={name} name={name} state={state} />
      ))}
    </Box>
  );
}

function FileRow({ name, state }: { name: string; state: RowState }) {
  if (state.kind === "scanning") {
    return (
      <Text>
        {"  "}<Text color="yellow"><Spinner type="dots" /></Text> {name} <Text dimColor>· {state.step}</Text>
      </Text>
    );
  }
  if (state.kind === "done") {
    return (
      <Text>
        {"  "}<Text color="green">✓</Text> {name} <Text dimColor>({state.entries} entries, {state.concerns} concerns)</Text>
      </Text>
    );
  }
  return (
    <Text>
      {"  "}<Text color="red">✗</Text> {name} <Text dimColor>— {state.error}</Text>
    </Text>
  );
}
