/**
 * Content-sanity audit JSONL.
 *
 * Writes events at `~/.gbrain/audit/content-sanity-YYYY-Www.jsonl`
 * (ISO-week rotation, mirrors `audit-slug-fallback.ts`). Built on the
 * shared `audit-writer.ts` primitive from v0.40.4.0; honors
 * `GBRAIN_AUDIT_DIR` env override.
 *
 * One stream, three event types:
 *   - `hard_block` — assessor rejected the content; importFromContent
 *     threw ContentSanityBlockError; page did NOT land.
 *   - `soft_block` — assessor flagged oversize without junk-pattern;
 *     page landed with `frontmatter.embed_skip` set; embedder will
 *     skip on next sweep.
 *   - `warn` — bytes > bytes_warn but neither hard- nor soft-block.
 *     Page landed normally; stderr was emitted for operator visibility.
 *
 * Why one stream for all three:
 *   The doctor check `content_sanity_audit_recent` aggregates by
 *   reason + source_id over a 7-day window. Splitting events across
 *   files would force doctor to walk multiple paths or risk dropping
 *   one. One stream + a discriminator field stays simple.
 *
 * Best-effort writes. Audit-writer primitive emits stderr on failure
 * but never throws — ingest path continues regardless. Documented
 * caveat (Codex r1 #14): filesystem JSONL doesn't surface cleanly in
 * remote/server deployments. Operators on multi-host setups should
 * point `GBRAIN_AUDIT_DIR` at a shared filesystem. Doctor's message
 * for `content_sanity_audit_recent` explicitly names this limitation.
 *
 * Caller contract: the ingest gate calls `logContentSanityAssessment`
 * BEFORE branching on hard/soft block so every assessment that does
 * something user-visible gets a row. Idempotent re-imports are
 * intentionally logged again — the row count over time IS the signal
 * (catches "this source keeps producing the same junk").
 */

import { createAuditWriter, computeIsoWeekFilename } from './audit-writer.ts';
import type { ContentSanityResult } from '../content-sanity.ts';

export type ContentSanityEventType =
  | 'hard_block'   // legacy alias for the reject path (pre-v0.42)
  | 'quarantine'   // junk → hidden, page landed with quarantine marker
  | 'reject'       // junk → thrown (junk_disposition: reject)
  | 'flag'         // fuzzy markup-heavy or oversize → content_flag, stays searchable
  | 'soft_block'   // oversize → embed_skip
  | 'warn';

export interface ContentSanityAuditEvent {
  ts: string;
  /** Which kind of assessment fired. */
  event_type: ContentSanityEventType;
  /** Page slug that was being imported. */
  slug: string;
  /** Source ID — multi-source brains need this for the doctor
   *  aggregation. Empty string when caller doesn't know (rare). */
  source_id: string;
  /** UTF-8 byte length of compiled_truth + timeline at assessment. */
  bytes: number;
  /** Names of built-in patterns that matched (empty array on
   *  soft_block / warn). */
  junk_pattern_matches: string[];
  /** Names of operator literals that matched. */
  literal_substring_matches: string[];
  /** Human-readable reason messages from the assessor result. Embeds
   *  the PAGE_JUNK_PATTERN / PAGE_OVERSIZED prefix tokens. */
  reason_messages: string[];
  /** When true, the kill-switch was active and this event represents
   *  a bypass — the page landed regardless. Lets doctor distinguish
   *  "operator deliberately on a junk-tolerant mode" from "junk
   *  actually landing." Default false. */
  bypass_active?: boolean;
}

/** Filename matches the audit-writer's ISO-week convention. */
export function computeContentSanityAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('content-sanity', now);
}

const writer = createAuditWriter<ContentSanityAuditEvent>({
  featureName: 'content-sanity',
  errorLabel: 'gbrain',
  errorMessagePrefix: 'content-sanity audit ',
  errorTrailer: '; import continues',
});

/** Classify an assessor result into the audit event type. The same
 *  result fires different events depending on caller context: a
 *  hard-block assessment recorded WITH bypass active is still an
 *  audit-worthy event but the page actually lands. The caller passes
 *  `bypass` explicitly so this function stays pure. */
