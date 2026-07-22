import type { Result } from "./result.js";

/** Thrown by `parseInput` on a failed parse. `src/lib/` has no dependency on
 *  `src/cli/`, so the CLI layer maps this to its own error/exit-code type. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

declare const OUT: unique symbol;

/**
 * Phantom carrier of a field's inferred output type. `[OUT]` is never read at
 * runtime; it exists only so `Infer` can recover `T` from a spec entry.
 */
export interface FieldSpec<T> {
  readonly [OUT]: T;
}

type OutputOf<F> = F extends FieldSpec<infer T> ? T : never;

type OptionalKeys<S> = {
  [K in keyof S]: undefined extends OutputOf<S[K]> ? K : never;
}[keyof S];

type Flatten<T> = { [K in keyof T]: T[K] } & {};

/**
 * The object type a spec parses into: a key whose field output includes
 * `undefined` becomes optional (`key?:`) with `undefined` stripped from the
 * value type; every other key is required.
 */
export type Infer<S extends Record<string, FieldSpec<unknown>>> = Flatten<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: OutputOf<S[K]> } & {
    [K in OptionalKeys<S>]?: Exclude<OutputOf<S[K]>, undefined>;
  }
>;

type Kind = "str" | "num" | "bool" | "json";

/** How a field behaves when its raw value resolves to `undefined` (absent). */
type Absence =
  | { type: "required" }
  | { type: "optional" }
  | { type: "default"; value: unknown };

interface FieldConfig {
  kind: Kind;
  integer: boolean;
  nullable: boolean;
  absence: Absence;
  label?: string;
  oneOf?: readonly unknown[];
  map?: (value: unknown) => unknown;
  aliases: readonly string[];
}

/**
 * Immutable field builder. Every modifier returns a fresh `Field` with a cloned
 * config, so a base builder can be reused across specs without one chain's
 * modifiers leaking into another. `config` is internal to this module.
 */
export class Field<T> implements FieldSpec<T> {
  declare readonly [OUT]: T;
  readonly config: FieldConfig;

  constructor(config: FieldConfig) {
    this.config = config;
  }

  private with(patch: Partial<FieldConfig>): FieldConfig {
    return { ...this.config, ...patch };
  }

  /** Absent input omits the key from the output entirely. */
  optional(): Field<T | undefined> {
    return new Field(this.with({ absence: { type: "optional" } }));
  }

  /** Explicit `null` passes through untouched (coerce/oneOf/map are skipped). */
  nullable(): Field<T | null> {
    return new Field(this.with({ nullable: true }));
  }

  /** Absent input yields `value`; the key is always present in the output. */
  default(value: Exclude<T, undefined>): Field<Exclude<T, undefined>> {
    return new Field(this.with({ absence: { type: "default", value } }));
  }

  /** Absent input accumulates a `<label> required` error; `label` defaults to
   *  `--` + the key with underscores replaced by dashes. */
  required(label?: string): Field<Exclude<T, undefined>> {
    return new Field(this.with({ absence: { type: "required" }, label }));
  }

  /** Require an integer after numeric coercion. Meaningful only after `num()`. */
  int(): Field<T> {
    return new Field(this.with({ integer: true }));
  }

  /** Restrict to a literal set, narrowing the output type to those members. */
  oneOf<const V extends readonly T[]>(values: V): Field<V[number]> {
    return new Field(this.with({ oneOf: values }));
  }

  /** Transforms present, non-null values (`null` passes through when nullable,
   *  `undefined` means absent). Chained maps compose left-to-right. */
  map<U>(fn: (value: NonNullable<T>) => U): Field<U | Extract<T, null | undefined>> {
    const prev = this.config.map;
    const next = prev
      ? (value: unknown): unknown => fn(prev(value) as NonNullable<T>)
      : (value: unknown): unknown => fn(value as NonNullable<T>);
    return new Field(this.with({ map: next }));
  }

  /** Extra raw-input keys to read for this field (genuine synonyms). */
  alias(...names: string[]): Field<T> {
    return new Field(this.with({ aliases: [...this.config.aliases, ...names] }));
  }
}

function base(kind: Kind, integer = false): FieldConfig {
  return { kind, integer, nullable: false, absence: { type: "required" }, aliases: [] };
}

/** A string field. */
export function str(): Field<string> {
  return new Field<string>(base("str"));
}

/** A number field (any finite number). */
export function num(): Field<number> {
  return new Field<number>(base("num"));
}

/** A number field constrained to integers. */
export function int(): Field<number> {
  return new Field<number>(base("num", true));
}

/** A boolean field (real booleans, or the strings "true"/"false"). */
export function bool(): Field<boolean> {
  return new Field<boolean>(base("bool"));
}

/** A JSON field, parsed from a string (or passed through if already parsed). */
export function json<T = unknown>(): Field<T> {
  return new Field<T>(base("json"));
}

