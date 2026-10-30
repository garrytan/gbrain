/**
 * #6712 PR 4b (design v3.2 §3.4): the pass row of a managed source and the rows that live beside it. Kept free of heavy
 * imports: doctor, status, the lease, compaction and GC read it without loading the pass.
 *
 * - `managed-sync-pass`, fingerprint `<source>:<incarnation>`: one row per incarnation. `obligations` are what the next
 *   pass must honor (baseline, episode, cost, the converged state, mismatch and not-converged streaks, page faults);
 *   `telemetry` is the newest pass's progress and ending. Written at pin, per batch and at the stamp, each time under
 *   `assertDrainLease`; after the pin only `WHERE lease_token = $token`, so a pass that lost the lease writes nothing.
 * - `sync-origin-deleted`, fingerprint `<source>:<incarnation>:<origin>`: a deletion marker (design §2.5).
 * - `sync-deletes-withheld`, fingerprint `<source>:<incarnation>`: the mass-delete trip (design §2.6).
 * - `sync-pass-cost`, fingerprint `<source>:<incarnation>:<episode_or_pass_id>:<group_id>`: one cost reservation (design §7).
 *
 * Every value carries `source_id` and `incarnation`, so the checkpoint GC (`op-checkpoint.ts`) keeps the rows of a live
 * incarnation with the same join it uses for `sync-hold`.
 */
import type { BrainEngine } from '../engine.ts';

export const MANAGED_SYNC_PASS_OP = 'managed-sync-pass';
export const SYNC_ORIGIN_DELETED_OP = 'sync-origin-deleted';
export const SYNC_DELETES_WITHHELD_OP = 'sync-deletes-withheld';
export const SYNC_PASS_COST_OP = 'sync-pass-cost';
/** The ops of live-incarnation rows the checkpoint GC must keep (design §3.4). */
export const SYNC_PASS_ROW_OPS = [MANAGED_SYNC_PASS_OP, SYNC_ORIGIN_DELETED_OP, SYNC_DELETES_WITHHELD_OP, SYNC_PASS_COST_OP] as const;

/** `open` while the pass runs; the rest are its ending (`DrainOutcome` plus the idle `up_to_date`). */
export type PassOutcome = 'open' | 'synced' | 'up_to_date' | 'resumable' | 'blocked';
export type PassKind = 'idle' | 'hold_only' | 'full';
/** #6712 PR 4b (design v3.2 §9): a live pass's `SyncResult.reason` endings. `selection_scoped` rides a converged scoped pass (`synced`). */
export type PassResultReason = 'not_converged' | 'admission_paused' | 'reconcile_host_required' | 'grant_scope' | 'reconcile_read_incomplete' | 'selection_scoped';
/** #6712 PR 4b: `SyncResult.pass`, the live pass that produced a sync result (non-company managed sources; sync-pass-run.ts). */
export interface PassResultSummary { pass_id: string; kind: PassKind; round: number; outcome: string; stop_reason: string | null; candidates: number; settled: number;
  remaining: number; not_converged_streak: number }

/** What a pass syncs (design §6): an episode stores it, the configured one stamps `last_commit`. */
export interface SyncSelection { exclude: string[]; includeHidden: string[]; strategy: string | null; srcSubpath: string | null; mode: 'committed' | 'working' }

export interface PassEpisode {
  opened_at: string;
  /** The `--full` that opened it (its pass id), absent for an episode a legacy cursor seeded. */
  full_id?: string;
  selection: SyncSelection;
  inherited: { noEmbed: boolean; noExtract: boolean; noSchemaPack: boolean; from: 'flag' | 'legacy_cursor' };
}

export interface PassConverged {
  target: string;
  at: string;
  /** The highest request `sequence` of the worktree the stamp saw (text: a bigint). */
  request_hwm: string;
  /** Requests and Git effects open on settled paths at the stamp (design §2.2), at most `OPEN_AT_STAMP_CAP`; null when the cap overflowed (no idle). */
  open_at_stamp: string[] | null;
  /**
   * #6712 PR 4b: the write ids of the writeback imports whose Git effect a stamp recorded open (the folded stamp's own, and
   * any an earlier stamp carried that has not committed). Until each effect commits the source is not idle; absent: none.
   */
  writeback?: string[];
  parser_fp: string;
  pack: string | null;
  selection_fp: string;
  last_full_at: string;
  passes_since_full: number;
}

