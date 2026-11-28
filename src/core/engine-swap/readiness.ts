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
    /** Sampled writes outside the page and link pilot, by family (shadow/write-compare.ts). */
    capability_missing_by_family?: Record<string, number>;
    /** Sessions with an owed sample still unsettled, replays with no verdict and lost samples no tally has taken (shadow/follow-status.ts); the swap check waits for it to be absent. */
    unresolved_replays?: number;
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
  drills?: {
    backup_restore_passed?: boolean;
    eval_gates_e1_e3?: boolean;
    /** Why a half is not a pass (codes from src/shadow/drill-status.ts); printed in the criterion's detail. */
    backup_reason?: string;
    eval_gates_reason?: string;
  };
  eligibility?: {
    /** Writer hosts seen by durable writer observations in the last 7 days; null when no observation table exists. */
    writer_hosts_7d?: number | null;
    unknown_writer_paths?: number;
    /** Observed writers of an older build (no write_protocol, or one below this build's) in the evidence epoch; counted in `unknown_writer_paths`. */
    legacy_write_writers?: number;
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
  /** Criterion 5 only: one line per write type it does not compare, then the named loss. The text report prints them under the row; `detail` is unchanged. */
  lines?: string[];
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

/** What a criterion 5 pass covers, said wherever write comparisons are shown (the shadow status line, this report). */
export const WRITE_COVERAGE_LIMIT = 'a criterion 5 pass covers the pilot page and link writes only';
/** The lane owner's wording for what criterion 5 leaves uncompared; the swap report appends it to the criterion 5 detail. */
export const WRITE_COVERAGE_NAMED = 'Criterion 5 covers the pilot page and link writes (putPage, deletePage, addLink, addLinksBatch, removeLink) only (#10350, #10360, #10382, #10390). These write types are not compared and get named lines in the swap report: chunks, tags, aliases, timeline entries, takes, facts, fact withdrawals, open loops, sources, owner-only marks and the decide store.';
/**
 * The named write types and the `capability_missing_by_family` keys each one reads, in the order of WRITE_COVERAGE_NAMED. A key is the first table of the
 * sampled member (`writeFamily`, src/shadow/write-compare.ts), so a type's line reads only the writes whose first table it is.
 * Fact withdrawals has no key of its own (only `updateSlug` writes them, and it is counted as `pages:updateSlug`), so its line reads that key.
 */
const WRITE_NAMED_TYPES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['chunks', ['content_chunks']],
  ['tags', ['tags']],
  ['aliases', ['page_aliases']],
  ['timeline entries', ['timeline_entries']],
  ['takes', ['takes']],
  ['facts', ['facts']],
  ['open loops', ['open_loops']],
  ['sources', ['sources']],
  ['owner-only marks', ['owner_only_marks']],
  ['decide store', ['decide_state', 'decide_spend', 'decision_receipts', 'decide_calibrations', 'decide_proposals', 'decide_review_proposals', 'decide_review_queue', 'decide_sweep_deferred']],
];
const FACT_WITHDRAWALS_FAMILY = 'pages:updateSlug';
/** A named loss, not a fix: what the sentence above does not say. It is the last line under criterion 5 and the last limit in the guide. */
export const WRITE_COVERAGE_LOSS = 'Named loss: only putPage, deletePage, addLink, addLinksBatch and removeLink are compared, so these other page and link writes are counted capability_missing and are not compared: pages:deletePages, pages:softDeletePage, pages:softDeletePages, pages:restorePage, pages:purgeDeletedPages, pages:updateSlug, pages:refreshPageBody, pages:refreshPageOrigin, pages:updatePageContextualRetrievalState, pages:stripStaleFrontmatterKeys, pages:markPagesExtractedBatch, pages:markPagesAttendanceBlocked, pages:setPageEmbeddingSignature, pages:setChunkerVersion, pages:writeTextProjectionSeal, pages:revertToVersion, pages:setEmotionalWeightBatch, pages:invalidateWithdrawnPages, pages:createSegmentedPageShell, pages:sealSegmentedPage, pages:flipBodyGeneration, links:removeLinksByPagesAndSource, links:replaceDerivedLinks, links:replaceDerivedLinksBatch. A write that touches several tables is counted under its first table only, so the side effects of deletePages, purgeDeletedPages and updateSlug (aliases, open loops, owner-only marks, fact withdrawals) land under pages:* keys, and a type\'s line above reads only the writes whose first table it is.';
/**
 * Named losses of the Rust write path itself, not of the comparison: what a Rust brain does differently after the swap.
 * They follow the coverage loss under criterion 5 and close the guide's limits.
 */
