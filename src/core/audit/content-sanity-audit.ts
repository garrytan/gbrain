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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentSanityResult } from '../content-sanity.ts';

export type ContentSanityEventType = 'hard_block' | 'soft_block' | 'warn';

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

export interface ContentSanityAcknowledgement {
  key: string;
  source_id: string;
  slug: string;
  event_type: ContentSanityEventType;
  signature: string;
  last_seen_ts: string;
  acknowledged_at: string;
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

function normalizeNames(names: ReadonlyArray<string>): string[] {
  return [...new Set(names)].sort();
}

function eventSignature(event: Pick<
  ContentSanityAuditEvent,
  'event_type' | 'junk_pattern_matches' | 'literal_substring_matches' | 'bypass_active'
>): string {
  return JSON.stringify({
    event_type: event.event_type,
    junk_pattern_matches: normalizeNames(event.junk_pattern_matches),
    literal_substring_matches: normalizeNames(event.literal_substring_matches),
    bypass_active: event.bypass_active === true,
  });
}

export function contentSanityAcknowledgementsPath(): string {
  return join(writer.resolveDir(), 'content-sanity-acks.jsonl');
}

export function contentSanityAckKey(
  event: Pick<
    ContentSanityAuditEvent,
    'source_id' | 'slug' | 'event_type' | 'junk_pattern_matches' | 'literal_substring_matches' | 'bypass_active'
  >,
): string {
  return `${event.source_id}\0${event.slug}\0${eventSignature(event)}`;
}

export function loadContentSanityAcknowledgements(): ContentSanityAcknowledgement[] {
  const path = contentSanityAcknowledgementsPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const out: ContentSanityAcknowledgement[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ContentSanityAcknowledgement);
    } catch {
      process.stderr.write(`[gbrain] content-sanity ack parse failed; skipping malformed line\n`);
    }
  }
  return out;
}

