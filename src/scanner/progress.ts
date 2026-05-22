/**
 * Single-typed event sink scan-worker tools emit into as they write to the DB.
 * Replaces the bus + buffer for in-flight progress: one consumer at a time
 * (dashboard or plain-hooks counters) reads ticks per chunk.
 */
export interface ScanProgressEvent {
  readonly chunkId: string;
  readonly kind: "tx" | "question";
}

export interface ScanProgress {
  emit(event: ScanProgressEvent): void;
  subscribe(handler: (e: ScanProgressEvent) => void): () => void;
}

export function createProgress(): ScanProgress {
  const subscribers = new Set<(e: ScanProgressEvent) => void>();
  return {
    emit(event) {
      for (const fn of subscribers) {
        try {
          fn(event);
        } catch (err) {
          console.error(`[progress listener] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };
}
