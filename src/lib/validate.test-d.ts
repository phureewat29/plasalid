import { describe, it, expectTypeOf } from "vitest";
import { str, num, int, json, type Infer } from "./validate.js";
import type { UpdateAccountMetadataPatch } from "../db/queries/account-balance.js";

describe("Infer — worked shapes", () => {
  it("optional string becomes an optional key", () => {
    const spec = { name: str().optional() };
    expectTypeOf<Infer<typeof spec>>().toEqualTypeOf<{ name?: string }>();
  });

  it("optional + nullable integer becomes an optional `| null` key", () => {
    const spec = { due_day: num().int().optional().nullable() };
    expectTypeOf<Infer<typeof spec>>().toEqualTypeOf<{ due_day?: number | null }>();
  });

  it("required strips undefined into a required key", () => {
    const spec = { reason: str().required("--reason") };
    expectTypeOf<Infer<typeof spec>>().toEqualTypeOf<{ reason: string }>();
  });

  it("default strips undefined into a required key", () => {
    const spec = { currency: str().default("THB") };
    expectTypeOf<Infer<typeof spec>>().toEqualTypeOf<{ currency: string }>();
  });

  it("oneOf narrows to the literal union", () => {
    const spec = { type: str().oneOf(["asset", "liability"] as const) };
    expectTypeOf<Infer<typeof spec>>().toEqualTypeOf<{ type: "asset" | "liability" }>();
  });

  it("json<T> carries its type parameter through optional", () => {
    const spec = { metadata: json<Record<string, unknown>>().optional() };
    expectTypeOf<Infer<typeof spec>>().toEqualTypeOf<{ metadata?: Record<string, unknown> }>();
  });
});

describe("Infer — real call-site type", () => {
  it("a representative patch spec infers a type assignable to UpdateAccountMetadataPatch", () => {
    const patchSpec = {
      due_day: int().optional().nullable(),
      statement_day: int().optional().nullable(),
      points_balance: int().optional().nullable(),
      account_number_masked: str().optional().nullable(),
      bank_name: str().optional().nullable(),
      metadata: json<Record<string, unknown>>().optional(),
    };
    expectTypeOf<Infer<typeof patchSpec>>().toMatchTypeOf<UpdateAccountMetadataPatch>();
  });
});
