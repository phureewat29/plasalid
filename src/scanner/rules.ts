/**
 * Canonical signatures used as the `key` half of `rules` rows. Derived
 * from the structural context of a question (merchant id, raw descriptor,
 * account pair) — never from prompt prose, because prose embeds volatile
 * data like dates and amounts that would prevent the rule from matching the
 * next time the same pattern appears.
 */

export type RuleKey = string;

const NON_WORD = /[^\p{L}\p{N}]+/gu;

export function normalizeDescriptor(raw: string): string {
  return raw
    .toLowerCase()
    .replace(NON_WORD, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function merchantKey(merchantId: string): RuleKey {
  return `merchant:${merchantId}`;
}

export function descriptorKey(descriptor: string): RuleKey {
  return `descriptor:${normalizeDescriptor(descriptor)}`;
}

export function accountPairKey(a: string, b: string): RuleKey {
  const [lo, hi] = [a, b].sort();
  return `account-pair:${lo}|${hi}`;
}

export function accountIdKey(id: string): RuleKey {
  return `account:${id}`;
}
