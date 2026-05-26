import { errorMessage } from "../lib/result.js";

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
          console.error(`[progress listener] ${errorMessage(err)}`);
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
