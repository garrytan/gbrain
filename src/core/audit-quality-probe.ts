/**
 * v0.40.1.0 Track D / T6 — nightly quality probe audit trail.
 *
 * Writes one event per nightly cross-modal probe run to
 * `~/.gbrain/audit/quality-probe-YYYY-Www.jsonl` (ISO-week rotation).
 * Mirrors `audit-slug-fallback.ts` for filename + best-effort write
 * semantics. Honors `GBRAIN_AUDIT_DIR` via the shared `resolveAuditDir`.
 *
 * Read by `gbrain doctor`'s `nightly_quality_probe_health` check to
 * surface FAIL / ERROR / BUDGET_EXCEEDED runs from the last 7 days.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAuditDir } from './minions/handlers/shell-audit.ts';

export type QualityProbeOutcome =
  | 'pass'
  | 'fail'
  | 'inconclusive'
  | 'error'
  | 'budget_exceeded'
  | 'rate_limited'
  | 'no_embedding_key'
  | 'skipped';

/**
 * One non-passing question of a completed batch: its failing dimensions
 * (those carrying a fail reason), or its redacted error text. Holds model
 * ids, fixture question ids and scores only, never judge text.
 */
export interface QualityProbeFailure {
  question_id: string;
  /**
   * The batch's per-question verdict: fail, inconclusive, error or
   * upstream_error, or unknown for an entry whose verdict was unreadable.
   */
  verdict: string;
  /** Absent when the entry carries no aggregate (an error, or a malformed entry). */
  dimensions?: Array<{
    /** One of the probe's dimensions, or `unrecognized` for any other name a judge returned. */
    dimension: string;
    /** Absent only when a malformed aggregate carries no finite mean. */
    mean?: number;
    /** One per judge slot in slot order; null for a slot that gave no score. */
    scores?: Array<number | null>;
    fail_reason: string;
  }>;
  /** Redacted, at most 200 characters. */
  error?: string;
  /** Errors of the slots that did not score (inconclusive), each redacted and cut to 200 characters. */
  slot_errors?: Array<{ model: string; error: string }>;
}

export interface QualityProbeAuditEvent {
  ts: string;
  /** Verdict from the cross-modal batch summary (or short-circuit reason). */
  outcome: QualityProbeOutcome;
  /** Exit code of the underlying batch (0/1/2/-1 when short-circuited). */
  exit_code: number;
  pass_count: number;
  fail_count: number;
  inconclusive_count: number;
  error_count: number;
  /**
   * The batch's pre-flight estimate in USD for its judge calls only, not
   * spend: priced judge models add to it, unpriced ones (`claude-cli:*`)
   * add nothing. 0 when no batch summary came back (a short-circuit, or a
   * run that failed part-way).
   */
  est_cost_usd: number;
  /** Sha-8 of the fixture file content for change detection. */
  fixture_sha8?: string;
  /** Optional human-readable detail (e.g. error message, "no chat provider configured"). */
  detail?: string;
  /** Reader and extractor models the run used (rows written after the routes resolved). */
  reader_model?: string;
  extractor_model?: string;
  /** Judge models in slot order, as configured (completed batch). */
  judge_models?: string[];
  /** Per judge slot in slot order, the questions it scored; 0 names a slot that did not judge. */
  judge_scored_questions?: number[];
  /** Distinct models and providers among the judge slots that scored at least one question. */
  distinct_judge_models?: number;
  distinct_judge_providers?: number;
  /** Non-passing questions, at most 10, in summary order (non-pass rows only). */
  failures?: QualityProbeFailure[];
  /**
   * Metered chat spend of the run: successful chat calls (reader, extractor
   * and judges), their USD cost from canonical pricing, and the calls with
   * no price, whose cost is unknown. Covers more calls than `est_cost_usd`,
   * so it can exceed it.
   */
  chat_calls?: number;
  chat_cost_usd?: number;
  unpriced_chat_calls?: number;
  /**
   * Machine reason behind a non-verdict outcome: `fixture_unavailable`
   * (skipped), `panel_collapsed` (inconclusive: one model held two judge
   * slots, or fewer than two models judged), or the run budget's
   * `cost` / `runtime` / `no_pricing` (budget_exceeded).
   */
  reason?: string;
  /** The run-level USD cap over every paid call of the run, and where it came from (`user` or `default`). */
  cap_usd?: number;
  cap_source?: string;
  /** Directory holding the run's batch summary and LongMemEval output, kept for non-pass rows. */
  receipt_dir?: string;
}

/** Fields copied onto the row only when the caller set them (rows written before #5506 lack them). */
const OPTIONAL_EVENT_FIELDS = [
  'fixture_sha8',
  'detail',
  'reader_model',
  'extractor_model',
  'judge_models',
  'judge_scored_questions',
  'distinct_judge_models',
  'distinct_judge_providers',
  'failures',
  'chat_calls',
  'chat_cost_usd',
  'unpriced_chat_calls',
  'reason',
  'cap_usd',
  'cap_source',
  'receipt_dir',
] as const satisfies ReadonlyArray<keyof QualityProbeAuditEvent>;

/** ISO-week-rotated filename: `quality-probe-YYYY-Www.jsonl`. Mirrors audit-slug-fallback. */
export function computeQualityProbeAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `quality-probe-${isoYear}-W${ww}.jsonl`;
}

/**
 * Append one quality-probe event. Best-effort: write failure logs to stderr
 * but the probe phase continues.
 */
export function logQualityProbeEvent(event: Omit<QualityProbeAuditEvent, 'ts'> & { ts?: string }): void {
  const stamped: QualityProbeAuditEvent = {
    ts: event.ts ?? new Date().toISOString(),
    outcome: event.outcome,
    exit_code: event.exit_code,
    pass_count: event.pass_count,
    fail_count: event.fail_count,
    inconclusive_count: event.inconclusive_count,
    error_count: event.error_count,
    est_cost_usd: event.est_cost_usd,
  };
  const optional = stamped as unknown as Record<string, unknown>;
  for (const field of OPTIONAL_EVENT_FIELDS) {
    if (event[field] !== undefined) optional[field] = event[field];
  }
  const dir = resolveAuditDir();
  const file = path.join(dir, computeQualityProbeAuditFilename());
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(stamped) + '\n', { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] quality-probe audit write failed (${msg}); probe continues\n`);
  }
}

/**
 * Read recent quality-probe events from the current + prior ISO week files.
 * Used by `gbrain doctor`'s nightly_quality_probe_health check. Missing
 * files and corrupt rows are skipped silently.
 */
export function readRecentQualityProbeEvents(
  days = 7,
  now: Date = new Date(),
): QualityProbeAuditEvent[] {
  const dir = resolveAuditDir();
  const cutoff = now.getTime() - days * 86400000;
  const out: QualityProbeAuditEvent[] = [];
  const filenames = [
    computeQualityProbeAuditFilename(now),
    computeQualityProbeAuditFilename(new Date(now.getTime() - 7 * 86400000)),
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
        const ev = JSON.parse(line) as QualityProbeAuditEvent;
        const ts = Date.parse(ev.ts);
        if (Number.isFinite(ts) && ts >= cutoff) out.push(ev);
      } catch {
        // corrupt row — skip
      }
    }
  }
  // Chronological order (oldest → newest). Events accumulate across two
  // week files read current-week-FIRST, so without sorting the array tail
  // is the OLDEST in-window event whenever last week's file has entries —
  // and doctor's "Latest:" (which reads the tail) reported a days-old run
  // while the counts included the newest one.
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}