export const RUST_WRITE_LOSSES: readonly string[] = [
  'Named loss: on a Rust brain that another process holds open (a running gbrain serve or any open engine), a gbrain put, remember or import from a second process refuses engine_capability_missing (reason transactions) at write admission, because a transaction does not cross the owner socket; no page is written, though the CLI\'s local writer registration is recorded first. Writes from the process that holds the brain are unaffected.',
  'Named loss: on a Rust brain a write whose process died after it claimed the write and before it committed holds later writes to sources with no owner for its publication lease (365 s by default), because abandoned claims are released at once on PGLite only and dead owners are detected on Postgres only; meanwhile each put ends write_pending (exit 10), and the first write after the lease ends replays the dead write, then the queued ones. Nothing is lost.',
  'Named loss: aged put receipts are not compacted on a Rust brain until the typed member lands; the receipt cleanup pass refuses up front (engine_capability_missing) and the rest of the write upkeep still runs, so receipts stay at their full size past the retention window.',
  'Named loss: embedding vectors on a Rust brain install only into a plain float vector column, and only at the width the store already keeps; half-precision columns and vectors of another width are refused (engine_capability_missing) instead of stored, so such a page stays unembedded.',
  'Named loss: on any brain, preparing the links of one written page reads the whole sources table to find that page\'s source (fetchSource), one read per page, sized by the number of sources; on Postgres that read also runs outside the write\'s preparation deadline. A lookup by source id is a lane E follow-up due Wed Dec 9.',
  'Named loss: on a Rust brain, every page read (get_page) checks for sync holds by reading the state of every source, one after another, and every sync-hold record in the brain before it keeps the ones for that page, so one read costs one store call per source plus one scan of all hold records. A hold lookup keyed by page is a lane E follow-up due Wed Dec 9.',
];
/** And on which brains: a PGLite brain's single connection cannot bound the read a sampled write waits for, so it samples no writes and criterion 5 stays missing. */
export const WRITE_PGLITE_LIMIT = 'PGLite brains record no write comparisons';
/** And by whom: only the shadow child that owns the Rust store records; a client child adds no evidence and can never make criterion 5 pass. */
export const WRITE_CLIENT_LIMIT = 'client shadow children record no write comparisons';

/** And at what load: the child replays one sample at a time, so a brain that writes faster than it replays never has all its samples settled. */
export const WRITE_SETTLE_LIMIT = 'the child keeps up only below ~19 samples/s on this VM; a brain that writes faster has no moment with all samples settled, so the swap check refuses';
/** What criterion 5 says when the swap check waited 60 s (`SWAP_SETTLE_WAIT_MS`, plan.ts) and never read a moment with every sample settled. */
export const BRAIN_BUSY = 'brain busy: no 60 s lull with all samples settled; retry when idle';

const DAY_MS = 86_400_000;

type Check = { state: CriterionState; detail: string; lines?: string[] };

function num(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }

