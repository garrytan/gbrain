/**
 * gmail-categories — the Gmail category labels both open-loop lanes treat as
 * bulk by construction (#5103). The deterministic detector (loop-detect.ts)
 * and the extraction eligibility gate (loops-extract.ts) import this one
 * list, so the rule lives once: a thread under one of these categories opens
 * nothing unless the account owner wrote a substantive message in it.
 * `CATEGORY_UPDATES` is deliberately absent: invoices, contracts and document
 * requests land there and carry real obligations.
 */
export const BULK_CATEGORY_LABELS: readonly string[] = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'];

/** Whether any of `labelIds` is a bulk category. */
export function hasBulkCategory(labelIds: Iterable<string>): boolean {
  for (const label of labelIds) if (BULK_CATEGORY_LABELS.includes(label)) return true;
  return false;
}
