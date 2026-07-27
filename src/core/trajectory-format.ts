/**
 * v0.40.2.0 — Shared `<trajectory>` block formatter for prompt assembly.
 *
 * Sibling shape to `renderTakesBlock` / `renderChatBlock`: takes a list of
 * TrajectoryPoint rows, returns the XML-wrapped block the LLM prompt should
 * splice in, plus a sanitized-count for the audit trail.
 *
 * Consumed by two surfaces:
 *   - `src/core/think/prompt.ts` (`gbrain think` production path)
 *   - `src/eval/longmemeval/harness.ts` (benchmark wiring)
 *
 * Both pass through the same XML envelope so the model sees one consistent
 * data shape regardless of where the trajectory came from.
 *
 * Design decisions (locked):
 *   - Grouping key: `(metric ?? event_type)`. A row with neither set is
 *     skipped (legacy free-text fact rows that can't carry chronology
 *     beyond the raw text the retrieval path already serves).
 *   - Per-metric cap (default 20) + total cap (default 100) bound the
 *     prompt budget. 100 points × ~75 tokens/point ≈ 7.5K tokens — fits
 *     comfortably alongside calibration + retrieval blocks.
 *   - `knowledge_update` intent annotates value-change rows with
 *     `(superseded prior)` — the explicit signal Codex flagged was
 *     missing from default RRF-ordered retrieval. Other intents skip
 *     the annotation to keep the block compact.
 *   - INJECTION_PATTERNS sanitization applied per row's `text` field
 *     (parity with renderTakesBlock + renderChatBlock).
 *   - Deterministic output: groups sorted alphabetically by key, points
 *     within a group already chronological by engine contract.
 */

import type { TrajectoryPoint } from './engine.ts';
import { INJECTION_PATTERNS } from './think/sanitize.ts';

export type TrajectoryIntent = 'temporal' | 'knowledge_update' | 'other';

export interface FormatTrajectoryOpts {
  /** Drives whether `(superseded prior)` annotation fires. */
  intent?: TrajectoryIntent;
  /** Per-metric/event-type cap on points emitted. Default 20. */
  perMetricCap?: number;
  /** Hard cap across all groups. Default 100. */
  totalCap?: number;
}

export interface FormattedTrajectoryBlock {
  /**
   * Empty string when there are no qualifying points. Callers that splice
   * conditionally should test `rendered.length > 0` before adding the
   * "Known trajectory:" header — empty block means "don't cue the model
   * we tried."
   */
  rendered: string;
  /** Count of rows whose `text` matched at least one INJECTION_PATTERN. */
  sanitizedCount: number;
  /** Total points emitted across all groups (post-cap). */
  emittedPoints: number;
}

const DEFAULT_PER_METRIC_CAP = 20;
const DEFAULT_TOTAL_CAP = 100;
const TEXT_CAP_PER_ROW = 500;

function sanitizeRowText(raw: string): { text: string; matched: boolean } {
  let text = raw;
  let matched = false;
  for (const p of INJECTION_PATTERNS) {
    if (p.rx.test(text)) {
      matched = true;
      text = text.replace(p.rx, p.replacement);
    }
  }
  if (text.length > TEXT_CAP_PER_ROW) {
    text = text.slice(0, TEXT_CAP_PER_ROW - 3) + '...';
  }
  return { text, matched };
}

/**
 * Group key for a single point. Returns null when the row has neither
 * metric nor event_type — those rows are skipped entirely (caller
 * already saw them via plain retrieval).
 */
function groupKey(p: TrajectoryPoint): string | null {
  if (p.metric !== null) return p.metric;
  if (p.event_type !== null) return p.event_type;
  return null;
}

/**
 * Format ISO date as YYYY-MM-DD for prompt economy. The engine already
 * sets `valid_from` to a Date instance.
 */
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compact value rendering: numbers get unit/period suffix when present;
 * NULL values fall back to '-'. Event rows always have null value.
 */
function fmtValue(p: TrajectoryPoint): string {
  if (p.value === null) return '-';
  const parts = [String(p.value)];
  if (p.unit) parts.push(p.unit);
  if (p.period) parts.push(`/${p.period}`);
  return parts.join(' ');
}