/** Collects missing dotted paths while the criteria read the document. */
class Reader {
  readonly missing: string[] = [];
  constructor(private readonly doc: ShadowStatus | null) {}
  /** The value at `path`, or undefined (recorded as missing) when it is absent or not of the expected kind. */
  get<T>(path: string, ok: (v: unknown) => boolean): T | undefined {
    const cur = this.peek<unknown>(path);
    if (cur === undefined || cur === null || !ok(cur)) { if (!this.missing.includes(path)) this.missing.push(path); return undefined; }
    return cur as T;
  }
  /** The value at `path` or undefined, never recorded as missing (a field that only adds detail). */
  peek<T>(path: string): T | undefined {
    let cur: unknown = this.doc;
    for (const key of path.split('.')) {
      // Own data properties only: an inherited or accessor key (e.g. __proto__) is never evidence.
      cur = cur !== null && typeof cur === 'object' ? Object.getOwnPropertyDescriptor(cur, key)?.value : undefined;
      if (cur === undefined) break;
    }
    return cur as T | undefined;
  }
  n(path: string): number | undefined { return this.get<number>(path, num); }
  b(path: string): boolean | undefined { return this.get<boolean>(path, v => typeof v === 'boolean'); }
  s(path: string): string | undefined { return this.get<string>(path, v => typeof v === 'string' && v.length > 0); }
  /** An optional text field: its value, or undefined without recording it as missing. */
  optional(path: string): string | undefined {
    let cur: unknown = this.doc;
    for (const key of path.split('.')) cur = cur !== null && typeof cur === 'object' ? Object.getOwnPropertyDescriptor(cur, key)?.value : undefined;
    return typeof cur === 'string' ? cur : undefined;
  }
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

/** The per-type lines for criterion 5: each named type with its sampled count, or "not sampled"; then every other sampled key; then the named losses. */
function uncoveredWriteLines(byFamily: Record<string, unknown>): string[] {
  const count = (k: string): number => { const n = byFamily[k]; return num(n) && n > 0 ? n : 0; };
  const named = new Set(WRITE_NAMED_TYPES.flatMap(([, keys]) => keys));
  const lines = WRITE_NAMED_TYPES.map(([type, keys]) => {
    const seen = keys.filter(count).map((k) => `${k} ${count(k)}`);
    return seen.length ? `${type}: sampled ${keys.reduce((n, k) => n + count(k), 0)} (${seen.join(', ')})` : `${type}: not sampled`;
  });
  lines.splice(6, 0, `fact withdrawals: not sampled separately (counted under ${FACT_WITHDRAWALS_FAMILY} ${count(FACT_WITHDRAWALS_FAMILY)})`);
  const other = Object.keys(byFamily).filter((k) => !named.has(k) && count(k)).map((k) => `${k} ${count(k)}`);
  return [...lines, `other write families sampled: ${other.length ? other.join(', ') : 'none'}`, WRITE_COVERAGE_LOSS, ...RUST_WRITE_LOSSES];
}

function writeComparisons(r: Reader): Check {
  const out = guarded(r, () => {
    const state = r.s('write_comparisons.state');
    const comparable = r.n('write_comparisons.comparable');
    const unexplained = r.n('write_comparisons.unexplained_difference');
    if (state === undefined || comparable === undefined || unexplained === undefined) return { state: 'missing', detail: '' };
    // A shadow that cannot compare writes never passes (S3 rule: capability_missing refuses, like a missing field).
    if (state === 'capability_missing') {
      const unsettled = r.peek<number>('write_comparisons.unresolved_replays');
      if (num(unsettled) && unsettled > 0) return { state: 'missing', detail: BRAIN_BUSY }; // the swap check already waited for a lull (plan.ts)
      return { state: 'missing', detail: 'no evidence: write_comparisons.state is capability_missing' };
    }
    const fails: string[] = [];
    if (comparable < MIN_WRITE_COMPARISONS) fails.push(`${comparable} of ${MIN_WRITE_COMPARISONS} comparable write comparisons`);
    if (unexplained > 0) fails.push(`${unexplained} unexplained differences`);
    return fails.length ? { state: 'fail', detail: fails.join('; ') } : { state: 'pass', detail: `${comparable} comparable, zero unexplained` };
  });
  // The coverage limit rides on every outcome. Only page and link writes are compared; every other write family is capability_missing.
  const byFamily = r.peek<Record<string, number>>('write_comparisons.capability_missing_by_family') ?? {};
  const named = Object.entries(byFamily).filter(([, n]) => num(n) && n > 0).map(([f, n]) => `${f} ${n}`);
  const limit = `${WRITE_COVERAGE_LIMIT}; ${WRITE_PGLITE_LIMIT}; ${WRITE_CLIENT_LIMIT}; every other write family is capability_missing${named.length ? ` (sampled so far: ${named.join(', ')})` : ''}; ${WRITE_SETTLE_LIMIT}; ${WRITE_COVERAGE_NAMED}`;
  return { ...out, detail: out.detail ? `${out.detail}; ${limit}` : limit, lines: uncoveredWriteLines(typeof byFamily === 'object' && byFamily !== null ? byFamily : {}) };
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

/** Where the eval half can first pass: the FINAL file for the Nov 26 tag lands about two days after the tag. */
const EVAL_GATES_TIMING = 'it can first pass about Sat Nov 28 (the final eval file lands about 2 days after the Nov 26 tag), 3 days before Dec 1';

function drills(r: Reader): Check {
  return guarded(r, () => {
    const backup = r.b('drills.backup_restore_passed');
    const evals = r.b('drills.eval_gates_e1_e3');
    if (backup === undefined || evals === undefined) return { state: 'missing', detail: '' };
    const fails: string[] = [];
    const why = (reason: string | undefined): string => (reason && /^[a-z0-9_:., -]{1,200}$/i.test(reason) ? ` (${reason})` : '');
    const backupReason = r.optional('drills.backup_reason');
    const evalsReason = r.optional('drills.eval_gates_reason');
    if (!backup) fails.push(`no passed backup and restore drill on the shadow store${why(backupReason)}`);
    if (!evals) fails.push(`the release does not carry eval gates E1 to E3${why(evalsReason)}${evalsReason === 'eval_gates_missing' ? `; ${EVAL_GATES_TIMING}` : ''}`);
    return fails.length ? { state: 'fail', detail: fails.join('; ') } : { state: 'pass', detail: 'restore drill passed; E1 to E3 carried' };
  });
}

type Eligibility = Check & { reason?: SwapRefusalReason };

function eligibility(r: Reader): Eligibility {
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
  if (hosts > 1) return { state: 'fail', detail: `${hosts} writer hosts in the last 7 days`, reason: 'multiple_writer_hosts' };
  if (unknown > 0) {
    const legacy = r.peek<number>('eligibility.legacy_write_writers');
    return { state: 'fail', detail: `${unknown} write path(s) with no observation${num(legacy) && legacy > 0 ? ` (${legacy} observed writer(s) of an older build that keeps no per-session write-sample record: no write_protocol 2)` : ''}`, reason: 'writer_coverage_unknown' };
  }
  if (team === undefined || preview === undefined) return { state: 'missing', detail: `no evidence: ${[team === undefined ? 'eligibility.team_brain' : '', preview === undefined ? 'eligibility.preview_target' : ''].filter(Boolean).join(', ')}` };
  if (!preview) return { state: 'fail', detail: 'the shadow host is not on a preview target' };
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
 * criterion is `missing` and the verdict is NOT READY (`no_shadow`).
 */
export function evaluateReadiness(doc: ShadowStatus | null, now: Date = new Date()): ReadinessVerdict {
  const r = new Reader(doc);
  const elig = eligibility(r);
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
  const criteria = CRITERIA.map((c, i) => ({ ...c, state: checks[i]!.state, detail: checks[i]!.detail, gating: c.n !== 8, ...(checks[i]!.lines ? { lines: checks[i]!.lines } : {}) }));
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
