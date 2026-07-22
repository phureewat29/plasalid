import { describe, it, expectTypeOf } from "vitest";
import * as z from "zod";
import { str, int, json } from "./validate.js";
import type { UpdateAccountMetadataPatch } from "../db/queries/account-balance.js";

describe("z.infer — worked shapes", () => {
  it("optional string becomes an optional key", () => {
    const spec = z.object({ name: str().optional() });
    expectTypeOf<z.infer<typeof spec>>().toEqualTypeOf<{ name?: string }>();
  });

  it("optional + nullable integer becomes an optional `| null` key", () => {
    const spec = z.object({ due_day: int().optional().nullable() });
    expectTypeOf<z.infer<typeof spec>>().toEqualTypeOf<{ due_day?: number | null }>();
  });

  it("required strips undefined into a required key", () => {
    const spec = z.object({ reason: str() });
    expectTypeOf<z.infer<typeof spec>>().toEqualTypeOf<{ reason: string }>();
  });

  it("default strips undefined into a required key", () => {
    const spec = z.object({ currency: str().default("THB") });
    expectTypeOf<z.infer<typeof spec>>().toEqualTypeOf<{ currency: string }>();
  });

  it("enum narrows to the literal union", () => {
    const spec = z.object({ type: z.enum(["asset", "liability"]) });
    expectTypeOf<z.infer<typeof spec>>().toEqualTypeOf<{ type: "asset" | "liability" }>();
  });

  it("json<T> carries its type parameter through optional", () => {
    const spec = z.object({ metadata: json<Record<string, unknown>>().optional() });
    expectTypeOf<z.infer<typeof spec>>().toEqualTypeOf<{ metadata?: Record<string, unknown> }>();
  });
});

describe("z.infer — real call-site type", () => {
  it("a representative patch spec infers a type assignable to UpdateAccountMetadataPatch", () => {
    const patchSpec = z.object({
      due_day: int().optional().nullable(),
      statement_day: int().optional().nullable(),
      points_balance: int().optional().nullable(),
      account_number_masked: str().optional().nullable(),
      bank_name: str().optional().nullable(),
      metadata: json<Record<string, unknown>>().optional(),
    });
    expectTypeOf<z.infer<typeof patchSpec>>().toMatchTypeOf<UpdateAccountMetadataPatch>();
  });
});