export interface ManagedSyncPassValue {
  source_id: string;
  incarnation: string;
  lease_token: string;
  obligations: {
    baseline_commit: string | null;
    episode?: PassEpisode;
    cost?: { approved_usd: number | null; reserved_usd: number };
    converged?: PassConverged;
    mismatch: Record<string, { level: string | null; streak: number }>;
    not_converged_streak: number;
    /** #7355: at this pass's pin, how many passes in a row before it never ended (their row was left `open`: a pass the drain's governor abandoned, or a killed process). Status counts it only while this pass's row is open. */
    abandoned_streak?: number;
    /** When the current run of unhealthy endings (`blocked`, `not_converged`) began; kept across them, cleared at `synced`/`up_to_date`. The §3.7 readers age a stuck source from it. */
    stuck_since?: string | null;
    faults: Record<string, { level: string | null; class: string; attempts: number }>;
    /**
     * #6712 PR 4b (design §2.7): when the incarnation's first full sweep reached every `legacy_unverified` page. Each pass sweeps
     * at most 500, from `cursor` (#7189: the last path a committed slice screened), so a stopped pass's next one resumes.
     */
    legacy_sweep?: { first_full_at?: string; cursor?: string };
    /** #6712 PR 4b (design §2.7 (b1)): when the incarnation's legacy markers were written; until then each pass's first round writes them (idempotent). */
    legacy_markers_at?: string;
    /** #6712 PR 4b (design §2.6): the set hash of a withheld mass delete; with the env valve set the next tick runs a full round to apply it. */
    deletes_withheld?: string | null;
    /**
     * #6694 on the pass: the slug-root mode a subdirectory source's pass admitted pages under before a stamp published it. Later
     * passes read under it, so a pin changed meanwhile is refused `slug_root_mode_mismatch` at the stamp instead of importing the
     * same files again under the other mode's slugs. A configured stamp clears it; keeping the new pin retires it
     * (`gbrain repair managed-sync-orphans`, `slug_mode_refused`).
     */
    slug_mode?: 'git-root' | 'source-root';
    /** #6712 PR 4b: the page requests (row ids) passes left open when they stopped; the next pass reports each that commits as its import (sync-pass-carried.ts). */
    pending_requests?: string[];
    /** #6712 PR 3 (L7) on the pass: the page request a blocked pass stopped on, which the next pass replays while what refused it is unchanged. */
    blocked?: { request_id: string; pass_id: string };
  };
  telemetry: {
    pass_id: string;
    target: string;
    started_at: string;
    ended_at: string | null;
    kind: PassKind;
    round: number;
    outcome: PassOutcome;
    /** A `DrainStopReason` or a status reason (`not_converged`, `admission_paused`, ...); null while open or synced. */
    stop_reason: string | null;
    candidates: number;
    settled: number;
    /** `|C_k| − |S|` of the newest round; what the movement readers count down. */
    remaining: number;
    counts: Record<string, number>;
    duration_ms: number | null;
    timings_ms: Record<string, number>;
    /** #6712 PR 4b (design §9): the newest round's classes (`{count, action}`) and level summary, for `sync status`'s live `convergence`. */
    classes?: Record<string, { count: number; action: 'none' | 'owner' | 'repair' }>;
    summary?: PassRoundSummary;
  };
}

/** What `sync status`'s live `convergence` reads of the newest round besides its classes (design §9). */
export interface PassRoundSummary {
  db_ahead: { pending: number; db_only: number; unproven: number; by_prefix: Record<string, number> };
  full_skipped_db_ahead: number;
  legacy_unverified: number;
  legacy_pageless: number;
}

export const OPEN_AT_STAMP_CAP = 256;
/** A settle mismatch at one `(path, level)` becomes a hold after this many consecutive passes (design §3.1). */
export const SETTLE_MISMATCH_STREAK = 3;
/** Consecutive `not_converged` passes after which `fix.next` becomes `report` (design §3.1, DX R9). */
export const NOT_CONVERGED_REPORT_STREAK = 3;
/** #7355: passes in a row that never ended (the newest counted once its row has been quiet for ABANDONED_QUIET_MS) before status stops sending the plain sync. */
export const ABANDONED_REPORT_STREAK = 2;
/** The drain's in-pass no-progress window: an open row quiet this long belongs to no live pass. */
export const ABANDONED_QUIET_MS = 5 * 60_000;

export const passFingerprint = (sourceId: string, incarnation: string) => `${sourceId}:${incarnation}`;

export interface PassRow { value: ManagedSyncPassValue; updated_at: string }

type Exec = Pick<BrainEngine, 'executeRaw'>;
const iso = (value: Date | string) => new Date(value).toISOString();

