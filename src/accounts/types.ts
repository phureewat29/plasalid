export type AccountType = "asset" | "liability" | "income" | "expense" | "equity";

export const TOP_LEVEL_TYPES: ReadonlyArray<AccountType> = [
  "asset", "liability", "income", "expense", "equity",
];

export interface AccountRow {
  id: string;
  name: string;
  type: AccountType;
  parent_id: string | null;
  subtype: string | null;
  bank_name: string | null;
  account_number_masked: string | null;
  currency: string;
  due_day: number | null;
  statement_day: number | null;
  points_balance: number | null;
  metadata_json: string | null;
  pii_flag: number;
  has_question: number;
  created_at: string;
}

export interface CreateAccountInput {
  id: string;
  name: string;
  type: AccountType;
  parent_id?: string | null;
  subtype?: string | null;
  bank_name?: string | null;
  account_number_masked?: string | null;
  currency?: string;
  due_day?: number | null;
  statement_day?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateAccountMetadataPatch {
  due_day?: number | null;
  statement_day?: number | null;
  points_balance?: number | null;
  account_number_masked?: string | null;
  bank_name?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AccountBalanceMinor extends AccountRow {
  /** Sum of debit legs, minor units. */
  debits_posted: number;
  /** Sum of credit legs, minor units. */
  credits_posted: number;
  /** Natural balance in minor units (normal-balance rule). */
  balance_minor: number;
  /** Natural balance as a decimal (via the account's currency exponent). */
  balance: number;
}
