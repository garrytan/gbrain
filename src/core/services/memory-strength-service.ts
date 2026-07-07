import type { BrainEngine } from '../engine.ts';
import type { RetrievalTrace } from '../types.ts';

// Outcome-aware memory strength (N-5, ungated lanes: report + maintenance queue).
//
// Deterministic distillation of the retrieval-trace substrate into per-page
// strength terms. Every term is explainable and re-derivable from raw traces:
// - confirmed_read_count: read_context traces (route[0] === 'read_context')
//   whose source_refs resolve to the page slug.
// - probe_selected_count: retrieve_context traces (route[0] === 'retrieve_context')
//   that selected the page as a read candidate.
// - answer_ready_count: confirmed reads whose verification carries
//   'answer_ready:ready'.
// - conflict_count: confirmed reads whose verification carries
//   'unsupported:conflicting_canonical_evidence'.
//
// This service never touches ranking; consumption of the score for ranking
// stays behind the EV-1b gate (see the N-5 spec section).

export const MEMORY_STRENGTH_FORMULA =
  'strength = (2*confirmed_reads + 3*answer_ready + 1*probe_selections - 4*conflicts) * exp(-days_since_last_activity / (window_days / 2))';

const CONFIRMED_READ_WEIGHT = 2;
const ANSWER_READY_WEIGHT = 3;
const PROBE_SELECTED_WEIGHT = 1;
const CONFLICT_WEIGHT = 4;

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const TRACE_SCAN_LIMIT = 1_000;
const PAGE_SCAN_LIMIT = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const READ_ROUTE_KIND = 'read_context';
const PROBE_ROUTE_KIND = 'retrieve_context';
const ANSWER_READY_VERIFICATION = 'answer_ready:ready';
const CONFLICT_VERIFICATION = 'unsupported:conflicting_canonical_evidence';

export interface MemoryStrengthOptions {
  window_days?: number;
  limit?: number;
  now?: Date | string;
}

export interface MemoryStrengthEntry {
  slug: string;
  confirmed_read_count: number;
  probe_selected_count: number;
  answer_ready_count: number;
  conflict_count: number;
  last_read_at: string | null;
  last_activity_at: string;
  days_since_last_activity: number;
  recency_factor: number;
  strength_score: number;
}

export interface MemoryStrengthNeverUsedEntry {
  slug: string;
  title: string;
  updated_at: string;
}

export interface MemoryStrengthReport {
  generated_at: string;
  window: { since: string; until: string; window_days: number };
  half_life_days: number;
  formula: string;
  scanned_trace_count: number;
  scanned_page_count: number;
  totals: {
    pages_with_activity: number;
    fading: number;
    never_used: number;
  };
  top_strength: MemoryStrengthEntry[];
  fading: MemoryStrengthEntry[];
  never_used: MemoryStrengthNeverUsedEntry[];
}

export type MemoryStrengthEngine = Pick<BrainEngine, 'listPages' | 'listRetrievalTracesByWindow'>;

interface SlugActivity {
  confirmedReadCount: number;
  probeSelectedCount: number;
  answerReadyCount: number;
  conflictCount: number;
  lastReadAt: Date | null;
  lastActivityAt: Date;
}

export async function computeMemoryStrengthReport(
  engine: MemoryStrengthEngine,
  options: MemoryStrengthOptions = {},
): Promise<MemoryStrengthReport> {
  const windowDays = normalizeWindowDays(options.window_days);
  const limit = normalizeLimit(options.limit);
  const now = normalizeNow(options.now);
  const halfLifeDays = windowDays / 2;
  const until = now;
  const since = new Date(until.getTime() - windowDays * DAY_MS);

  const [traces, pages] = await Promise.all([
    engine.listRetrievalTracesByWindow({ since, until, limit: TRACE_SCAN_LIMIT }),
    engine.listPages({ limit: PAGE_SCAN_LIMIT }),
  ]);

  const activityBySlug = accumulateSlugActivity(traces);
  const entries = [...activityBySlug.entries()]
    .map(([slug, activity]) => toStrengthEntry(slug, activity, now, halfLifeDays));

  const topStrength = [...entries].sort(byStrengthDesc);
  const fadingCutoff = new Date(now.getTime() - halfLifeDays * DAY_MS);
  const fading = entries
    .filter((entry) => entry.confirmed_read_count > 0
      && entry.last_read_at !== null
      && new Date(entry.last_read_at) < fadingCutoff)
    .sort(byLastReadAsc);
  const neverUsed = pages
    .filter((page) => !activityBySlug.has(page.slug))
    .map((page) => ({
      slug: page.slug,
      title: page.title,
      updated_at: page.updated_at.toISOString(),
    }))
    .sort(byUpdatedAscThenSlug);

  return {
    generated_at: now.toISOString(),
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
      window_days: windowDays,
    },
    half_life_days: halfLifeDays,
    formula: MEMORY_STRENGTH_FORMULA,
    scanned_trace_count: traces.length,
    scanned_page_count: pages.length,
    totals: {
      pages_with_activity: entries.length,
      fading: fading.length,
      never_used: neverUsed.length,
    },
    top_strength: topStrength.slice(0, limit),
    fading: fading.slice(0, limit),
    never_used: neverUsed.slice(0, limit),
  };
}

