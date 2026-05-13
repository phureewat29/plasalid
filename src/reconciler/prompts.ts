export interface ReconcileScope {
  accountId?: string;
  from?: string;
  to?: string;
  dryRun: boolean;
}

/**
 * Kickoff message the reconcile agent receives. The persona + chart-of-accounts
 * snapshot live in the system prompt (`buildReconcileSystemPrompt`); this is
 * the per-session instruction.
 */
export function buildReconcileUserMessage(scope: ReconcileScope): string {
  return [
    `Reconcile the local Plasalid journal.`,
    ``,
    `Scope:`,
    `- account: ${scope.accountId ?? "all"}`,
    `- from: ${scope.from ?? "all time"}`,
    `- to: ${scope.to ?? "now"}`,
    `- dry run: ${scope.dryRun ? "yes — write tools are no-ops" : "no — writes commit after confirmation"}`,
    ``,
    `Steps:`,
    `1. Survey: list_accounts, get_net_worth, find_duplicate_entries, find_similar_accounts, find_unused_accounts.`,
    `2. For each candidate, call ask_user with concrete options ("merge X into Y", "delete entry Z", "leave as is").`,
    `3. Apply the chosen action only after the user confirms.`,
    `4. When you're done, call mark_reconcile_done with a short summary.`,
  ].join("\n");
}
