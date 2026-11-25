/**
 * The swap readiness evaluator (docs/designs/RUST_ENGINE.md "Swap readiness", D14): a pure function from the shadow
 * status document (`gbrain engine shadow status --json`, S3) to a verdict and one row per criterion.
 *
 * Fail closed: a missing or malformed field is `missing` and the verdict is NOT READY; a criterion is never omitted and
 * never passes on missing evidence. There is no override. Criterion 8 (speed) is measured and reported, never gating:
 * D23 (the maintainer's C1 ruling of 2026-11-19) makes the speed bar gate only turning Rust on by default, not the
 * opt-in swap.
 */
import { DEFAULT_SHADOW_MIN_DAYS } from './policy.ts';
import type { SwapRefusalReason } from './refusals.ts';
import { destinationAllowsManyWriters, type DestinationOptions } from './destination.ts';

/** The fields S5a reads; S3 owns the document. Counts are epoch-scoped totals unless the name says otherwise. */
export interface ShadowStatus {
  epoch_id?: string;
  /** ISO time the current epoch started; criterion 1 counts 14 days from it. */
  epoch_started_at?: string;
  follower?: {
    state?: string;
    lag_ms?: number;
    lag_ms_p99_24h?: number;
    lag_ms_p99_epoch?: number;
    queue_depth?: number;
    applied_rows?: number;
    coverage_watermark?: { valid?: boolean; through?: string | null; invalidated_reason?: string | null };
  };
  reconcile?: { state?: string; consecutive_clean_full_passes?: number; next_full_pass_due?: string | null };
  write_comparisons?: {
    state?: string;
    sample_rate?: number;
    comparable?: number;
    unexplained_difference?: number;
    uncomparable?: number;
    capability_missing?: number;
  };
  fingerprints?: {
    checked_rows?: number;
    mismatches?: number;
    probe?: { state?: 'pass' | 'fail' | 'not_run'; checked_at?: string; server_version?: string; collation?: string; mismatches?: number };
  };
  allocators?: { verified?: boolean; checked_at?: string };
  seed?: { seed_id?: string; finished_at?: string | null; unseeded_gap_rows_total?: number };
  /** Read comparisons in the window: per operation class, successful comparisons against the class minimum. */
  reads?: {
    ops?: Array<{ op: string; successful: number; minimum: number }>;
    capability_missing_7d?: number;
    rust_error_unresolved_7d?: number;
    diverged_unexplained_7d?: number;
  };
  search?: {
    trigram_exact_disagreements?: number;
    keyword_title?: { ranker?: 'ts_rank' | 'default'; exact_disagreements?: number; e1_e2_at_least_both?: boolean };
    vector_recall_at_10?: number;
    primary_recall_at_10?: number;
  };
  privacy_diverged?: number;
  bench?: { pairs?: number; rust_no_worse?: boolean; filtered_vector_margin_met?: boolean; losses?: string[] };
  child?: { panics?: number; faults?: number };
  drills?: { backup_restore_passed?: boolean; eval_gates_e1_e3?: boolean };
  eligibility?: {
    /** Writer hosts seen by durable writer observations in the last 7 days; null when no observation table exists. */
    writer_hosts_7d?: number | null;
    unknown_writer_paths?: number;
    team_brain?: boolean;
    preview_target?: boolean;
  };
}

export type CriterionState = 'pass' | 'fail' | 'missing' | 'reported';

export interface CriterionRow {
  n: number;
  name: string;
  state: CriterionState;
  /** What was measured, or which field was missing. */
  detail: string;
  /** Criterion 8 only: measured and reported, never gating (D23). */
  gating: boolean;
}

export interface ReadinessVerdict {
  verdict: 'READY' | 'NOT READY';
  /** The refusal a run would give; null when READY. */
  reason: SwapRefusalReason | null;
  criteria: CriterionRow[];
  /** Fields the evaluator needed and did not find (dotted paths). */
  missing_fields: string[];
}

/** Criterion 1's minimum shadow duration: the readiness policy's default (policy.ts, frozen for the Dec 1 swap). */
export const MIN_SHADOW_DAYS = DEFAULT_SHADOW_MIN_DAYS;
export const MAX_LAG_P99_MS = 60_000;
export const MIN_CLEAN_RECONCILES = 3;
export const MIN_TOTAL_READS = 10_000;
export const MIN_WRITE_COMPARISONS = 1_000;
export const MIN_VECTOR_RECALL = 0.98;
export const MIN_BENCH_PAIRS = 100;

