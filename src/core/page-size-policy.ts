/**
 * Large-page policy (Wave A): the one ceiling every raisable ingress bound
 * derives from, and the inline threshold above which a page is treated as
 * large (post-commit embedding, title-tier context, bounded history).
 *
 * The ceiling is 24 MiB, not 32 MB: the journal and the local persistence IPC
 * count escaped JSON against 32 MiB caps, and no canonical file write may
 * exceed the 25 MiB whole-file secret-scan bound. A page at the ceiling plus
 * its frontmatter stays under every one of them. Code files keep their own
 * 5 MB bound (they skip content sanity and run tree-sitter plus the edge
 * extractor). The per-entry-point table lives in
 * docs/guides/memory-boundaries.md ("Large pages").
 */

/** Largest Markdown page body (UTF-8 bytes) any ingress admits in Wave A. */
export const PAGE_MAX_BYTES = 24 * 1024 ** 2;

/**
 * Files up to this many bytes are secret-scanned whole: `scanFiles` skips a
 * larger one, the push gate streams it in windows (workspace-push.ts), and no
 * canonical file write may produce one (secret-scan.ts).
 */
export const PUSH_SCAN_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Largest code file (UTF-8 bytes) import and sync admit. */
export const CODE_FILE_MAX_BYTES = 5_000_000;

/**
 * `pages.inline_max_bytes`: pages above this many body bytes are large. They
 * commit with NULL vectors and embed after the write through the stale sweep
 * under the per-page spend cap, use the title context tier, get a sampled junk
 * check before embedding, and keep a bounded number of version snapshots.
 * Fixed in Wave A; Wave B makes it the segmented-storage threshold.
 */
export const PAGE_INLINE_MAX_BYTES = 1024 ** 2;

/** True when a page body of this many UTF-8 bytes is above the inline threshold. */
export function isLargePageBytes(bytes: number): boolean {
  return bytes > PAGE_INLINE_MAX_BYTES;
}

/** SQL twin of isLargePageBytes(pageBodyBytes(page)) over a `pages` row aliased `alias`: `body_bytes` of a segmented page, else its body columns' bytes. */
export function largePageBodyFilter(alias: string): string {
  return `(CASE WHEN ${alias}.body_storage = 'segmented' THEN ${alias}.body_bytes ELSE octet_length(${alias}.compiled_truth) + octet_length(COALESCE(${alias}.timeline, '')) END) > ${PAGE_INLINE_MAX_BYTES}`;
}

/**
 * SQL over a `page_embedding_budget` row aliased `budget` joined to its
 * `pages` row aliased `page`: the row is held or capped and still applies.
 * The budget meters large pages only, so a row left on a page edited down to
 * the inline threshold or under no longer applies. The one rule the embedding
 * queue, the held list (`gbrain embed --held`) and the held count (doctor
 * `partial_embedding`) share.
 */
export function budgetRowAppliesFilter(budget: string, page: string): string {
  return `${budget}.state <> 'open' AND ${largePageBodyFilter(page)}`;
}

/** SQL over a `pages` row aliased `alias`: the page has a held or capped budget row that still applies (budgetRowAppliesFilter). */
export function pageBudgetLimitedFilter(alias: string): string {
  return `EXISTS (SELECT 1 FROM page_embedding_budget peb WHERE peb.page_id = ${alias}.id AND ${budgetRowAppliesFilter('peb', alias)})`;
}
