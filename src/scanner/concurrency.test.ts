import { describe, it, expect } from "vitest";
import { runWithConcurrency } from "./concurrency.js";

describe("runWithConcurrency", () => {
  it("caps in-flight tasks at n and settles each slot independently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5 + (i % 3) * 3));
      inFlight--;
      if (i === 4) throw new Error("boom");
      return i * 2;
    });

    const results = await runWithConcurrency(tasks, 3);

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(10);
    expect(results[4].ok).toBe(false);
    expect(results.filter(r => r.ok)).toHaveLength(9);
  });
});