const DAY_MS = 86_400_000;

type Check = { state: CriterionState; detail: string };

function num(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }

/** Collects missing dotted paths while the criteria read the document. */
class Reader {
  readonly missing: string[] = [];
  constructor(private readonly doc: ShadowStatus | null) {}
  /** The value at `path`, or undefined (recorded as missing) when it is absent or not of the expected kind. */
  get<T>(path: string, ok: (v: unknown) => boolean): T | undefined {
    let cur: unknown = this.doc;
    for (const key of path.split('.')) {
      // Own data properties only: an inherited or accessor key (e.g. __proto__) is never evidence.
      cur = cur !== null && typeof cur === 'object' ? Object.getOwnPropertyDescriptor(cur, key)?.value : undefined;
      if (cur === undefined) break;
    }
    if (cur === undefined || cur === null || !ok(cur)) { if (!this.missing.includes(path)) this.missing.push(path); return undefined; }
    return cur as T;
  }
  n(path: string): number | undefined { return this.get<number>(path, num); }
  b(path: string): boolean | undefined { return this.get<boolean>(path, v => typeof v === 'boolean'); }
  s(path: string): string | undefined { return this.get<string>(path, v => typeof v === 'string' && v.length > 0); }
}

function missingCheck(fields: string[]): Check { return { state: 'missing', detail: `no evidence: ${fields.join(', ')}` }; }

/** Runs `body` and turns any field it found missing into a `missing` row. */
function guarded(r: Reader, body: () => Check): Check {
  const before = r.missing.length;
  const out = body();
  return r.missing.length > before ? missingCheck(r.missing.slice(before)) : out;
}

function shadowDuration(r: Reader, now: Date): Check {
  return guarded(r, () => {
    const started = r.s('epoch_started_at');
    const p99 = r.n('follower.lag_ms_p99_epoch');
    const clean = r.n('reconcile.consecutive_clean_full_passes');
    // Caught-up following needs current evidence too: a document without it never reads as caught up.
    const lag = r.n('follower.lag_ms');
    const queue = r.n('follower.queue_depth');
    const watermark = r.b('follower.coverage_watermark.valid');
    if (started === undefined || p99 === undefined || clean === undefined || lag === undefined || queue === undefined || watermark === undefined) {
      return { state: 'missing', detail: '' };
    }
    const t = Date.parse(started);
    if (!Number.isFinite(t)) return { state: 'fail', detail: `epoch_started_at is not a time: ${started}` };
    const days = (now.getTime() - t) / DAY_MS;
    const fails: string[] = [];
    if (days < MIN_SHADOW_DAYS) fails.push(`${days.toFixed(1)} of ${MIN_SHADOW_DAYS} days in the epoch`);
    if (p99 >= MAX_LAG_P99_MS) fails.push(`follower lag p99 ${p99} ms (needs under ${MAX_LAG_P99_MS})`);
    if (clean < MIN_CLEAN_RECONCILES) fails.push(`${clean} of ${MIN_CLEAN_RECONCILES} consecutive clean reconcile passes`);
    return fails.length
      ? { state: 'fail', detail: fails.join('; ') }
      : { state: 'pass', detail: `${days.toFixed(1)} days, lag p99 ${p99} ms, ${clean} clean reconciles` };
  });
}

function readCoverage(r: Reader): Check {
  return guarded(r, () => {
    const ops = r.get<Array<{ op: string; successful: number; minimum: number }>>('reads.ops', v => Array.isArray(v) && v.length > 0);
    const capMissing = r.n('reads.capability_missing_7d');
    if (ops === undefined || capMissing === undefined) return { state: 'missing', detail: '' };
    const malformed = ops.filter(o => !o || typeof o.op !== 'string' || !num(o.successful) || !num(o.minimum));
    if (malformed.length) return { state: 'missing', detail: `no evidence: reads.ops has ${malformed.length} malformed row(s)` };
    const total = ops.reduce((s, o) => s + o.successful, 0);
    const short = ops.filter(o => o.successful < o.minimum).map(o => `${o.op} ${o.successful}/${o.minimum}`);
    const fails: string[] = [];
    if (total < MIN_TOTAL_READS) fails.push(`${total} of ${MIN_TOTAL_READS} successful reads`);
    if (short.length) fails.push(`under the minimum: ${short.join(', ')}`);
    if (capMissing > 0) fails.push(`${capMissing} capability_missing in the last 7 days`);
    return fails.length ? { state: 'fail', detail: fails.join('; ') } : { state: 'pass', detail: `${total} successful reads over ${ops.length} operation classes` };
  });
}