/**
 * Format a single group as `<trajectory entity="..." metric="...">` (when
 * the key is a metric) or `<trajectory entity="..." event_type="...">`
 * (when the key is an event type). The two attribute forms are
 * disambiguated by checking the first point's shape.
 */
function formatGroup(
  entitySlug: string,
  groupKeyValue: string,
  points: TrajectoryPoint[],
  opts: { intent?: TrajectoryIntent },
): { block: string; sanitizedCount: number } {
  const isMetric = points[0]?.metric !== null;
  const attr = isMetric ? `metric="${groupKeyValue}"` : `event_type="${groupKeyValue}"`;

  const lines: string[] = [];
  let sanitizedCount = 0;
  let priorValue: number | null = null;
  const annotateSupersession = opts.intent === 'knowledge_update' && isMetric;

  for (const p of points) {
    const { text, matched } = sanitizeRowText(p.text);
    if (matched) sanitizedCount++;
    const date = fmtDate(p.valid_from);
    const valueStr = fmtValue(p);
    const provenance = p.source_session ?? p.source_markdown_slug ?? null;
    const provSuffix = provenance ? ` (source: ${provenance})` : '';

    let suffix = '';
    if (annotateSupersession && p.value !== null && priorValue !== null && p.value !== priorValue) {
      suffix = ' (superseded prior)';
    }

    lines.push(
      isMetric
        ? `  as of ${date}: ${valueStr} — ${text}${suffix}${provSuffix}`
        : `  as of ${date}: ${text}${suffix}${provSuffix}`,
    );

    if (p.value !== null) priorValue = p.value;
  }

  const block = `<trajectory entity="${entitySlug}" ${attr}>\n${lines.join('\n')}\n</trajectory>`;
  return { block, sanitizedCount };
}

/**
 * Public entry. Returns the XML block + counts. Empty `rendered` means the
 * caller should NOT emit a "Known trajectory:" header — show nothing.
 *
 * `entitySlug` is interpolated into a `<trajectory entity="...">` attribute.
 * Callers MUST ensure entitySlug doesn't contain raw `"` or `<` (it comes
 * from `resolveEntitySlug` which guarantees the canonical
 * `prefix/name-with-dashes` shape). No injection sanitization is applied to
 * the slug itself — bad input is a programming error, not a runtime
 * threat.
 */
export function formatTrajectoryBlock(
  points: TrajectoryPoint[],
  entitySlug: string,
  opts: FormatTrajectoryOpts = {},
): FormattedTrajectoryBlock {
  const perMetricCap = opts.perMetricCap ?? DEFAULT_PER_METRIC_CAP;
  const totalCap = opts.totalCap ?? DEFAULT_TOTAL_CAP;

  // Group by metric/event_type. Points with neither are silently dropped.
  const groups = new Map<string, TrajectoryPoint[]>();
  for (const p of points) {
    const key = groupKey(p);
    if (key === null) continue;
    const arr = groups.get(key);
    if (arr) arr.push(p);
    else groups.set(key, [p]);
  }

  if (groups.size === 0) {
    return { rendered: '', sanitizedCount: 0, emittedPoints: 0 };
  }

  // Apply per-metric cap (chronological order preserved — engine returns
  // points sorted by valid_from ASC; we keep the most recent N per metric
  // by slicing from the tail, which preserves chronology within the cap).
  // Then apply total cap by iterating groups in sorted key order.
  const groupKeys = [...groups.keys()].sort();
  const renderedBlocks: string[] = [];
  let sanitizedCount = 0;
  let emittedPoints = 0;

  for (const key of groupKeys) {
    if (emittedPoints >= totalCap) break;
    const groupPoints = groups.get(key)!;
    const capPerGroup = Math.min(perMetricCap, totalCap - emittedPoints);
    // Keep most-recent N (slice from tail). Engine returns ASC; we preserve
    // ASC within the kept window for chronological prompt rendering.
    const kept = groupPoints.length > capPerGroup
      ? groupPoints.slice(groupPoints.length - capPerGroup)
      : groupPoints;
    const { block, sanitizedCount: gs } = formatGroup(entitySlug, key, kept, opts);
    renderedBlocks.push(block);
    sanitizedCount += gs;
    emittedPoints += kept.length;
  }

  return {
    rendered: renderedBlocks.join('\n\n'),
    sanitizedCount,
    emittedPoints,
  };
}
