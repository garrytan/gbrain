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

/** A signature (source_id, slug, event_type, reason_key) counts as
 *  chronic when its events span at least this many distinct UTC days
 *  inside the read window. Nightly re-imports of the same oversized
 *  page cross this in 3 days; a genuinely new offender stays "new"
 *  for its first two days. Same-day retries never make a signature
 *  chronic on their own, and events with a malformed `ts` never count
 *  toward chronicity (fail-safe: unknown recency scores as new). */
export const CHRONIC_MIN_DISTINCT_DAYS = 3;

/** Summarize events for doctor's message. Groups by event_type +
 *  source_id; counts pattern hits across all events; splits distinct
 *  (source_id, slug, event_type, reason_key) signatures into chronic
 *  (recurring across >= CHRONIC_MIN_DISTINCT_DAYS distinct UTC days)
 *  vs new, so doctor can score fresh inflow instead of re-counting
 *  the same standing offenders every run (#1893). Returns a stable
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
  /** Distinct (source_id, slug) pairs across all events. */
  distinct_pages: number;
  /** Pages carrying at least one chronic signature. */
  chronic_pages: number;
  /** Pages carrying at least one NEW (non-chronic) signature. A page
   *  whose chronic signature gains a fresh one counts in BOTH chronic
   *  and new — the sets overlap, so chronic + new can exceed distinct. */
  new_pages: number;
  /** Pages with a NEW soft-disposition signature (soft_block | flag).
   *  event_type is part of the signature, so a page whose chronic
   *  warn escalates to its first soft_block still counts here. */
  new_soft_pages: number;
  /** Pages with a NEW warn-type signature. */
  new_warn_pages: number;
  /** Events recorded with the kill-switch bypass active. Surfaced in
   *  the doctor message so a chronically-bypassing operator setup
   *  stays visible even when its signatures go chronic. */
  bypass_events: number;
  /** Top chronic signatures by event count (desc, max 3), for the
   *  doctor message's "who keeps repeating" callout. */
  top_chronic: Array<{ slug: string; source_id: string; events: number; days: number }>;
}

/** Stable reason discriminator for a signature. Pattern/literal names
 *  (sorted + deduped so array order can't split one signature into
 *  two; JSON-encoded so an operator literal containing a delimiter
 *  can't collide with a multi-name set), else the assessor's
 *  PREFIX_TOKEN before ':' on the first reason message, else empty
 *  (event_type alone discriminates). */
function reasonKey(ev: ContentSanityAuditEvent): string {
  const names = [...new Set([...ev.junk_pattern_matches, ...ev.literal_substring_matches])].sort();
  if (names.length > 0) return JSON.stringify(names);
  const first = ev.reason_messages[0];
  if (first) return first.split(':')[0].trim();
  return '';
}

/** Canonical UTC day for an audit timestamp, or null when it doesn't
 *  parse. The writer always emits `toISOString()`, but foreign or
 *  corrupted rows must not be able to fabricate extra distinct days
 *  (offset timestamps re-normalize; unparseable ones don't count
 *  toward chronicity — unknown recency scores as new, fail-safe). */
function utcDayOf(ts: unknown): string | null {
  if (typeof ts !== 'string' || ts === '') return null;
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
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
  interface SigAgg {
    slug: string;
    source_id: string;
    event_type: ContentSanityEventType;
    days: Set<string>;
    events: number;
  }
  const sigs = new Map<string, SigAgg>();
  let bypass_events = 0;

  for (const ev of events) {
    by_type[ev.event_type]++;
    by_source[ev.source_id] = (by_source[ev.source_id] ?? 0) + 1;
    if (ev.bypass_active) bypass_events++;
    for (const name of ev.junk_pattern_matches) {
      patternCounts[name] = (patternCounts[name] ?? 0) + 1;
    }
    for (const name of ev.literal_substring_matches) {
      patternCounts[name] = (patternCounts[name] ?? 0) + 1;
    }
    // JSON tuple encoding: collision-free even when a slug or operator
    // literal contains a would-be delimiter.
    const sigKey = JSON.stringify([ev.source_id, ev.slug, ev.event_type, reasonKey(ev)]);
    let agg = sigs.get(sigKey);
    if (!agg) {
      agg = { slug: ev.slug, source_id: ev.source_id, event_type: ev.event_type, days: new Set(), events: 0 };
      sigs.set(sigKey, agg);
    }
    agg.events++;
    const day = utcDayOf(ev.ts);
    if (day !== null) agg.days.add(day);
  }

  const top_patterns = Object.entries(patternCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const pageKey = (a: { source_id: string; slug: string }) => JSON.stringify([a.source_id, a.slug]);
  const allPages = new Set<string>();
  const chronicPages = new Set<string>();
  const newPages = new Set<string>();
  const newSoftPages = new Set<string>();
  const newWarnPages = new Set<string>();
  const chronicSigs: SigAgg[] = [];
  for (const agg of sigs.values()) {
    allPages.add(pageKey(agg));
    const chronic = agg.days.size >= CHRONIC_MIN_DISTINCT_DAYS;
    if (chronic) {
      chronicPages.add(pageKey(agg));
      chronicSigs.push(agg);
    } else {
      newPages.add(pageKey(agg));
      if (agg.event_type === 'soft_block' || agg.event_type === 'flag') {
        newSoftPages.add(pageKey(agg));
      } else if (agg.event_type === 'warn') {
        newWarnPages.add(pageKey(agg));
      }
    }
  }
  const top_chronic = chronicSigs
    .sort((a, b) => b.events - a.events)
    .slice(0, 3)
    .map(a => ({ slug: a.slug, source_id: a.source_id, events: a.events, days: a.days.size }));

  return {
    total_events: events.length,
    by_type,
    by_source,
    top_patterns,
    distinct_pages: allPages.size,
    chronic_pages: chronicPages.size,
    new_pages: newPages.size,
    new_soft_pages: newSoftPages.size,
    new_warn_pages: newWarnPages.size,
    bypass_events,
    top_chronic,
  };
}