/** Classify an assessor result into the audit event type. The same
 *  result fires different events depending on caller context: a
 *  hard-block assessment recorded WITH bypass active is still an
 *  audit-worthy event but the page actually lands. The caller passes
 *  `bypass` explicitly so this function stays pure. */
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
  opts: { bypass?: boolean } = {},
): void {
  const bypass = opts.bypass ?? false;
  const event_type = classifyEventType(result, bypass);
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

export interface ContentSanityAcknowledgeResult {
  count: number;
  acknowledged_rows: number;
  summary: Array<{
    source_id: string;
    slug: string;
    event_type: ContentSanityEventType;
    rows: number;
  }>;
}

export function acknowledgeContentSanityEvents(
  events: ReadonlyArray<ContentSanityAuditEvent>,
  acknowledgedAt: Date = new Date(),
): ContentSanityAcknowledgeResult {
  if (events.length === 0) {
    return { count: 0, acknowledged_rows: 0, summary: [] };
  }

  const grouped = new Map<string, {
    source_id: string;
    slug: string;
    event_type: ContentSanityEventType;
    signature: string;
    last_seen_ts: string;
    rows: number;
  }>();

  for (const event of events) {
    const key = contentSanityAckKey(event);
    const signature = eventSignature(event);
    const existing = grouped.get(key);
    if (existing) {
      existing.rows++;
      if (Date.parse(event.ts) > Date.parse(existing.last_seen_ts)) {
        existing.last_seen_ts = event.ts;
      }
    } else {
      grouped.set(key, {
        source_id: event.source_id,
        slug: event.slug,
        event_type: event.event_type,
        signature,
        last_seen_ts: event.ts,
        rows: 1,
      });
    }
  }

  const prior = loadContentSanityAcknowledgements();
  const byKey = new Map(prior.map((entry) => [entry.key, entry]));
  const ackedAtIso = acknowledgedAt.toISOString();
  let changed = 0;
  let acknowledgedRows = 0;
  const summary: ContentSanityAcknowledgeResult['summary'] = [];

  for (const [key, group] of grouped.entries()) {
    const existing = byKey.get(key);
    const existingLastSeen = existing ? Date.parse(existing.last_seen_ts) : Number.NaN;
    const groupLastSeen = Date.parse(group.last_seen_ts);
    if (existing && Number.isFinite(existingLastSeen) && Number.isFinite(groupLastSeen) && existingLastSeen >= groupLastSeen) {
      continue;
    }
    byKey.set(key, {
      key,
      source_id: group.source_id,
      slug: group.slug,
      event_type: group.event_type,
      signature: group.signature,
      last_seen_ts: group.last_seen_ts,
      acknowledged_at: ackedAtIso,
    });
    changed++;
    acknowledgedRows += group.rows;
    summary.push({
      source_id: group.source_id,
      slug: group.slug,
      event_type: group.event_type,
      rows: group.rows,
    });
  }

  if (changed === 0) {
    return { count: 0, acknowledged_rows: 0, summary: [] };
  }

  const path = contentSanityAcknowledgementsPath();
  mkdirSync(writer.resolveDir(), { recursive: true });
  const rows = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  writeFileSync(path, rows.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  summary.sort((a, b) => b.rows - a.rows || a.source_id.localeCompare(b.source_id) || a.slug.localeCompare(b.slug));
  return { count: changed, acknowledged_rows: acknowledgedRows, summary };
}

export function unacknowledgedContentSanityEvents(
  events: ReadonlyArray<ContentSanityAuditEvent>,
): ContentSanityAuditEvent[] {
  if (events.length === 0) return [];
  const acknowledgements = loadContentSanityAcknowledgements();
  if (acknowledgements.length === 0) return [...events];
  const byKey = new Map(acknowledgements.map((entry) => [entry.key, entry]));
  return events.filter((event) => {
    const ack = byKey.get(contentSanityAckKey(event));
    if (!ack) return true;
    const eventTs = Date.parse(event.ts);
    const ackTs = Date.parse(ack.last_seen_ts);
    if (!Number.isFinite(eventTs) || !Number.isFinite(ackTs)) return true;
    return eventTs > ackTs;
  });
}

/** Summarize events for doctor's message. Groups by event_type +
 *  source_id; counts pattern hits across all events. Returns a stable
 *  shape so doctor can format consistently. */
export interface ContentSanitySummary {
  total_events: number;
  /** Distinct source_id + slug pairs. Re-imports can intentionally repeat events. */
  unique_source_slugs: number;
  /** total_events minus unique_source_slugs, when positive. */
  repeated_events: number;
  by_type: { hard_block: number; soft_block: number; warn: number };
  by_source: Record<string, number>;
  /** Top junk-pattern names by hit count (sorted desc). */
  top_patterns: Array<{ name: string; count: number }>;
  /** Source/slug pairs with repeat events, sorted by repeat count desc. */
  top_repeated_source_slugs: Array<{ source_id: string; slug: string; count: number; max_bytes: number }>;
}

export function summarizeContentSanityEvents(
  events: ReadonlyArray<ContentSanityAuditEvent>,
): ContentSanitySummary {
  const by_type = { hard_block: 0, soft_block: 0, warn: 0 };
  const by_source: Record<string, number> = {};
  const patternCounts: Record<string, number> = {};
  const sourceSlugCounts = new Map<string, { source_id: string; slug: string; count: number; max_bytes: number }>();

  for (const ev of events) {
    by_type[ev.event_type]++;
    by_source[ev.source_id] = (by_source[ev.source_id] ?? 0) + 1;
    const sourceSlugKey = `${ev.source_id}\0${ev.slug}`;
    const sourceSlug = sourceSlugCounts.get(sourceSlugKey);
    if (sourceSlug) {
      sourceSlug.count++;
      sourceSlug.max_bytes = Math.max(sourceSlug.max_bytes, ev.bytes);
    } else {
      sourceSlugCounts.set(sourceSlugKey, {
        source_id: ev.source_id,
        slug: ev.slug,
        count: 1,
        max_bytes: ev.bytes,
      });
    }
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
  const sourceSlugValues = [...sourceSlugCounts.values()];
  const top_repeated_source_slugs = sourceSlugValues
    .filter((entry) => entry.count > 1)
    .sort((a, b) => b.count - a.count || b.max_bytes - a.max_bytes)
    .slice(0, 5);

  return {
    total_events: events.length,
    unique_source_slugs: sourceSlugCounts.size,
    repeated_events: Math.max(0, events.length - sourceSlugCounts.size),
    by_type,
    by_source,
    top_patterns,
    top_repeated_source_slugs,
  };
}
