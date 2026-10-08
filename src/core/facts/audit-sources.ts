/**
 * Source-string constants for the durable audit checkpoint rows that
 * extract-conversation-facts writes into the facts table to mark
 * batch-run progress:
 *   - `TERMINAL_AUDIT_SOURCE` — page-level "extraction complete" checkpoint
 *     (Eng-v2 C7). Doctor's backlog query matches this source +
 *     source_session, not the per-segment fact source.
 *   - `NON_EXTRACTABLE_AUDIT_SOURCE` — durable outcome for a successfully
 *     scanned page that contains no eligible multi-message segment, kept
 *     distinct from successful extraction so operator surfaces can report
 *     the truth without rescanning the page forever.
 *   - `LEGACY_TERMINAL_AUDIT_SOURCE` — the pre-`:v2` spelling of
 *     TERMINAL_AUDIT_SOURCE. `src/core/migrate.ts`'s doctor-backlog-index
 *     comment and `test/extract-conversation-facts.test.ts` ("legacy
 *     terminal rows do not suppress strict v2 replay") both reference this
 *     exact string, so brains upgraded through the pre-v2 checkpoint scheme
 *     can still carry rows under it. Excluded from recall the same as the
 *     current spelling — a legacy checkpoint is not a user fact either.
 *
 * These are checkpoints, not user facts. Recall-side callers filter rows
 * whose `source` is one of these out of the newest-N fetch window (see
 * `FactListOpts.excludeAuditRows` in `../engine.ts`).
 *
 * Pulled into a leaf module (no other imports) so `pglite-engine.ts` and
 * `postgres-engine.ts` — engine-live paths where runtime dynamic `import()`
 * is forbidden (`scripts/check-engine-dynamic-import.sh`) — can reference
 * these values via a static top-level import instead of reaching into the
 * much heavier `commands/extract-conversation-facts.ts` command module.
 * `extract-conversation-facts.ts` re-exports both current names unchanged
 * so its existing importers are unaffected.
 */

export const TERMINAL_AUDIT_SOURCE = 'cli:extract-conversation-facts:terminal:v2';

export const NON_EXTRACTABLE_AUDIT_SOURCE =
  'cli:extract-conversation-facts:non-extractable:v2';

export const LEGACY_TERMINAL_AUDIT_SOURCE = 'cli:extract-conversation-facts:terminal';

/** All audit-row source values (current + legacy), for callers that want a single IN-list. */
export const AUDIT_ROW_SOURCES = [
  TERMINAL_AUDIT_SOURCE,
  NON_EXTRACTABLE_AUDIT_SOURCE,
  LEGACY_TERMINAL_AUDIT_SOURCE,
] as const;

/**
 * Decision 8 (wave 9 follow-ups): the conversation parser + extractor
 * semantic version. Bump it when a parser or extractor change alters what an
 * already-scanned page yields. New outcome rows carry it in their `context`
 * (`extractor_version=<n>`) and a managed publication carries it in its
 * generation identity. An outcome recorded under an older version stays
 * fresh: nothing reopens automatically; doctor counts it as stale.
 */
export const CONVERSATION_EXTRACTOR_VERSION = 1;

const EXTRACTOR_VERSION_RE = /(?:^|; )extractor_version=(\d+)$/;

/** The outcome row context with the current extractor version stamped on it. */
export function stampExtractorVersion(context: string | null | undefined): string {
  const stamp = `extractor_version=${CONVERSATION_EXTRACTOR_VERSION}`;
  return context ? `${context}; ${stamp}` : stamp;
}

/** The extractor version an outcome row was recorded under, or null for a row older than the stamp. */
export function outcomeExtractorVersion(context: string | null | undefined): number | null {
  const match = context ? EXTRACTOR_VERSION_RE.exec(context) : null;
  return match ? Number(match[1]) : null;
}
