/**
 * The user-message prelude that accompanies the PDF document block. The persona
 * and rules live in the scan system prompt (src/ai/system-prompt.ts); this
 * message is a per-file instruction.
 */
export function buildScanUserMessage(opts: { fileName: string }): string {
  return [
    `Please scan the attached document.`,
    `File: ${opts.fileName}`,
    ``,
    `Steps:`,
    `1. Call list_accounts to see what already exists.`,
    `2. Infer the primary account type (asset / liability / income / expense) from the document's header, account type field, and transaction patterns.`,
    `3. If this document references an account that isn't yet in the chart, call create_account once (pass parent_id under the matching top-level type root). Mask the account number to the last 4 digits.`,
    `4. Persist any document-level metadata you find (statement_day, due_day, points_balance, etc.) using update_account_metadata.`,
    `5. For every transaction in the document, call record_transaction with balanced debit/credit postings. Attach a merchant block (canonical_name + alias + default_account_id when categorization is confident) for any external counter-party. Reuse existing accounts; create expense categories under their parent (e.g. expense:food before expense:food:groceries) as needed. When you cannot categorize confidently, post the expense side to expense:uncategorized and call note_concern with kind="uncategorized_expense".`,
    `6. Never pause to ask the user. If a row is ambiguous, post your best-guess transaction first, then call note_concern with details and the new transaction_id. If a row is truly unparseable, skip it and call note_concern with the raw row text (no transaction_id). A missing row is better than a wrong row.`,
    `7. When you are done, call mark_file_scanned with a short summary.`,
  ].join("\n");
}