function zeroCounts(r: Reader, fields: Array<[string, string]>): Check {
  return guarded(r, () => {
    const vals = fields.map(([path, label]) => [r.n(path), label] as const);
    if (vals.some(([v]) => v === undefined)) return { state: 'missing', detail: '' };
    const bad = vals.filter(([v]) => (v as number) > 0).map(([v, label]) => `${v} ${label}`);
    return bad.length ? { state: 'fail', detail: bad.join('; ') } : { state: 'pass', detail: `zero ${fields.map(([, l]) => l).join(', zero ')}` };
  });
}

function searchArms(r: Reader): Check {
  return guarded(r, () => {
    const trigram = r.n('search.trigram_exact_disagreements');
    const ranker = r.get<string>('search.keyword_title.ranker', v => v === 'ts_rank' || v === 'default');
    const recall = r.n('search.vector_recall_at_10');
    const primary = r.n('search.primary_recall_at_10');
    if (trigram === undefined || ranker === undefined || recall === undefined || primary === undefined) return { state: 'missing', detail: '' };
    const fails: string[] = [];
    if (trigram > 0) fails.push(`${trigram} trigram disagreements`);
    if (ranker === 'ts_rank') {
      const d = r.n('search.keyword_title.exact_disagreements');
      if (d === undefined) return { state: 'missing', detail: '' };
      if (d > 0) fails.push(`${d} keyword/title disagreements under ts_rank`);
    } else {
      const e = r.b('search.keyword_title.e1_e2_at_least_both');
      if (e === undefined) return { state: 'missing', detail: '' };
      if (!e) fails.push('default ranker without E1 and E2 at least equal to PGLite and Postgres');
    }
    if (recall < MIN_VECTOR_RECALL) fails.push(`vector recall@10 ${recall} (needs at least ${MIN_VECTOR_RECALL})`);
    if (recall < primary) fails.push(`vector recall@10 ${recall} below the primary's ${primary}`);
    return fails.length ? { state: 'fail', detail: fails.join('; ') } : { state: 'pass', detail: `trigram exact, ${ranker} ranker, recall@10 ${recall}` };
  });
}

function writeComparisons(r: Reader): Check {
  return guarded(r, () => {
    const state = r.s('write_comparisons.state');
    const comparable = r.n('write_comparisons.comparable');
    const unexplained = r.n('write_comparisons.unexplained_difference');
    if (state === undefined || comparable === undefined || unexplained === undefined) return { state: 'missing', detail: '' };
    // A shadow that cannot compare writes never passes (S3 rule: capability_missing refuses, like a missing field).
    if (state === 'capability_missing') return { state: 'missing', detail: 'no evidence: write_comparisons.state is capability_missing' };
    const fails: string[] = [];
    if (comparable < MIN_WRITE_COMPARISONS) fails.push(`${comparable} of ${MIN_WRITE_COMPARISONS} comparable write comparisons`);
    if (unexplained > 0) fails.push(`${unexplained} unexplained differences`);
    return fails.length ? { state: 'fail', detail: fails.join('; ') } : { state: 'pass', detail: `${comparable} comparable, zero unexplained` };
  });
}

function fingerprintsAndAllocators(r: Reader): Check {
  return guarded(r, () => {
    const mismatches = r.n('fingerprints.mismatches');
    const probe = r.get<string>('fingerprints.probe.state', v => v === 'pass' || v === 'fail' || v === 'not_run');
    const allocators = r.b('allocators.verified');
    if (mismatches === undefined || probe === undefined || allocators === undefined) return { state: 'missing', detail: '' };
    if (probe === 'not_run') return { state: 'missing', detail: 'no evidence: fingerprints.probe.state is not_run' };
    const fails: string[] = [];
    if (probe === 'fail') fails.push('the fingerprint probe failed (collation or server semantics differ)');
    if (mismatches > 0) fails.push(`${mismatches} fingerprint mismatches`);
    if (!allocators) fails.push('allocator verification has not passed');
    return fails.length ? { state: 'fail', detail: fails.join('; ') } : { state: 'pass', detail: 'zero fingerprint mismatches, probe passed, allocators verified' };
  });
}

