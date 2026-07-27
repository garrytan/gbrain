/**
 * v0.40.3.0 — per-chunk Haiku synopsis failure audit (D17, mirrors the
 * v0.35.0.0 rerank-audit precedent: deliberately failure-ONLY, no success
 * logging).
 *
 * Writes failure events to `~/.gbrain/audit/synopsis-failures-YYYY-Www.jsonl`
 * (ISO-week rotation, mirrors `audit-slug-fallback.ts` shape). Surfaced
 * by `gbrain doctor`'s `synopsis_refusal_rate` check.
 *
 * Why failure-only (D17 decision, repeated here for the file-level reader):
 *   - The per-chunk synopsis backfill writes one row per page (potentially
 *     10K+ on a typical brain). Logging successes turns that into 10K+
 *     JSONL rows per backfill — wasted disk + needlessly leaks "this
 *     user is mid-backfill at TS=..." into a local file.
 *   - Failure signal (refusal / empty / malformed / fall-back) is the
 *     ACTIONABLE signal: surfaces Haiku regressions, prompt-injection
 *     attempts in user content, and pages that consistently fail to
 *     generate good synopses.
 *
 * Best-effort writes — failures go to stderr but the Minion job continues
 * (the page falls back to title-only per D14 regardless of audit success).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAuditDir } from './minions/handlers/shell-audit.ts';

/**
 * Per-D27 P1-2 failure envelope. Each `kind` maps to a distinct downstream
 * handler in the Minion handler:
 *
 *   refusal | empty | malformed → page-level fall-back to title-only (D14)
 *   auth_failure                → throw, doctor surfaces, no retry
 *   rate_limit                  → retry per gateway with Retry-After
 *   timeout | network | provider_5xx → retry per gateway policy
 *   source_missing              → walk source-text fallback chain (D11)
 */
export type SynopsisFailureKind =
  | 'refusal'
  | 'empty'
  | 'malformed'
  | 'auth_failure'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'provider_5xx'
  | 'source_missing';

export interface SynopsisFailureAuditEvent {
  ts: string;
  /** Page slug whose synopsis generation failed. */
  page_slug: string;
  /** Source id (multi-source brains). */
  source_id: string;
  /** Chunk index within the page (0-based). For page-level failures, -1. */
  chunk_index: number;
  /** Failure classification per D27 P1-2. */
  kind: SynopsisFailureKind;
  /**
   * Optional provider-supplied detail (HTTP status, retry-after ms, etc.)
   * for forensic analysis. Bounded ~200 chars so adversarial errors can't
   * blow the audit file.
   */
  detail?: string;
  /**
   * True when this failure triggered the page-level fall-back to
   * title-only (D14). Lets doctor compute the per-page-degradation rate.
   */
  page_level_fallback: boolean;
  severity: 'warn';
}

const DETAIL_HARD_CAP_CHARS = 200;

/** ISO-week-rotated filename: `synopsis-failures-YYYY-Www.jsonl`. */
export function computeSynopsisAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `synopsis-failures-${isoYear}-W${ww}.jsonl`;
}

export interface LogSynopsisFailureArgs {
  pageSlug: string;
  sourceId: string;
  chunkIndex: number;
  kind: SynopsisFailureKind;
  detail?: string;
  pageLevelFallback: boolean;
}

/**
 * Append one failure event to the current week's audit JSONL.
 *
 * Best-effort: write failure to JSONL logs to stderr but does NOT throw
 * — the Minion handler continues regardless (the page already fell back
 * to title-only per D14).
 */
export function logSynopsisFailure(args: LogSynopsisFailureArgs): void {
  const event: SynopsisFailureAuditEvent = {
    ts: new Date().toISOString(),
    page_slug: args.pageSlug,
    source_id: args.sourceId,
    chunk_index: args.chunkIndex,
    kind: args.kind,
    detail: args.detail ? args.detail.slice(0, DETAIL_HARD_CAP_CHARS) : undefined,
    page_level_fallback: args.pageLevelFallback,
    severity: 'warn',
  };
  const dir = resolveAuditDir();
  const file = path.join(dir, computeSynopsisAuditFilename());
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[gbrain] synopsis-failure audit write failed (${msg}); page ${args.pageSlug} continues\n`,
    );
  }
}

/**
 * Read recent (default 7-day window) synopsis-failure events. Walks the
 * current + previous ISO week so a window straddling Monday-midnight stays
 * covered. Missing file / corrupt rows are skipped silently — informational
 * surface, shouldn't block doctor.
 */
export function readRecentSynopsisFailures(
  days = 7,
  now: Date = new Date(),
): SynopsisFailureAuditEvent[] {
  const dir = resolveAuditDir();
  const cutoff = now.getTime() - days * 86400000;
  const out: SynopsisFailureAuditEvent[] = [];
  const filenames = [
    computeSynopsisAuditFilename(now),
    computeSynopsisAuditFilename(new Date(now.getTime() - 7 * 86400000)),
  ];
  for (const filename of filenames) {
    const file = path.join(dir, filename);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      try {
        const ev = JSON.parse(line) as SynopsisFailureAuditEvent;
        const ts = Date.parse(ev.ts);
        if (Number.isFinite(ts) && ts >= cutoff) out.push(ev);
      } catch {
        // Corrupt row — skip.
      }
    }
  }
  return out;
}

/**
 * Doctor-facing summary: aggregates recent failures by kind + computes
 * the page-level-fallback rate. Returns `null` when zero events seen
 * (lets doctor short-circuit to ok without computing a rate from zero).
 */
export interface SynopsisFailureSummary {
  total: number;
  by_kind: Record<SynopsisFailureKind, number>;
  page_level_fallback_count: number;
  page_level_fallback_rate: number;
}

export function summarizeSynopsisFailures(
  events: SynopsisFailureAuditEvent[],
): SynopsisFailureSummary | null {
  if (events.length === 0) return null;
  const by_kind: Record<SynopsisFailureKind, number> = {
    refusal: 0,
    empty: 0,
    malformed: 0,
    auth_failure: 0,
    rate_limit: 0,
    timeout: 0,
    network: 0,
    provider_5xx: 0,
    source_missing: 0,
  };
  let page_level_fallback_count = 0;
  for (const ev of events) {
    by_kind[ev.kind]++;
    if (ev.page_level_fallback) page_level_fallback_count++;
  }
  return {
    total: events.length,
    by_kind,
    page_level_fallback_count,
    page_level_fallback_rate: page_level_fallback_count / events.length,
  };
}
