import { describe, it, expect } from "vitest";
import { str, num, int, bool, json, parseInput, safeParse, ValidationError } from "./validate.js";

describe("validate — defaults", () => {
  it("uses the default when the key is absent", () => {
    expect(parseInput({ currency: str().default("THB") }, {}).currency).toBe("THB");
  });

  it("prefers the provided value over the default", () => {
    expect(parseInput({ currency: str().default("THB") }, { currency: "USD" }).currency).toBe(
      "USD",
    );
  });
});

describe("validate — required accumulation", () => {
  it("lists every missing required field in one message, exact format", () => {
    const spec = { id: str().required(), name: str().required(), type: str().required() };
    expect(safeParse(spec, {})).toEqual({ ok: false, error: "--id, --name, --type required" });
  });

  it("honours a custom required label", () => {
    expect(safeParse({ reason: str().required("--reason") }, {})).toEqual({
      ok: false,
      error: "--reason required",
    });
  });

  it("derives the default label from the key (underscores to dashes)", () => {
    expect(safeParse({ due_day: int().required() }, {})).toEqual({
      ok: false,
      error: "--due-day required",
    });
  });

  it("accumulates coercion failures alongside missing-required, in key order", () => {
    const spec = { id: str().required(), amount: num() };
    expect(safeParse(spec, { amount: "abc" })).toEqual({
      ok: false,
      error: '--id required; --amount must be a number, got "abc"',
    });
  });
});

describe("validate — coercions", () => {
  it("coerces numbers and reports non-numbers", () => {
    expect(parseInput({ amount: num() }, { amount: "12.5" }).amount).toBe(12.5);
    expect(safeParse({ amount: num() }, { amount: "abc" })).toEqual({
      ok: false,
      error: '--amount must be a number, got "abc"',
    });
  });

  it("coerces integers and rejects non-integers with the integer message", () => {
    expect(parseInput({ n: int() }, { n: "7" }).n).toBe(7);
    expect(safeParse({ n: int() }, { n: "7.5" })).toEqual({
      ok: false,
      error: '--n must be an integer, got "7.5"',
    });
  });

  it("accepts real booleans and the strings true/false", () => {
    expect(parseInput({ f: bool() }, { f: true }).f).toBe(true);
    expect(parseInput({ f: bool() }, { f: "true" }).f).toBe(true);
    expect(parseInput({ f: bool() }, { f: "false" }).f).toBe(false);
    expect(safeParse({ f: bool() }, { f: "maybe" })).toEqual({
      ok: false,
      error: '--f must be a boolean, got "maybe"',
    });
  });

  it("parses JSON strings and passes already-parsed values through", () => {
    expect(parseInput({ m: json() }, { m: '{"a":1}' }).m).toEqual({ a: 1 });
    expect(parseInput({ m: json() }, { m: { a: 1 } }).m).toEqual({ a: 1 });
    const bad = safeParse({ m: json() }, { m: "{bad" });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toMatch(/^--m must be valid JSON: /);
  });
});

describe("validate — nullable", () => {
  it("passes explicit null through and does not call map", () => {
    let called = false;
    const spec = {
      due_day: int()
        .nullable()
        .map((v) => {
          called = true;
          return v * 2;
        }),
    };
    const parsed = parseInput(spec, { due_day: null });
    expect(parsed.due_day).toBeNull();
    expect(called).toBe(false);
  });

  it("treats the string \"null\" as a normal value, not null", () => {
    // str is non-nullable-agnostic here: "null" coerces to the literal string.
    expect(parseInput({ name: str().nullable() }, { name: "null" }).name).toBe("null");
  });
});

describe("validate — optional", () => {
  it("omits an absent optional key entirely", () => {
    const parsed = parseInput({ name: str().optional() }, {});
    expect("name" in parsed).toBe(false);
    expect(Object.keys(parsed)).toEqual([]);
  });
});

describe("validate — oneOf", () => {
  it("accepts a member and narrows nothing at runtime", () => {
    expect(parseInput({ type: str().oneOf(["asset", "liability"] as const) }, { type: "asset" }).type).toBe(
      "asset",
    );
  });

  it("rejects a non-member with the join-formatted message", () => {
    expect(safeParse({ type: str().oneOf(["asset", "liability"] as const) }, { type: "bogus" })).toEqual({
      ok: false,
      error: '--type must be one of asset, liability, got "bogus"',
    });
  });
});

describe("validate — key resolution", () => {
  it("reads an explicit alias", () => {
    const spec = { debit_account_id: str().alias("debit_account") };
    expect(parseInput(spec, { debit_account: "acc:1" }).debit_account_id).toBe("acc:1");
  });

  it("auto-bridges a camelCase raw key to a snake_case spec key", () => {
    expect(parseInput({ due_day: int() }, { dueDay: "20" }).due_day).toBe(20);
  });
});

describe("validate — map", () => {
  it("applies map to present values", () => {
    expect(parseInput({ due_day: int().map((v) => v * 2) }, { due_day: "10" }).due_day).toBe(20);
  });
});

describe("validate — atLeastOne", () => {
  const spec = { name: str().optional(), due_day: int().optional() };
  const msg = "at least one of --name, --due-day is required";

  it("throws when the parsed object has no keys", () => {
    expect(() => parseInput(spec, {}, { atLeastOne: msg })).toThrowError(msg);
  });

  it("passes when at least one field is present", () => {
    expect(parseInput(spec, { name: "x" }, { atLeastOne: msg })).toEqual({ name: "x" });
  });
});

describe("validate — entry-point shapes", () => {
  it("safeParse returns an ok Result on success", () => {
    expect(safeParse({ name: str().required() }, { name: "x" })).toEqual({
      ok: true,
      value: { name: "x" },
    });
  });

  it("safeParse returns an error Result on failure", () => {
    expect(safeParse({ name: str().required() }, {})).toEqual({
      ok: false,
      error: "--name required",
    });
  });

  it("parseInput throws a ValidationError listing all failures", () => {
    const spec = { id: str().required(), name: str().required(), type: str().required() };
    try {
      parseInput(spec, {});
      expect.unreachable("parseInput should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("--id, --name, --type required");
    }
  });
});