/** Criterion 8: measured and reported, never gating for the opt-in swap (D23). */
function speed(r: Reader): Check {
  const pairs = r.n('bench.pairs');
  const noWorse = r.b('bench.rust_no_worse');
  const margin = r.b('bench.filtered_vector_margin_met');
  const losses = r.get<string[]>('bench.losses', v => Array.isArray(v));
  // Missing speed evidence never blocks; drop it from the missing list so the verdict does not count it.
  for (const p of ['bench.pairs', 'bench.rust_no_worse', 'bench.filtered_vector_margin_met', 'bench.losses']) {
    const i = r.missing.indexOf(p); if (i >= 0) r.missing.splice(i, 1);
  }
  if (pairs === undefined || noWorse === undefined) return { state: 'reported', detail: 'not measured yet (reported, not gating: D23)' };
  // A loss line that says "not measured" is a gap in the evidence, not a slowdown: say "slower" only when a measured loss exists.
  const onlyUnmeasured = !noWorse && !!losses?.length && losses.every(l => / not measured\b/.test(l));
  const parts = [`${pairs} paired samples`, noWorse ? 'Rust no worse on every class' : onlyUnmeasured ? 'Rust not shown to be no worse (rows not measured)' : 'Rust slower on at least one class'];
  if (margin !== undefined) parts.push(margin ? 'filtered vector margin met' : 'filtered vector margin not met');
  if (losses?.length) parts.push(`losses: ${losses.join(', ')}`);
  if (pairs < MIN_BENCH_PAIRS) parts.push(`under ${MIN_BENCH_PAIRS} pairs, inconclusive`);
  return { state: 'reported', detail: `${parts.join('; ')} (reported, not gating: D23)` };
}

function drills(r: Reader): Check {
  return guarded(r, () => {
    const backup = r.b('drills.backup_restore_passed');
    const evals = r.b('drills.eval_gates_e1_e3');
    if (backup === undefined || evals === undefined) return { state: 'missing', detail: '' };
    const fails: string[] = [];
    if (!backup) fails.push('no passed backup and restore drill on the shadow store');
    if (!evals) fails.push('the release does not carry eval gates E1 to E3');
    return fails.length ? { state: 'fail', detail: fails.join('; ') } : { state: 'pass', detail: 'restore drill passed; E1 to E3 carried' };
  });
}

type Eligibility = Check & { reason?: SwapRefusalReason };

function eligibility(r: Reader, manyWritersOk = false): Eligibility {
  const team = r.b('eligibility.team_brain');
  if (team === true) return { state: 'fail', detail: 'a mounted team brain, not a personal brain', reason: 'team_brain' };
  const hosts = r.get<number | null>('eligibility.writer_hosts_7d', v => num(v));
  const unknown = r.n('eligibility.unknown_writer_paths');
  const preview = r.b('eligibility.preview_target');
  if (hosts === undefined || hosts === null || unknown === undefined) {
    return { state: 'missing', detail: 'no durable writer observations for the last 7 days', reason: 'writer_coverage_unknown' };
  }
  // Exactly one observed writer host: zero (or a non-count) is no writer evidence, never "one host".
  if (!Number.isInteger(hosts) || hosts < 1) return { state: 'missing', detail: `no writer host observed in the last 7 days (${hosts})`, reason: 'writer_coverage_unknown' };
  if (hosts > 1 && !manyWritersOk) return { state: 'fail', detail: `${hosts} writer hosts in the last 7 days`, reason: 'multiple_writer_hosts' };
  if (unknown > 0) return { state: 'fail', detail: `${unknown} write path(s) with no observation`, reason: 'writer_coverage_unknown' };
  if (team === undefined || preview === undefined) return { state: 'missing', detail: `no evidence: ${[team === undefined ? 'eligibility.team_brain' : '', preview === undefined ? 'eligibility.preview_target' : ''].filter(Boolean).join(', ')}` };
  if (!preview) return { state: 'fail', detail: 'the shadow host is not on a preview target' };
  if (hosts > 1) return { state: 'pass', detail: `${hosts} writer hosts, accepted: the destination is a served multi-user Rust brain; no unknown write path, a personal brain on a preview target` };
  return { state: 'pass', detail: 'one writer host, no unknown write path, a personal brain on a preview target' };
}

