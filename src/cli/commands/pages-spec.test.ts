import { describe, it, expect } from "vitest";
import { parsePagesSpec } from "./ingest.js";
import { CliError } from "../output.js";

describe("parsePagesSpec", () => {
  it("returns undefined for 'all' / empty (meaning every page)", () => {
    expect(parsePagesSpec("all")).toBeUndefined();
    expect(parsePagesSpec("ALL")).toBeUndefined();
    expect(parsePagesSpec("")).toBeUndefined();
    expect(parsePagesSpec("   ")).toBeUndefined();
  });

  it("converts 1-based ranges/csv to sorted, unique, 0-based indices", () => {
    expect(parsePagesSpec("1-5,8")).toEqual([0, 1, 2, 3, 4, 7]);
    expect(parsePagesSpec("3")).toEqual([2]);
    expect(parsePagesSpec("2, 2 ,1")).toEqual([0, 1]); // whitespace-tolerant, dedup + sort
  });

  it("rejects malformed specs with a USAGE CliError", () => {
    for (const bad of ["abc", "0", "1-", "-3", "5-2", "1.5", "1,x"]) {
      let err: unknown;
      try {
        parsePagesSpec(bad);
      } catch (e) {
        err = e;
      }
      expect(err, `spec ${JSON.stringify(bad)} should throw`).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("USAGE");
    }
  });
});