// NOTE: this fallback only knows the LEGACY event types (hard_block /
// soft_block / warn). It can NEVER return the v0.42 tiers (quarantine /
// reject / flag) — those are resolved by the caller AFTER the disposition
// branch and passed via `opts.disposition`. A caller that forgets to pass
// `disposition` on a quarantine/flag would mis-classify it as legacy
// `hard_block`/`soft_block`; all current callers (import-file.ts) pass it.
function classifyEventType(
  result: ContentSanityResult,
  bypass: boolean,
): ContentSanityEventType {
  if (bypass) {
    // Kill-switch override always logs as warn since the page lands.
    // Hard-block + bypass = "would have blocked but operator
    // overrode"; soft-block + bypass = same idea.
    return 'warn';
  }
  if (result.shouldHardBlock) return 'hard_block';
  if (result.shouldSkipEmbed) return 'soft_block';
  return 'warn';
}

/**
 * Append a content-sanity assessment event. Called from the ingest
 * gate before any branch on the assessment result — every assessment
 * that does something user-visible gets recorded.
 *
 * Best-effort: audit-writer primitive stderr-warns on failure but
 * never throws. The gate proceeds either way.
 */
export function logContentSanityAssessment(
  slug: string,
  sourceId: string,
  result: ContentSanityResult,
  opts: { bypass?: boolean; disposition?: ContentSanityEventType } = {},
): void {
  const bypass = opts.bypass ?? false;
  // Codex #10: when the caller knows the resolved disposition (quarantine
  // vs reject vs flag — decided AFTER assessment), it passes it explicitly
  // so the event is accurate, not inferred. Bypass still forces 'warn'
  // (the page landed regardless).
  const event_type = bypass
    ? 'warn'
    : (opts.disposition ?? classifyEventType(result, bypass));
  // Skip rows that don't say anything: bytes under warn threshold AND
  // no patterns matched AND no bypass. The assessor result's reasons
  // array is empty in that case; we don't want every ingest of a
  // normal-size page to write a row.
  const hasReasons = result.reasons.length > 0 || result.reason_messages.length > 0;
  if (!hasReasons && !bypass) return;

  writer.log({
    event_type,
    slug,
    source_id: sourceId,
    bytes: result.bytes,
    junk_pattern_matches: result.junk_pattern_matches,
    literal_substring_matches: result.literal_substring_matches,
    reason_messages: result.reason_messages,
    ...(bypass ? { bypass_active: true } : {}),
  });
}

/** Read recent events for the doctor `content_sanity_audit_recent`
 *  check. 7-day default window; reads current + previous ISO week
 *  files so a window straddling Monday-midnight stays covered. */
export function readRecentContentSanityEvents(
  days = 7,
  now: Date = new Date(),
): ContentSanityAuditEvent[] {
  return writer.readRecent(days, now);
}

/** Summarize events for doctor's message. Groups by event_type +
 *  source_id; counts pattern hits across all events. Returns a stable
 *  shape so doctor can format consistently. */
export interface ContentSanitySummary {
  total_events: number;
  by_type: {
    hard_block: number;
    quarantine: number;
    reject: number;
    flag: number;
    soft_block: number;
    warn: number;
  };
  by_source: Record<string, number>;
  /** Top junk-pattern names by hit count (sorted desc). */
  top_patterns: Array<{ name: string; count: number }>;
}

export function summarizeContentSanityEvents(
  events: ReadonlyArray<ContentSanityAuditEvent>,
): ContentSanitySummary {
  const by_type = {
    hard_block: 0,
    quarantine: 0,
    reject: 0,
    flag: 0,
    soft_block: 0,
    warn: 0,
  };
  const by_source: Record<string, number> = {};
  const patternCounts: Record<string, number> = {};

  for (const ev of events) {
    by_type[ev.event_type]++;
    by_source[ev.source_id] = (by_source[ev.source_id] ?? 0) + 1;
    for (const name of ev.junk_pattern_matches) {
      patternCounts[name] = (patternCounts[name] ?? 0) + 1;
    }
    for (const name of ev.literal_substring_matches) {
      patternCounts[name] = (patternCounts[name] ?? 0) + 1;
    }
  }

  const top_patterns = Object.entries(patternCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total_events: events.length,
    by_type,
    by_source,
    top_patterns,
  };
}
