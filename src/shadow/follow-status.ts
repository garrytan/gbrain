/**
 * The follower's files and the `status --json` fields built from them (shadow follow, plan PR 1).
 *
 *   follower.json          the shadow child's own state: applied rows, lag histograms, queue depth, coverage
 *                          watermark, fingerprint totals, probe and allocator results (all EPOCH totals; the epoch
 *                          is one seed). Written by the child, atomically.
 *   reconcile/passes.jsonl one line per reconcile pass, written by the process that ran it.
 *
 * State words. follower: not_seeded (no seed.json), needs_reseed (a seed written before follow), stopped (shadow mode off, or no live child wrote follower.json
 * in the last minute), invalid (the coverage watermark is invalid), behind (rows are queued or waiting), following.
 * reconcile: never_run, ok (the last pass found nothing to repair), repaired, error.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PENDING_MARKER_STEP, WRITE_CLIENT_LIMIT, WRITE_COVERAGE_LIMIT, WRITE_PGLITE_LIMIT } from '../core/engine-swap/readiness.ts';
import { readEpoch } from './evidence-epoch.ts';
import { readSeedRecord, RESEED_STEPS } from './seed.ts';
import { writeSampleRate, type ShadowState } from './state.ts';
import { readFaults } from './ledger.ts';
import { outstandingReceipts, readWriteSnapshot } from './write-compare.ts';

export interface ProbeRecord {
  state: 'pass' | 'fail' | 'not_run'; checked_at: string | null; server_version: string | null; collation: string | null; mismatches: number;
  ctype: string | null; locale_provider: string | null; locale: string | null;
  /** Where the primary's lower() or [[:space:]] differs from PGLite's: first 50 as 'U+XXXX', and the total. */
  differing_code_points: string[]; differing_code_points_total: number;
  /** Corpus sample rows fingerprinting differently from PGLite (first names, never text); stored facts holding a differing code point. */
  corpus_mismatches: number; corpus_mismatch_rows: string[]; facts_with_differing_code_points: number;
  /**
   * Purge tombstones on the primary when code points differ (a count; 0 when none differ): a tombstone keeps only the claim's
   * hash, so the store cannot tell whether a re-saved claim that holds a differing code point would still match it.
   */
  fact_purges_unverifiable?: number;
}
export interface Watermark { valid: boolean; through: string | null; invalidated_reason: string | null }
export interface FollowerFile {
  version: 1;
  /** Written as the seed id; the evidence epoch lives in evidence/epoch.json (evidence-epoch.ts), not here. */
  epoch_id: string;
  /**
   * The evidence epoch the probe, fingerprint totals, allocator result and lag histograms below were counted under
   * (null: none was known; absent: written before the tag). The status reports them only for the current epoch.
   */
  evidence_epoch?: string | null;
  /** The seed this follower state belongs to; the Rust store's calls and the status match on it. */
  seed_id: string;
  epoch_started_at: string;
  updated_at: string;
  applied_rows: number;
  queue_depth: number;
  /** Age of the oldest committed write not yet applied; 0 when nothing waits. */
  lag_ms: number;
  last_seq: number | null;
  watermark: Watermark;
  /** Apply lag histograms: log2 buckets (bucket i holds lags below 2^i ms), the epoch and one per hour (last 25). */
  lag: { epoch: number[]; hours: Record<string, number[]> };
  fingerprints: { checked_rows: number; mismatches: number };
  probe: ProbeRecord;
  allocators: { verified: boolean; checked_at: string | null };
  /**
   * Names the unbroken run of owner sessions this file belongs to: a new one is drawn whenever an owner session cannot
   * prove it continues the one before it (follow-child.ts). A reconcile pass left half done resumes only under the same one.
   */
  continuity?: string;
  /** What a clean close left for the next owner session (follow-child.ts); trusted only while `seal.at` equals `updated_at`. */
  seal?: FollowerSeal;
  /** The last seal decision and its reason code (status `follower.seal`): every refusal is named, none is silent. */
  seal_outcome?: SealOutcome;
}