function accumulateSlugActivity(traces: RetrievalTrace[]): Map<string, SlugActivity> {
  const bySlug = new Map<string, SlugActivity>();

  for (const trace of traces) {
    const routeKind = trace.route[0];
    const isRead = routeKind === READ_ROUTE_KIND;
    const isProbe = routeKind === PROBE_ROUTE_KIND;
    if (!isRead && !isProbe) continue;

    const isAnswerReady = isRead && trace.verification.includes(ANSWER_READY_VERIFICATION);
    const hasConflict = isRead && trace.verification.includes(CONFLICT_VERIFICATION);
    const slugs = [...new Set(trace.source_refs
      .map(slugFromRetrievalTraceSourceRef)
      .filter((slug): slug is string => Boolean(slug)))];

    for (const slug of slugs) {
      const previous = bySlug.get(slug);
      const activity: SlugActivity = previous ?? {
        confirmedReadCount: 0,
        probeSelectedCount: 0,
        answerReadyCount: 0,
        conflictCount: 0,
        lastReadAt: null,
        lastActivityAt: trace.created_at,
      };
      if (isRead) {
        activity.confirmedReadCount += 1;
        if (isAnswerReady) activity.answerReadyCount += 1;
        if (hasConflict) activity.conflictCount += 1;
        if (!activity.lastReadAt || trace.created_at > activity.lastReadAt) {
          activity.lastReadAt = trace.created_at;
        }
      } else {
        activity.probeSelectedCount += 1;
      }
      if (trace.created_at > activity.lastActivityAt) {
        activity.lastActivityAt = trace.created_at;
      }
      bySlug.set(slug, activity);
    }
  }

  return bySlug;
}

function toStrengthEntry(
  slug: string,
  activity: SlugActivity,
  now: Date,
  halfLifeDays: number,
): MemoryStrengthEntry {
  const daysSinceLastActivity = Math.max(0, (now.getTime() - activity.lastActivityAt.getTime()) / DAY_MS);
  const recencyFactor = Math.exp(-daysSinceLastActivity / halfLifeDays);
  const baseScore = CONFIRMED_READ_WEIGHT * activity.confirmedReadCount
    + ANSWER_READY_WEIGHT * activity.answerReadyCount
    + PROBE_SELECTED_WEIGHT * activity.probeSelectedCount
    - CONFLICT_WEIGHT * activity.conflictCount;

  return {
    slug,
    confirmed_read_count: activity.confirmedReadCount,
    probe_selected_count: activity.probeSelectedCount,
    answer_ready_count: activity.answerReadyCount,
    conflict_count: activity.conflictCount,
    last_read_at: activity.lastReadAt ? activity.lastReadAt.toISOString() : null,
    last_activity_at: activity.lastActivityAt.toISOString(),
    days_since_last_activity: roundTo(daysSinceLastActivity, 2),
    recency_factor: roundTo(recencyFactor, 4),
    strength_score: roundTo(baseScore * recencyFactor, 3),
  };
}

function byStrengthDesc(left: MemoryStrengthEntry, right: MemoryStrengthEntry): number {
  if (right.strength_score !== left.strength_score) {
    return right.strength_score - left.strength_score;
  }
  return left.slug.localeCompare(right.slug);
}

function byLastReadAsc(left: MemoryStrengthEntry, right: MemoryStrengthEntry): number {
  const delta = (left.last_read_at ?? '').localeCompare(right.last_read_at ?? '');
  if (delta !== 0) return delta;
  return left.slug.localeCompare(right.slug);
}

function byUpdatedAscThenSlug(
  left: MemoryStrengthNeverUsedEntry,
  right: MemoryStrengthNeverUsedEntry,
): number {
  const delta = left.updated_at.localeCompare(right.updated_at);
  if (delta !== 0) return delta;
  return left.slug.localeCompare(right.slug);
}

/**
 * Resolve the page slug behind a retrieval-trace source ref. Selector ids look
 * like `page:{scope_id}:{slug}` where scope ids themselves contain a colon
 * (e.g. `workspace:default`), so the slug starts at part index 3.
 */
export function slugFromRetrievalTraceSourceRef(sourceRef: string): string | undefined {
  const ref = sourceRef.split('@chars:')[0]!;
  const parts = ref.split(':');
  const kind = parts[0];
  if (
    (kind === 'page' || kind === 'compiled_truth' || kind === 'frontmatter' || kind === 'timeline_range')
    && parts.length >= 4
  ) {
    return parts.slice(3).join(':');
  }
  if (kind === 'line_span' && parts.length >= 6) {
    return parts.slice(3, -2).join(':');
  }
  return undefined;
}

function normalizeWindowDays(value: number | undefined): number {
  if (value == null) return DEFAULT_WINDOW_DAYS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('window_days must be a positive number');
  }
  return Math.min(value, MAX_WINDOW_DAYS);
}

function normalizeLimit(value: number | undefined): number {
  if (value == null) return DEFAULT_LIMIT;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('limit must be a positive number');
  }
  return Math.min(Math.floor(value), MAX_LIMIT);
}

function normalizeNow(value: Date | string | undefined): Date {
  if (value == null) return new Date();
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('now must be a valid Date or ISO datetime string');
  }
  return parsed;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