function defaultLabel(key: string): string {
  return "--" + key.replace(/_/g, "-");
}

function toCamelCase(key: string): string {
  return key.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}

/**
 * Tries the key verbatim, its camelCase/snake_case forms, then aliases; first
 * non-`undefined` value wins. Auto-bridges commander's camelCase opts to the
 * snake_case names specs are written in, without per-field alias noise.
 */
function resolveRaw(
  raw: Record<string, unknown>,
  key: string,
  aliases: readonly string[],
): unknown {
  const candidates = [key, toCamelCase(key), toSnakeCase(key), ...aliases];
  for (const candidate of candidates) {
    const value = raw[candidate];
    if (value !== undefined) return value;
  }
  return undefined;
}

type Coerced = { ok: true; value: unknown } | { ok: false; message: string };

function coerce(config: FieldConfig, value: unknown, label: string): Coerced {
  const { kind } = config;
  if (kind === "str") {
    return { ok: true, value: typeof value === "string" ? value : String(value) };
  }
  if (kind === "num") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) {
      return { ok: false, message: `${label} must be a number, got "${value}"` };
    }
    if (config.integer && !Number.isInteger(n)) {
      return { ok: false, message: `${label} must be an integer, got "${value}"` };
    }
    return { ok: true, value: n };
  }
  if (kind === "bool") {
    if (typeof value === "boolean") return { ok: true, value };
    if (value === "true") return { ok: true, value: true };
    if (value === "false") return { ok: true, value: false };
    return { ok: false, message: `${label} must be a boolean, got "${value}"` };
  }
  // kind === "json": commander passes the raw text; stdin may pass a parsed value.
  if (typeof value !== "string") return { ok: true, value };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (err) {
    return { ok: false, message: `${label} must be valid JSON: ${(err as Error).message}` };
  }
}

type AccError = { kind: "missing"; label: string } | { kind: "other"; message: string };

/**
 * When every error is a missing field, groups labels into `--a, --b required`;
 * otherwise joins each error (missing rendered as `<label> required`) with "; ".
 */
function combineErrors(errors: AccError[]): string {
  const missing: string[] = [];
  const others: string[] = [];
  for (const e of errors) {
    if (e.kind === "missing") missing.push(e.label);
    else others.push(e.message);
  }
  if (others.length === 0) return `${missing.join(", ")} required`;
  return errors
    .map((e) => (e.kind === "missing" ? `${e.label} required` : e.message))
    .join("; ");
}

function runParse<S extends Record<string, FieldSpec<unknown>>>(
  spec: S,
  raw: Record<string, unknown>,
): Result<Infer<S>> {
  const fields = spec as unknown as Record<string, Field<unknown>>;
  const output: Record<string, unknown> = {};
  const errors: AccError[] = [];

  for (const key of Object.keys(fields)) {
    const config = fields[key].config;
    const label = config.label ?? defaultLabel(key);
    const value = resolveRaw(raw, key, config.aliases);

    if (value === undefined) {
      if (config.absence.type === "default") output[key] = config.absence.value;
      else if (config.absence.type === "required") errors.push({ kind: "missing", label });
      // optional → key omitted
      continue;
    }

    if (value === null && config.nullable) {
      output[key] = null;
      continue;
    }

    const coerced = coerce(config, value, label);
    if (!coerced.ok) {
      errors.push({ kind: "other", message: coerced.message });
      continue;
    }
    let result = coerced.value;

    if (config.oneOf && !config.oneOf.includes(result)) {
      errors.push({
        kind: "other",
        message: `${label} must be one of ${config.oneOf.join(", ")}, got "${result}"`,
      });
      continue;
    }

    if (config.map) result = config.map(result);
    output[key] = result;
  }

  if (errors.length > 0) return { ok: false, error: combineErrors(errors) };
  return { ok: true, value: output as Infer<S> };
}

/**
 * Accumulates every missing-required and coercion error before throwing one
 * `ValidationError`. With `opts.atLeastOne`, a parse that produced zero output
 * keys fails with that message (the CLI's "at least one flag" guard).
 */
export function parseInput<S extends Record<string, FieldSpec<unknown>>>(
  spec: S,
  raw: Record<string, unknown>,
  opts?: { atLeastOne?: string },
): Infer<S> {
  const result = runParse(spec, raw);
  if (!result.ok) throw new ValidationError(result.error);
  if (
    opts?.atLeastOne &&
    Object.keys(result.value as Record<string, unknown>).length === 0
  ) {
    throw new ValidationError(opts.atLeastOne);
  }
  return result.value;
}

/** Non-throwing counterpart of `parseInput`, for batch row-validation paths
 *  that must keep the PARTIAL exit-code contract. */
export function safeParse<S extends Record<string, FieldSpec<unknown>>>(
  spec: S,
  raw: Record<string, unknown>,
): Result<Infer<S>> {
  return runParse(spec, raw);
}