/** The pass row of one incarnation, or null when no pass has run on it. */
export async function readPassRow(engine: Exec, sourceId: string, incarnation: string): Promise<PassRow | null> {
  const [row] = await engine.executeRaw<{ value: ManagedSyncPassValue | null; updated_at: Date | string }>(
    'SELECT completed_keys->0 AS value, updated_at FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [MANAGED_SYNC_PASS_OP, passFingerprint(sourceId, incarnation)]);
  return row?.value ? { value: row.value, updated_at: iso(row.updated_at) } : null;
}

/** The pass rows of the sources' live incarnations (all sources when `sourceIds` is omitted), keyed by source id. */
export async function readLivePassRows(engine: Exec, sourceIds?: readonly string[]): Promise<Map<string, PassRow>> {
  const rows = await engine.executeRaw<{ source_id: string; value: ManagedSyncPassValue; updated_at: Date | string }>(
    `SELECT s.id AS source_id, c.completed_keys->0 AS value, c.updated_at FROM sources s
       JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text
      WHERE ($2::text[] IS NULL OR s.id=ANY($2::text[]))`, [MANAGED_SYNC_PASS_OP, sourceIds ? [...sourceIds] : null]);
  return new Map(rows.filter(row => row.value).map(row => [row.source_id, { value: row.value, updated_at: iso(row.updated_at) }]));
}

/**
 * Writes the pass row inside `tx` (the caller has run `assertDrainLease` in the same transaction). `pin`: the pass that
 * just took the lease replaces whatever row a former holder left; otherwise the write lands only while the row still
 * carries `leaseToken`. Returns false when it did not land (another pass pinned since). `clock`: `telemetry.started_at` is the
 * transaction's clock (`now()`, as an ISO string), so the write needs no earlier read of it. `onlyOpen`: the write lands only
 * on a row still `open`, so a stop after a folded stamp ended the row `synced` never rewrites the stamp's obligations.
 */
export async function writePassRow(tx: Exec, value: ManagedSyncPassValue, opts: { pin?: boolean; clock?: boolean; onlyOpen?: boolean } = {}): Promise<boolean> {
  const json = opts.clock ? `jsonb_set($3::text::jsonb,'{telemetry,started_at}',to_jsonb(to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))` : '$3::text::jsonb';
  const rows = await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,jsonb_build_array(${json}),now())
    ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()
      WHERE ($4::boolean OR op_checkpoints.completed_keys->0->>'lease_token'=$5)
        AND (NOT $6::boolean OR op_checkpoints.completed_keys->0->'telemetry'->>'outcome'='open') RETURNING 1`,
  [MANAGED_SYNC_PASS_OP, passFingerprint(value.source_id, value.incarnation), JSON.stringify(value), opts.pin === true, value.lease_token, opts.onlyOpen === true]);
  return rows.length > 0;
}

/** A pass row's health for the readers of design §3.7 (doctor movement and git-holds, the lease's progress, status). */
export interface PassHealth {
  /** The newest pass ended `blocked`, the not-converged streak is running, a settle mismatch is streaking, or an open pass stopped moving. */
  unhealthy: boolean;
  reason: 'blocked' | 'not_converged' | 'settle_mismatch' | 'open_stalled' | null;
  /** Nothing is left for sync to do at `head`: converged there and the newest pass ended `synced` or `up_to_date`. */
  nothing_pending: boolean;
  remaining: number | null;
  last_progress_at: string;
}

/**
 * One rule for every health reader (design §3.7: a pass that stops `blocked` or `not_converged` on every tick must read
 * unhealthy). `stalledMs`: an open pass whose row has not moved for that long reads `open_stalled`.
 */
export function passHealth(row: PassRow, opts: { head?: string | null; now?: number; stalledMs: number }): PassHealth {
  const { telemetry: t, obligations: o } = row.value;
  const now = opts.now ?? Date.now();
  const mismatch = Object.values(o.mismatch ?? {}).some(entry => entry.streak >= SETTLE_MISMATCH_STREAK - 1);
  const reason: PassHealth['reason'] = t.outcome === 'blocked' ? 'blocked'
    : (o.not_converged_streak ?? 0) > 0 ? 'not_converged'
    : mismatch ? 'settle_mismatch'
    : t.outcome === 'open' && now - Date.parse(row.updated_at) >= opts.stalledMs ? 'open_stalled'
    : null;
  const ended = t.outcome === 'synced' || t.outcome === 'up_to_date';
  return { unhealthy: reason !== null, reason, remaining: ended ? 0 : t.remaining,
    nothing_pending: ended && !!o.converged && (opts.head == null || o.converged.target === opts.head), last_progress_at: row.updated_at };
}
