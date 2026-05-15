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
    expect(results).toEqual(Array.from({ length: 10 }, (_, i) => i * 2));
  });

  it("captures rejections per slot without aborting other tasks", async () => {
    const tasks = [
      async () => "ok-0",
      async () => { throw new Error("boom-1"); },
      async () => "ok-2",
    ];
    const results = await runWithConcurrency(tasks, 2);

    expect(results[0]).toBe("ok-0");
    expect(results[1]).toEqual({ error: expect.any(Error) });
    expect((results[1] as { error: Error }).error.message).toBe("boom-1");
    expect(results[2]).toBe("ok-2");
  });

  it("handles n larger than task count", async () => {
    const results = await runWithConcurrency([async () => 1, async () => 2], 8);
    expect(results).toEqual([1, 2]);
  });

  it("handles empty task list", async () => {
    const results = await runWithConcurrency([], 3);
    expect(results).toEqual([]);
  });
});
