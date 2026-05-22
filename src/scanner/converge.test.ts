import { describe, it, expect, vi } from "vitest";
import { converge } from "./converge.js";

function makeHooks() {
  return {
    onStart: vi.fn(),
    onStall: vi.fn(),
    onSuccess: vi.fn(),
    onFail: vi.fn(),
  };
}

describe("converge", () => {
  it("returns initial state and fires onSuccess when isDone is true at start", async () => {
    const h = makeHooks();
    const onPass = vi.fn(async (_p: number, _s: number) => 0);
    const result = await converge<number>({
      initial: 0,
      maxAttempts: 3,
      isDone: (s) => s === 0,
      isStalled: () => false,
      onPass,
      ...h,
    });
    expect(result).toBe(0);
    expect(onPass).not.toHaveBeenCalled();
    expect(h.onStart).toHaveBeenCalledTimes(1);
    expect(h.onSuccess).toHaveBeenCalledTimes(1);
    expect(h.onStall).not.toHaveBeenCalled();
    expect(h.onFail).not.toHaveBeenCalled();
  });

  it("runs passes until isDone, then fires onSuccess", async () => {
    const h = makeHooks();
    const calls: number[] = [];
    const onPass = vi.fn(async (pass: number, state: number) => {
      calls.push(pass);
      return state - 2;
    });
    const result = await converge<number>({
      initial: 5,
      maxAttempts: 5,
      isDone: (s) => s <= 0,
      isStalled: (curr, prev) => curr >= prev,
      onPass,
      ...h,
    });
    expect(result).toBeLessThanOrEqual(0);
    expect(calls).toEqual([1, 2, 3]);
    expect(h.onSuccess).toHaveBeenCalledTimes(1);
    expect(h.onSuccess).toHaveBeenCalledWith(result);
    expect(h.onStall).not.toHaveBeenCalled();
    expect(h.onFail).not.toHaveBeenCalled();
  });

  it("fires onStall and stops when a pass makes no progress", async () => {
    const h = makeHooks();
    const onPass = vi.fn(async (_pass: number, state: number) => state);
    const result = await converge<number>({
      initial: 3,
      maxAttempts: 10,
      isDone: (s) => s === 0,
      isStalled: (curr, prev) => curr >= prev,
      onPass,
      ...h,
    });
    expect(result).toBe(3);
    // pass 1 ran (nothing to compare against); pass 2 saw the stall.
    expect(onPass).toHaveBeenCalledTimes(1);
    expect(h.onStall).toHaveBeenCalledTimes(1);
    expect(h.onStall).toHaveBeenCalledWith(3);
    expect(h.onFail).not.toHaveBeenCalled();
  });

  it("fires onFail when maxAttempts is exhausted with progress on each pass", async () => {
    const h = makeHooks();
    const onPass = vi.fn(async (_pass: number, state: number) => state - 1);
    const result = await converge<number>({
      initial: 10,
      maxAttempts: 3,
      isDone: (s) => s === 0,
      isStalled: (curr, prev) => curr >= prev,
      onPass,
      ...h,
    });
    expect(result).toBe(7); // 10 - 3 passes of -1
    expect(onPass).toHaveBeenCalledTimes(3);
    expect(h.onFail).toHaveBeenCalledTimes(1);
    expect(h.onFail).toHaveBeenCalledWith(7);
    expect(h.onSuccess).not.toHaveBeenCalled();
    expect(h.onStall).not.toHaveBeenCalled();
  });

  it("works without optional hooks", async () => {
    const onPass = vi.fn(async (_p: number, s: number) => s - 1);
    const result = await converge<number>({
      initial: 2,
      maxAttempts: 5,
      isDone: (s) => s === 0,
      isStalled: () => false,
      onPass,
    });
    expect(result).toBe(0);
    expect(onPass).toHaveBeenCalledTimes(2);
  });
});