/** The reason PGLite never takes a seal over: it has no proof of database continuity between sessions (seal.ts). */
export const PGLITE_NO_DB_CONTINUITY = 'pglite_no_db_continuity';

/**
 * The last seal decision: `sealed` / `not_sealed` at a close, `taken` / `refused` at the next owner's start, `confirmed`
 * / `refused` once its serving process checked the primary. `reason` is null for sealed, taken and confirmed.
 */
export interface SealOutcome { outcome: 'sealed' | 'not_sealed' | 'taken' | 'confirmed' | 'refused'; reason: string | null; at: string }

/**
 * Written by an owner child when its serving process closed cleanly: every write it was handed is applied or held as an
 * obligation below, and nothing was left unread in follower-invalidations.jsonl. The next owner session takes the
 * obligations over instead of starting from a full one, after the checks in follow-child.ts `takeSeal` and seal.ts.
 */
export interface FollowerSeal {
  version: 1;
  /** Equal to the file's `updated_at` when written: any later write of the file by anything else breaks the seal. */
  at: string;
  continuity: string;
  /** Size of follower-invalidations.jsonl at the seal: a line appended after it means a write this seal never saw. */
  foreign_size: number;
  /** The obligations (follow-child.ts `fullAt` and `dirty`) and the watermark at the seal. */
  full_at: number | null;
  dirty: Record<string, number>;
  watermark: Watermark;
  /** state.json `started_at` at the seal: a stop and start in between breaks it. */
  state_started_at: string | null;
  evidence_epoch: string | null;
  /** The primary's clock at the seal (Postgres with writer hooks; null on PGLite): seal.ts checks for writers after it. */
  db_at: string | null;
}

export interface PassRecord {
  id: string;
  kind: 'full' | 'dirty';
  started_at: string;
  finished_at: string;
  repaired_rows: number;
  repaired_by_relation: Record<string, number>;
  /** Repaired rows found while the watermark claimed coverage through the pass's snapshot. */
  follower_misses: number;
  nonterminal_refresh_rows?: number; // full passes: primary refresh rows a swap must drain first
  error?: string;
  /** The evidence epoch current when the pass finished; the status counts only passes of the current epoch. */
  epoch_id?: string;
}

export const FRESH_FOLLOWER_MS = 60_000;
export const NIGHTLY_MS = 24 * 3_600_000;
export const NOT_RUN_PROBE: ProbeRecord = {
  state: 'not_run', checked_at: null, server_version: null, collation: null, mismatches: 0, ctype: null, locale_provider: null, locale: null,
  differing_code_points: [], differing_code_points_total: 0, corpus_mismatches: 0, corpus_mismatch_rows: [], facts_with_differing_code_points: 0,
};

export const lagBucket = (ms: number): number => (ms < 1 ? 0 : Math.min(30, Math.floor(Math.log2(ms)) + 1));

/** The 99th percentile as the upper bound (ms) of the log2 bucket that holds it; null without samples. */
export function lagP99(counts: readonly number[]): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    seen += counts[i] ?? 0;
    if (seen >= Math.ceil(total * 0.99)) return 2 ** i;
  }
  return null;
}

export const followerPath = (dir: string): string => join(dir, 'follower.json');
export const passesPath = (dir: string): string => join(dir, 'reconcile', 'passes.jsonl');

export function readFollowerFile(dir: string): FollowerFile | null {
  // A file written before `seed_id` existed named the seed in `epoch_id`.
  try { const parsed = JSON.parse(readFileSync(followerPath(dir), 'utf8')) as FollowerFile; return parsed?.version === 1 ? { ...parsed, seed_id: parsed.seed_id ?? parsed.epoch_id } : null; } catch { return null; }
}

