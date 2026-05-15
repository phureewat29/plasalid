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
    `3. If this document references an account that isn't yet in the chart, call create_account once. Mask the account number to the last 4 digits.`,
    `4. Persist any document-level metadata you find (statement_day, due_day, points_balance, etc.) using update_account_metadata.`,
    `5. For every transaction in the document, call record_journal_entry with balanced debit/credit lines. Use existing accounts where possible; create expense/income accounts as needed.`,
    `6. Never pause to ask the user. If a row is ambiguous, post your best-guess entry first, then call note_concern with details and the new entry_id. If a row is truly unparseable, skip it and call note_concern with the raw row text (no entry_id). A missing row is better than a wrong row.`,
    `7. When you are done, call mark_file_scanned with a short summary.`,
  ].join("\n");
}
