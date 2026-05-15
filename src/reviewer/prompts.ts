export interface ReviewScope {
  accountId?: string;
  from?: string;
  to?: string;
  dryRun: boolean;
}

/**
 * Kickoff message the review agent receives. The persona + chart-of-accounts
 * snapshot live in the system prompt (`buildReviewSystemPrompt`); this is
 * the per-session instruction.
 */
export function buildReviewUserMessage(scope: ReviewScope): string {
  return [
    `Review the local Plasalid journal.`,
    ``,
    `Scope:`,
    `- account: ${scope.accountId ?? "all"}`,
    `- from: ${scope.from ?? "all time"}`,
    `- to: ${scope.to ?? "now"}`,
    `- dry run: ${scope.dryRun ? "yes — write tools are no-ops" : "no — writes commit after confirmation"}`,
    ``,
    `Steps:`,
    `1. Survey first: list_accounts, get_net_worth, count open concerns, then find_duplicate_entries, find_similar_accounts, find_unused_accounts, find_correlated_entries, find_recurrences. Hold the candidate list internally.`,
    `2. Prioritize open concerns, then correlated transactions, then recurrences, then chart-of-accounts hygiene.`,
    `3. Ask one focused question at a time via ask_user. After each answer, apply the change and re-survey only if the change invalidated other candidates.`,
    `4. Loop until no open concerns remain (or the user keeps choosing "Skip — leave as is"). Then call mark_review_done with a short summary of what was applied, recorded, and skipped.`,
  ].join("\n");
}