export function writeFollowerFile(dir: string, file: FollowerFile): void {
  const tmp = `${followerPath(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file) + '\n', { mode: 0o600 });
  renameSync(tmp, followerPath(dir));
}

/** Appends a pass record once: a record whose pass id is already in the log is not appended again (one scan, one count). */
export function appendPass(dir: string, pass: PassRecord): void {
  mkdirSync(join(dir, 'reconcile'), { recursive: true, mode: 0o700 });
  if (readPasses(dir).some((p) => p.id === pass.id)) return;
  const epoch_id = pass.epoch_id ?? readEpoch(dir)?.epoch_id;
  appendFileSync(passesPath(dir), JSON.stringify(epoch_id ? { ...pass, epoch_id } : pass) + '\n', { mode: 0o600 });
}

export function readPasses(dir: string): PassRecord[] {
  if (!existsSync(passesPath(dir))) return [];
  // A torn last line is skipped.
  return readFileSync(passesPath(dir), 'utf8').split('\n').flatMap((line) => { try { return line ? [JSON.parse(line) as PassRecord] : []; } catch { return []; } });
}

export interface FollowStatus {
  epoch_id: string | null;
  epoch_started_at: string | null;
  follower: {
    state: 'not_seeded' | 'needs_reseed' | 'stopped' | 'invalid' | 'behind' | 'following'; action: string | null; lag_ms: number | null; lag_ms_p99_24h: number | null;
    lag_ms_p99_epoch: number | null; queue_depth: number; applied_rows: number; coverage_watermark: Watermark;
    /** The last seal decision (follower.json `seal_outcome`), when one was made. */
    seal?: SealOutcome;
  };
  reconcile: {
    state: 'never_run' | 'ok' | 'repaired' | 'error';
    last_pass: Omit<PassRecord, 'error'> | null;
    consecutive_clean_full_passes: number;
    /** When the newest full pass of the epoch finished, if it was clean; null otherwise. Criterion 1 needs it under 24 h old. */
    last_clean_full_pass_at: string | null;
    next_full_pass_due: string | null;
  };
  /**
   * Page and link write comparisons only (write-compare.ts). `capability_missing` until one comparison has produced a verdict (`comparable` or
   * `unexplained_difference`) and while any replay has no verdict written (`unresolved_replays`); `measured` after. `capability_missing` counts sampled writes of every other family, by family.
   */
  write_comparisons: {
    state: 'capability_missing' | 'measured'; sample_rate: number | null; comparable: number; unexplained_difference: number; uncomparable: number; capability_missing: number;
    unresolved_replays?: number; capability_missing_by_family?: Record<string, number>; uncomparable_by_reason?: Record<string, number>;
    /** Sent counts (receipts) still on disk and counted in `unresolved_replays`, by file name (at most 8). One that names another epoch counts too. */
    outstanding_receipts?: string[];
    /** `write_samples_unrecorded` faults of this epoch that name a sample count no file holds (`sent_count n=`, `no_epoch n=`), counted in `unresolved_replays`: no evidence for the rest of the epoch. Only an older writer writes them. */
    unrecorded_sample_faults?: number;
    /** Paths of pending markers (`write-pending.<session>.json`, at most 8): the serving process could not make an owed record durable, so the count is closed (no evidence) until an operator does the step status names. Each also counts once in `unresolved_replays`. */
    pending_markers?: string[];
    /** Sessions whose owed samples (`write-owed.<session>.json`) are not all settled yet, or whose owed file cannot be read, by file name (at most 8); each counts once in `unresolved_replays`. A session that owes nothing more blocks nothing. */
    outstanding_sessions?: string[];
    /** Lost lines of this epoch that name no session (an older writer's) were folded: their obligation is unknown, so there is no evidence for the rest of the epoch (counted in `unresolved_replays`). */
    legacy_lines?: number;
    /** Write windows a crash of the serving process lost (`write_window_lost`): the samples they held are of unknown number, booked as one loss each and never compared or counted toward the write bar. State stays `capability_missing` for the rest of the epoch. */
    write_windows_lost?: number;
  };
  fingerprints: { checked_rows: number; mismatches: number; probe: ProbeRecord };
  seed: { seed_id: string | null; finished_at: string | null; unseeded_gap_rows_total: number | null };
  allocators: { verified: boolean; checked_at: string | null };
  primary_refreshes: { nonterminal_rows: number | null; checked_at: string | null };
}

/** The follower, reconcile, write-comparison, fingerprint, seed and allocator fields of `status --json`. */
export function buildFollowStatus(dir: string, state: ShadowState | null, now: Date = new Date()): FollowStatus {
  const seed = readSeedRecord(dir);
  const file = seed ? readFollowerFile(dir) : null;
  const live = file && file.seed_id === seed?.seed_id ? file : null;
  // The status's epoch is the evidence epoch (evidence-epoch.ts), not the seed; null until a child has opened one.
  const epoch = readEpoch(dir);
  // Readiness inputs count only under the current evidence epoch: the follower's probe, fingerprint totals, allocator result
  // and lag histograms must be tagged with it, and a reconcile pass must have started and finished in it. With no epoch
  // yet nothing is filtered (the status carries no epoch_id, so readiness reads it as missing).
  const counted = live && (!epoch || live.evidence_epoch === epoch.epoch_id) ? live : null;
  // The tally, then the lost lines it has not folded, then the owed files, then the tally's identity again (write-compare.ts readWriteSnapshot): a settled sample can only hide an unsettled one if the owed files are read first.
  const snapshot = readWriteSnapshot(dir, epoch?.epoch_id ?? null);
  const writes = snapshot.writes;
  const receipts = outstandingReceipts(dir, epoch?.epoch_id ?? null); // a sent count still on disk (a leftover, one that cannot be read, one that names another epoch) is a deficit nobody has recorded: no evidence
  // A sample count only a fault line names (a command that could not publish its sent count, a client worker that could not write its count down) is a deficit nobody recorded: it blocks measured for the rest of this epoch (a new epoch clears it), even if the count was written down afterwards.
  const unrecorded = epoch ? readFaults(dir, Infinity).filter((f) => f.kind === 'write_samples_unrecorded' && /^(sent_count|no_epoch) n=/.test(f.detail) && (f.epoch_id === epoch.epoch_id || (f.epoch_id === undefined && Date.parse(f.ts) >= Date.parse(epoch.started_at)))).length : 0;
  const legacy = writes?.legacy_lines ?? 0;
  const windowsLost = Math.max(writes?.uncomparable_by_reason?.write_window_lost ?? 0, snapshot.windowFiles); // windows a crash lost, of unknown size: no evidence for the rest of this epoch (not in `unresolved`: nothing will ever settle them, so the swap's wait must not wait for them)
  const pendingMarkers = snapshot.outstanding.filter((n) => /^write-pending\.[A-Za-z0-9_-]+\.json$/.test(n)).map((n) => join(dir, n)); // by path: the operator step names the file
  const unresolved = (writes?.in_flight.length ?? 0) + snapshot.unfolded + receipts.length + unrecorded + snapshot.outstanding.length + (snapshot.unstable ? 1 : 0) + legacy; // a lost sample no tally has taken yet reads as no evidence, like a replay with no verdict
  const everyPass = readPasses(dir);
  const passes = epoch ? everyPass.filter((p) => p.epoch_id === epoch.epoch_id && Date.parse(p.started_at) >= Date.parse(epoch.started_at)) : everyPass;
  const last = passes.at(-1) ?? null;
  const fulls = passes.filter((p) => p.kind === 'full');
  let clean = 0;
  for (let i = fulls.length - 1; i >= 0 && fulls[i]!.repaired_rows === 0 && !fulls[i]!.error; i--) clean++;
  const hours = Object.entries(counted?.lag.hours ?? {}).filter(([h]) => Number(h) >= Math.floor(now.getTime() / 3_600_000) - 24);
  const last24: number[] = [];
  for (const [, counts] of hours) counts.forEach((n, i) => { last24[i] = (last24[i] ?? 0) + n; });
  const fresh = live !== null && now.getTime() - Date.parse(live.updated_at) < FRESH_FOLLOWER_MS;
  const watermark = live?.watermark ?? { valid: false, through: null, invalidated_reason: seed ? 'not_started' : 'not_seeded' };
  const queue = live?.queue_depth ?? 0;
  let followerState: FollowStatus['follower']['state'] = 'following';
  if (!seed) followerState = 'not_seeded';
  else if (seed.digests !== true) followerState = 'needs_reseed';
  else if (!state?.enabled || !fresh) followerState = 'stopped';
  else if (!watermark.valid) followerState = 'invalid';
  else if (queue > 0 || (live?.lag_ms ?? 0) > 0) followerState = 'behind';
  const lastFull = fulls.at(-1);
  const lastFullEver = everyPass.filter((p) => p.kind === 'full').at(-1); // the primary's refresh rows are not epoch evidence
  const { error, nonterminal_refresh_rows: _refreshes, ...lastPass } = last ?? ({} as PassRecord);
  return {
    epoch_id: epoch?.epoch_id ?? null,
    epoch_started_at: epoch?.started_at ?? null,
    follower: {
      state: followerState, action: followerState === 'needs_reseed' ? RESEED_STEPS : null, lag_ms: live ? live.lag_ms : null, lag_ms_p99_24h: lagP99(last24), lag_ms_p99_epoch: lagP99(counted?.lag.epoch ?? []),
      queue_depth: queue, applied_rows: live?.applied_rows ?? 0, coverage_watermark: watermark,
      ...(live?.seal_outcome ? { seal: live.seal_outcome } : {}),
    },
    reconcile: {
      state: !last ? 'never_run' : error ? 'error' : last.repaired_rows > 0 ? 'repaired' : 'ok',
      last_pass: last ? lastPass : null,
      consecutive_clean_full_passes: clean,
      last_clean_full_pass_at: clean > 0 ? lastFull!.finished_at : null,
      next_full_pass_due: lastFull ? new Date(Date.parse(lastFull.finished_at) + NIGHTLY_MS).toISOString() : null,
    },
    write_comparisons: {
      state: writes && !unresolved && !windowsLost && writes.comparable + writes.unexplained_difference > 0 ? 'measured' : 'capability_missing', sample_rate: state ? writeSampleRate(state) : null,
      comparable: writes?.comparable ?? 0, unexplained_difference: writes?.unexplained_difference ?? 0, uncomparable: writes?.uncomparable ?? 0, capability_missing: writes?.capability_missing ?? 0,
      ...(unresolved ? { unresolved_replays: unresolved } : {}),
      ...(receipts.length ? { outstanding_receipts: receipts.slice(0, 8) } : {}),
      ...(unrecorded ? { unrecorded_sample_faults: unrecorded } : {}),
      ...(snapshot.outstanding.length ? { outstanding_sessions: snapshot.outstanding.slice(0, 8) } : {}),
      ...(pendingMarkers.length ? { pending_markers: pendingMarkers.slice(0, 8) } : {}),
      ...(legacy ? { legacy_lines: legacy } : {}),
      ...(windowsLost ? { write_windows_lost: windowsLost } : {}),
      ...(writes ? { capability_missing_by_family: writes.capability_missing_by_family, uncomparable_by_reason: writes.uncomparable_by_reason } : {}),
    },
    fingerprints: { checked_rows: counted?.fingerprints.checked_rows ?? 0, mismatches: counted?.fingerprints.mismatches ?? 0, probe: counted?.probe ?? NOT_RUN_PROBE },
    seed: { seed_id: seed?.seed_id ?? null, finished_at: seed?.finished_at ?? null, unseeded_gap_rows_total: seed?.unseeded_gap_rows_total ?? null },
    allocators: counted?.allocators ?? { verified: false, checked_at: null },
    primary_refreshes: { nonterminal_rows: lastFullEver?.nonterminal_refresh_rows ?? null, checked_at: lastFullEver?.nonterminal_refresh_rows === undefined ? null : lastFullEver.finished_at },
  };
}

/** A short readable block for the markdown status. */
export function renderFollowStatus(s: FollowStatus): string[] {
  const f = s.follower;
  const w = f.coverage_watermark;
  const lines = [f.action ? `  follower: this brain needs a reseed (its seed was written before follow existed, so nothing is followed): ${f.action}` : `  follower: ${f.state}; applied rows ${f.applied_rows}; queue ${f.queue_depth}; lag ${f.lag_ms ?? 'unknown'} ms (p99 24h ${f.lag_ms_p99_24h ?? '-'}, epoch ${f.lag_ms_p99_epoch ?? '-'})`];
  lines.push(`  coverage watermark: ${w.valid ? `valid through ${w.through ?? '-'}` : `invalid (${w.invalidated_reason ?? 'unknown'})`}`);
  if (f.seal) lines.push(`  seal: ${f.seal.outcome}${f.seal.reason ? ` (${f.seal.reason})` : ''} at ${f.seal.at}`);
  const r = s.reconcile;
  lines.push(`  reconcile: ${r.state}; clean full passes in a row ${r.consecutive_clean_full_passes}; last clean full pass ${r.last_clean_full_pass_at ?? 'none'}; next full pass ${r.next_full_pass_due ?? 'when one runs'}`);
  if (r.last_pass) lines.push(`    last pass ${r.last_pass.kind} ${r.last_pass.finished_at}: repaired ${r.last_pass.repaired_rows}, follower misses ${r.last_pass.follower_misses}`);
  lines.push(`  fingerprints (epoch): checked ${s.fingerprints.checked_rows}, mismatches ${s.fingerprints.mismatches}; probe ${s.fingerprints.probe.state}`);
  const wc = s.write_comparisons;
  const families = Object.entries(wc.capability_missing_by_family ?? {}).map(([name, n]) => `${name} ${n}`).join(', ');
  lines.push(`  allocators: ${s.allocators.verified ? `verified ${s.allocators.checked_at}` : 'not verified'}; write comparisons: ${wc.state}`);
  lines.push(`    writes (epoch): comparable ${wc.comparable}, unexplained ${wc.unexplained_difference}, uncomparable ${wc.uncomparable}; capability_missing ${wc.capability_missing}${families ? ` (by family: ${families})` : ''}${wc.unresolved_replays ? `; ${wc.unresolved_replays} replay(s) with no verdict written yet, so no evidence` : ''}${wc.outstanding_receipts?.length ? `; sent count(s) still on disk: ${wc.outstanding_receipts.join(', ')}` : ''}${wc.outstanding_sessions?.length ? `; owed sample(s) not settled yet: ${wc.outstanding_sessions.join(', ')}` : ''}${wc.pending_markers?.length ? `; pending marker(s) hold the write count closed: ${wc.pending_markers.join(', ')}; ${PENDING_MARKER_STEP}` : ''}${wc.legacy_lines ? '; lost samples with no session named (an older writer), so no evidence for this epoch' : ''}${wc.write_windows_lost ? `; ${wc.write_windows_lost} write window(s) lost in a crash (sample count unknown, never compared or counted toward the write bar), so no evidence for the rest of this epoch` : ''}; ${WRITE_COVERAGE_LIMIT}; ${WRITE_PGLITE_LIMIT}; ${WRITE_CLIENT_LIMIT}`);
  return lines;
}
