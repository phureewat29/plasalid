import { describe, it, expect } from "vitest";
import { runWithConcurrency } from "./concurrency.js";

describe("runWithConcurrency", () => {
  it("caps in-flight tasks at n and completes all", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const completed: number[] = [];

    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5 + (i % 3) * 3));
      inFlight--;
      completed.push(i);
      return i * 2;
    });

    const results = await runWithConcurrency(tasks, 3);

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(completed).toHaveLength(10);
    expect(results).toEqual(
      Array.from({ length: 10 }, (_, i) => ({ ok: true, value: i * 2 })),
    );
  });

  it("captures rejections per slot without aborting other tasks", async () => {
    const tasks = [
      async () => "ok-0",
      async () => {
        throw new Error("boom-1");
      },
      async () => "ok-2",
    ];
    const results = await runWithConcurrency(tasks, 2);

    expect(results[0]).toEqual({ ok: true, value: "ok-0" });
    expect(results[1].ok).toBe(false);
    if (!results[1].ok) {
      expect(results[1].error).toBeInstanceOf(Error);
      expect((results[1].error as Error).message).toBe("boom-1");
    }
    expect(results[2]).toEqual({ ok: true, value: "ok-2" });
  });

  it("handles n larger than task count", async () => {
    const results = await runWithConcurrency([async () => 1, async () => 2], 8);
    expect(results).toEqual([
      { ok: true, value: 1 },
      { ok: true, value: 2 },
    ]);
  });

  it("handles empty task list", async () => {
    const results = await runWithConcurrency([], 3);
    expect(results).toEqual([]);
  });

  it("preserves input order even when later tasks finish first", async () => {
    const tasks = [
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        return "slow-0";
      },
      async () => "fast-1",
      async () => "fast-2",
    ];
    const results = await runWithConcurrency(tasks, 3);
    expect(results).toEqual([
      { ok: true, value: "slow-0" },
      { ok: true, value: "fast-1" },
      { ok: true, value: "fast-2" },
    ]);
  });

  it("narrows correctly with ok discriminator", async () => {
    const results = await runWithConcurrency<number>(
      [async () => 42, async () => { throw new Error("nope"); }],
      2,
    );
    const sum = results.reduce((acc, r) => (r.ok ? acc + r.value : acc), 0);
    expect(sum).toBe(42);
    const errors = results.filter((r): r is { ok: false; error: unknown } => !r.ok);
    expect(errors).toHaveLength(1);
  });
});