/** Follower not caught up: lag, a queue, or an invalid coverage watermark (S3 rule). */
function followerBehind(doc: ShadowStatus | null): boolean {
  const f = doc?.follower;
  if (!f) return false;
  return (num(f.lag_ms) && f.lag_ms > 0) || (num(f.queue_depth) && f.queue_depth > 0) || f.coverage_watermark?.valid === false;
}

export const CRITERIA: ReadonlyArray<{ n: number; name: string }> = [
  { n: 1, name: 'shadow duration, follower lag and clean reconciles' },
  { n: 2, name: 'read comparison coverage' },
  { n: 3, name: 'no rust_error or unexplained diverged' },
  { n: 4, name: 'search arms agree' },
  { n: 5, name: 'write comparisons' },
  { n: 6, name: 'no privacy_diverged' },
  { n: 7, name: 'fingerprints and allocators' },
  { n: 8, name: 'speed (reported, not gating: D23)' },
  { n: 9, name: 'no panics or child faults' },
  { n: 10, name: 'restore drill and eval gates' },
  { n: 11, name: 'eligibility' },
];

/**
 * Evaluates every criterion against the shadow status. `doc` null means no shadow runs for this brain: every gating
 * criterion is `missing` and the verdict is NOT READY (`no_shadow`). `opts` carries the destination evidence for
 * criterion 11 only; without it, or with the multi-user switch off, the result is what it was before it existed.
 */
export function evaluateReadiness(doc: ShadowStatus | null, now: Date = new Date(), opts?: DestinationOptions): ReadinessVerdict {
  const r = new Reader(doc);
  // Writers on many hosts stop refusing only for a served multi-user Rust destination with the switch on (destination.ts).
  const elig = eligibility(r, destinationAllowsManyWriters(opts));
  const checks: Check[] = [
    shadowDuration(r, now),
    readCoverage(r),
    zeroCounts(r, [['reads.rust_error_unresolved_7d', 'unresolved rust_error'], ['reads.diverged_unexplained_7d', 'unexplained diverged']]),
    searchArms(r),
    writeComparisons(r),
    zeroCounts(r, [['privacy_diverged', 'privacy_diverged']]),
    fingerprintsAndAllocators(r),
    speed(r),
    zeroCounts(r, [['child.panics', 'panics'], ['child.faults', 'child faults']]),
    drills(r),
    elig,
  ];
  // A seeded gap is unfinished evidence: never ready while rows are unseeded (S3 rule).
  const gap = r.n('seed.unseeded_gap_rows_total');
  if (checks[0]!.state === 'pass') {
    if (gap === undefined) checks[0] = missingCheck(['seed.unseeded_gap_rows_total']);
    else if (gap > 0) checks[0] = { state: 'fail', detail: `${gap} unseeded gap rows` };
  }
  // Caught-up following can never be waived: a lagging follower fails criterion 1 whatever its p99 says (S3 rule).
  if (checks[0]!.state === 'pass' && followerBehind(doc)) {
    const f = doc!.follower!;
    checks[0] = { state: 'fail', detail: `the follower is behind: lag ${f.lag_ms ?? 0} ms, queue ${f.queue_depth ?? 0}, coverage watermark ${f.coverage_watermark?.valid === false ? 'invalid' : 'valid'}` };
  }
  const criteria = CRITERIA.map((c, i) => ({ ...c, state: checks[i]!.state, detail: checks[i]!.detail, gating: c.n !== 8 }));
  const ready = criteria.every(c => !c.gating || c.state === 'pass');
  let reason: SwapRefusalReason | null = null;
  if (!ready) {
    if (doc === null) reason = 'no_shadow';
    else if (elig.reason) reason = elig.reason;
    else if (doc?.fingerprints?.probe?.state === 'fail') reason = 'fingerprint_semantics_differ';
    else if (followerBehind(doc)) reason = 'follower_behind';
    else reason = 'not_ready';
  }
  return { verdict: ready ? 'READY' : 'NOT READY', reason, criteria, missing_fields: [...r.missing] };
}
