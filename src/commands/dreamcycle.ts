/**
 * Local-only external DreamCycle handoff.
 *
 * An external scheduler may own the source-cycle cadence, but it must never
 * choose global phases, manufacture authority, or supply a source receipt.
 * `begin` records the exact source membership in minion_jobs; `finalize`
 * requires each member to have a newer same-JST-day source receipt before it
 * seals the one protected global-maintenance job.
 *
 * This is deliberately a CLI command, not an operation: no HTTP/MCP surface,
 * OAuth scope, migration, config mutation, or destructive phase is added.
 */

import type { BrainEngine, SourceRow } from '../core/engine.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../core/db-lock.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { rowToMinionJob, type MinionJob } from '../core/minions/types.ts';
import {
  DAILY_GLOBAL_ALLOWLIST,
  createGlobalMaintenanceSourceSnapshot,
  getJSTDaySlot,
  globalMaintenanceSnapshotMatches,
  readGlobalMaintenanceAuthority,
} from './autopilot-fanout.ts';

export const EXTERNAL_DREAMCYCLE_AUTHORITY = 'external_dreamcycle';
export const DREAMCYCLE_BEGIN_JOB_NAME = 'dreamcycle-begin';

const BEGIN_KEY_PREFIX = 'dreamcycle:external:begin:';
const GLOBAL_KEY_PREFIX = 'dreamcycle:global:';
const FINALIZE_LOCK_PREFIX = 'gbrain-dreamcycle-finalize:';
const JST_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DreamcycleSourceEntry {
  source_id: string;
}

/** Immutable source-ID membership snapshot recorded by `dreamcycle begin`. */
export interface DreamcycleSourceSnapshot {
  sources: DreamcycleSourceEntry[];
  revision: string;
}

export interface ExternalDreamcycleBeginRecord extends DreamcycleSourceSnapshot {
  job_id: number;
  jst_day: string;
  begun_at: string;
}

export type ExternalDreamcycleResult =
  | {
      outcome: 'begun';
      begin_job_id: number;
      jst_day: string;
      source_count: number;
      revision: string;
    }
  | {
      outcome: 'sealed';
      global_job_id: number;
      jst_day: string;
      source_count: number;
      revision: string;
    }
  | { outcome: 'global_deferred'; detail: string };

export type DreamcycleAction = 'begin' | 'finalize';

export interface ParsedDreamcycleArgs {
  action: DreamcycleAction | null;
  json: boolean;
  help: boolean;
}

export const DREAMCYCLE_HELP = `Usage: gbrain dreamcycle <begin|finalize> [--json]

Local-only external DreamCycle handoff.

  begin     Record today's exact source membership snapshot.
  finalize  Verify every snapshotted source has a newer JST-day receipt,
            then seal one protected global-maintenance job.

No phase, source, authority, or snapshot flags are accepted. They are sealed
inside GBrain so an external scheduler cannot widen the maintenance scope.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isJstDay(value: unknown): value is string {
  if (typeof value !== 'string' || !JST_DAY_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function beginKey(jstDay: string): string {
  return `${BEGIN_KEY_PREFIX}${jstDay}`;
}

function globalKey(jstDay: string): string {
  return `${GLOBAL_KEY_PREFIX}${jstDay}`;
}

/**
 * Make an exact, deterministic source-ID membership revision. Source config,
 * paths, and caller-controlled values are intentionally absent: the only
 * thing the external batch may depend on is which source IDs it began with.
 */
export function createExternalDreamcycleSourceSnapshot(
  sources: readonly Pick<SourceRow, 'id'>[],
): DreamcycleSourceSnapshot | null {
  if (sources.length === 0) return null;
  const ids = sources.map((source) => source.id);
  if (ids.some((id) => !isValidSourceId(id))) return null;
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  if (new Set(sorted).size !== sorted.length) return null;
  const entries = sorted.map((source_id) => ({ source_id }));
  return {
    sources: entries,
    // Keep the revision JSON-safe because it is stored in minion_jobs.data.
    // Postgres JSONB rejects a literal NUL even when a source ID itself is
    // valid. JSON's array representation is both unambiguous and stable
    // after the explicit sort above.
    revision: JSON.stringify(sorted),
  };
}

function parseSourceSnapshot(
  rawSources: unknown,
  rawRevision: unknown,
): DreamcycleSourceSnapshot | null {
  if (!Array.isArray(rawSources) || typeof rawRevision !== 'string') return null;
  const ids: string[] = [];
  for (const raw of rawSources) {
    if (!isRecord(raw) || !isValidSourceId(raw.source_id)) return null;
    ids.push(raw.source_id);
  }
  const expected = createExternalDreamcycleSourceSnapshot(ids.map((id) => ({ id })));
  if (!expected || expected.revision !== rawRevision || expected.sources.length !== rawSources.length) return null;
  for (let index = 0; index < expected.sources.length; index++) {
    if ((rawSources[index] as Record<string, unknown>).source_id !== expected.sources[index].source_id) {
      return null;
    }
  }
  return expected;
}

/** Validate the durable begin-job payload before trusting it as a receipt. */
export function parseExternalDreamcycleBeginData(raw: unknown): Omit<ExternalDreamcycleBeginRecord, 'job_id'> | null {
  if (!isRecord(raw)) return null;
  if (!isJstDay(raw.jst_day) || typeof raw.begun_at !== 'string') return null;
  const begunAt = new Date(raw.begun_at);
  if (!Number.isFinite(begunAt.getTime())) return null;
  const snapshot = parseSourceSnapshot(raw.source_snapshot, raw.source_snapshot_revision);
  if (!snapshot) return null;
  return {
    jst_day: raw.jst_day,
    begun_at: begunAt.toISOString(),
    ...snapshot,
  };
}

async function loadExternalDreamcycleBegin(
  engine: BrainEngine,
  jstDay: string,
): Promise<ExternalDreamcycleBeginRecord | null> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT * FROM minion_jobs WHERE idempotency_key = $1`,
    [beginKey(jstDay)],
  );
  if (rows.length !== 1) return null;
  const job = rowToMinionJob(rows[0]);
  if (job.name !== DREAMCYCLE_BEGIN_JOB_NAME || job.idempotency_key !== beginKey(jstDay)) return null;
  const parsed = parseExternalDreamcycleBeginData(job.data);
  if (!parsed || parsed.jst_day !== jstDay) return null;
  return { job_id: job.id, ...parsed };
}

function deferred(detail: string): ExternalDreamcycleResult {
  return { outcome: 'global_deferred', detail };
}

function hasNewSameDayReceipts(
  receiptSnapshot: { sources: Array<{ receipt_at: string }> },
  begunAt: string,
): boolean {
  const beganMs = new Date(begunAt).getTime();
  if (!Number.isFinite(beganMs)) return false;
  return receiptSnapshot.sources.every((entry) => {
    const receiptMs = new Date(entry.receipt_at).getTime();
    return Number.isFinite(receiptMs) && receiptMs > beganMs;
  });
}

async function hasLiveGlobalFinalizer(engine: BrainEngine): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM minion_jobs
     WHERE name = 'autopilot-global-maintenance'
       AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
     LIMIT 1`,
  );
  return rows.length > 0;
}

async function hasGlobalFinalizerForDay(engine: BrainEngine, jstDay: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM minion_jobs WHERE idempotency_key = $1 LIMIT 1`,
    [globalKey(jstDay)],
  );
  return rows.length > 0;
}

/**
 * Start the external daily batch by storing the exact source-ID membership in
 * the existing minion job table. This is a durable no-op job, not a worker
 * request: its data is the receipt finalization must prove against.
 */
export async function beginExternalDreamcycle(
  engine: BrainEngine,
  queue: MinionQueue,
  opts: { now?: Date } = {},
): Promise<ExternalDreamcycleResult> {
  const now = opts.now ?? new Date();
  const jstDay = getJSTDaySlot(now);
  if (await readGlobalMaintenanceAuthority(engine) !== EXTERNAL_DREAMCYCLE_AUTHORITY) {
    return deferred('external_dreamcycle_not_enabled');
  }

  let sources: SourceRow[];
  try {
    sources = await engine.listAllSources({ localPathOnly: true });
  } catch {
    return deferred('source_listing_unavailable');
  }
  const snapshot = createExternalDreamcycleSourceSnapshot(sources);
  if (!snapshot) return deferred('source_snapshot_incomplete');

  let job: MinionJob;
  try {
    job = await queue.add(
      DREAMCYCLE_BEGIN_JOB_NAME,
      {
        jst_day: jstDay,
        begun_at: now.toISOString(),
        source_snapshot: snapshot.sources,
        source_snapshot_revision: snapshot.revision,
      },
      {
        queue: 'default',
        idempotency_key: beginKey(jstDay),
        max_attempts: 1,
      },
      { allowProtectedSubmit: true },
    );
  } catch {
    return deferred('begin_record_unavailable');
  }

  // Idempotent repeats may return the existing row. It is safe only if its
  // immutable source membership is still exactly today's current membership.
  const stored = parseExternalDreamcycleBeginData(job.data);
  if (
    !stored ||
    stored.jst_day !== jstDay ||
    stored.revision !== snapshot.revision ||
    stored.sources.length !== snapshot.sources.length
  ) {
    return deferred('begin_snapshot_mismatch');
  }
  return {
    outcome: 'begun',
    begin_job_id: job.id,
    jst_day: jstDay,
    source_count: snapshot.sources.length,
    revision: snapshot.revision,
  };
}

/**
 * Verify the stored begin receipt and seal one protected global job. No caller
 * input controls phases, source IDs, authority, receipt snapshots, or paths.
 */
async function finalizeExternalDreamcycleLocked(
  engine: BrainEngine,
  queue: MinionQueue,
  now: Date,
  jstDay: string,
): Promise<ExternalDreamcycleResult> {
  try {
    await queue.ensureSchema();
  } catch {
    return deferred('minion_storage_unavailable');
  }

  let begin: ExternalDreamcycleBeginRecord | null;
  try {
    begin = await loadExternalDreamcycleBegin(engine, jstDay);
  } catch {
    return deferred('begin_record_unavailable');
  }
  if (!begin) return deferred('begin_record_missing_or_invalid');

  let sources: SourceRow[];
  try {
    sources = await engine.listAllSources({ localPathOnly: true });
  } catch {
    return deferred('source_listing_unavailable');
  }
  const membership = createExternalDreamcycleSourceSnapshot(sources);
  if (!membership || membership.revision !== begin.revision) {
    return deferred('source_membership_drift');
  }

  const receipts = createGlobalMaintenanceSourceSnapshot(sources, jstDay);
  if (!receipts || !hasNewSameDayReceipts(receipts, begin.begun_at)) {
    return deferred('source_receipts_incomplete_or_pre_begin');
  }

  // Do not let queue-level maxWaiting coalesce this call into a different
  // global batch. Any existing finalizer is uncertainty, so fail closed.
  try {
    if (
      await hasGlobalFinalizerForDay(engine, jstDay) ||
      await hasLiveGlobalFinalizer(engine)
    ) {
      return deferred('duplicate_global_finalizer');
    }
  } catch {
    return deferred('global_job_lookup_unavailable');
  }

  let job: MinionJob;
  try {
    job = await queue.add(
      'autopilot-global-maintenance',
      {
        // `null` is explicit: global phases are DB-only and must not inherit
        // a caller-selected checkout or read a fallback path.
        repoPath: null,
        phases: [...DAILY_GLOBAL_ALLOWLIST],
        execution_authority: 'dreamcycle_global',
        finalizer_origin: EXTERNAL_DREAMCYCLE_AUTHORITY,
        source_snapshot: receipts.sources,
        source_snapshot_revision: receipts.revision,
        source_snapshot_jst_day: receipts.jst_day,
        external_dreamcycle_begin_job_id: begin.job_id,
        external_dreamcycle_begin_revision: begin.revision,
        external_dreamcycle_begin_jst_day: begin.jst_day,
        external_dreamcycle_begin_at: begin.begun_at,
      },
      {
        queue: 'default',
        idempotency_key: globalKey(jstDay),
        max_attempts: 2,
        maxWaiting: 1,
      },
      { allowProtectedSubmit: true },
    );
  } catch {
    return deferred('global_job_seal_failed');
  }

  // A concurrent caller cannot create a second row because idempotency_key is
  // unique. If queue backpressure returned a different waiting job, however,
  // this caller did not seal its verified batch and must report deferred.
  if (job.idempotency_key !== globalKey(jstDay)) {
    return deferred('duplicate_global_finalizer');
  }
  return {
    outcome: 'sealed',
    global_job_id: job.id,
    jst_day: jstDay,
    source_count: receipts.sources.length,
    revision: receipts.revision,
  };
}

export async function finalizeExternalDreamcycle(
  engine: BrainEngine,
  queue: MinionQueue,
  opts: { now?: Date } = {},
): Promise<ExternalDreamcycleResult> {
  const now = opts.now ?? new Date();
  const jstDay = getJSTDaySlot(now);
  if (await readGlobalMaintenanceAuthority(engine) !== EXTERNAL_DREAMCYCLE_AUTHORITY) {
    return deferred('external_dreamcycle_not_enabled');
  }

  // The idempotency key prevents a second global row, while this narrow,
  // existing DB lock also makes a racing second caller report deferred rather
  // than treating the first caller's row as its own success. It is released
  // immediately; no new schema or durable lock protocol is introduced.
  let finalizeLock: DbLockHandle | null;
  try {
    finalizeLock = await tryAcquireDbLock(engine, `${FINALIZE_LOCK_PREFIX}${jstDay}`, 2);
  } catch {
    return deferred('finalize_lock_unavailable');
  }
  if (!finalizeLock) return deferred('duplicate_global_finalizer');

  try {
    // The authority can change while a competing caller holds the lock. Read
    // it again immediately before checking and sealing the batch.
    if (await readGlobalMaintenanceAuthority(engine) !== EXTERNAL_DREAMCYCLE_AUTHORITY) {
      return deferred('external_dreamcycle_not_enabled');
    }
    return await finalizeExternalDreamcycleLocked(engine, queue, now, jstDay);
  } finally {
    try {
      await finalizeLock.release();
    } catch {
      // The DB lock has a short TTL fallback. Never turn an already-safe
      // deferred/sealed verdict into an unhandled CLI error on cleanup.
    }
  }
}

/**
 * Defense in depth for the protected global job handler. It replays every
 * batch gate at claim time, including the current config value, exact source
 * membership, newer same-day receipts, and the sealed receipt snapshot.
 */
export async function externalDreamcycleFinalizerBatchMatches(
  engine: BrainEngine,
  data: Record<string, unknown>,
  opts: { now?: Date; currentSources?: SourceRow[] } = {},
): Promise<boolean> {
  try {
    if (await readGlobalMaintenanceAuthority(engine) !== EXTERNAL_DREAMCYCLE_AUTHORITY) return false;
    const now = opts.now ?? new Date();
    const jstDay = getJSTDaySlot(now);
    const begin = await loadExternalDreamcycleBegin(engine, jstDay);
    if (!begin) return false;
    if (
      data.finalizer_origin !== EXTERNAL_DREAMCYCLE_AUTHORITY ||
      data.external_dreamcycle_begin_job_id !== begin.job_id ||
      data.external_dreamcycle_begin_revision !== begin.revision ||
      data.external_dreamcycle_begin_jst_day !== begin.jst_day ||
      data.external_dreamcycle_begin_at !== begin.begun_at
    ) {
      return false;
    }

    const sources = opts.currentSources ?? await engine.listAllSources({ localPathOnly: true });
    const membership = createExternalDreamcycleSourceSnapshot(sources);
    if (!membership || membership.revision !== begin.revision) return false;

    const receipts = createGlobalMaintenanceSourceSnapshot(sources, jstDay);
    if (!receipts || !hasNewSameDayReceipts(receipts, begin.begun_at)) return false;

    return globalMaintenanceSnapshotMatches(
      data.source_snapshot,
      data.source_snapshot_revision,
      data.source_snapshot_jst_day,
      sources,
      now,
    );
  } catch {
    return false;
  }
}

/** Parse the intentionally tiny CLI contract. */
export function parseDreamcycleArgs(args: string[]): ParsedDreamcycleArgs {
  if (args.includes('--help') || args.includes('-h')) {
    return { action: null, json: false, help: true };
  }
  const [rawAction, ...rest] = args;
  if (rawAction !== 'begin' && rawAction !== 'finalize') {
    throw new Error('Usage: gbrain dreamcycle <begin|finalize> [--json]');
  }
  const unsupported = rest.filter((arg) => arg !== '--json');
  if (unsupported.length > 0) {
    throw new Error(
      `gbrain dreamcycle ${rawAction} accepts no phase/source/authority/snapshot overrides ` +
      `(unsupported: ${unsupported.join(', ')})`,
    );
  }
  return { action: rawAction, json: rest.includes('--json'), help: false };
}

function printResult(result: ExternalDreamcycleResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.outcome === 'begun') {
    console.log(
      `[dreamcycle] begin recorded: JST ${result.jst_day}, ` +
      `${result.source_count} source(s), receipt job #${result.begin_job_id}`,
    );
    return;
  }
  if (result.outcome === 'sealed') {
    console.log(
      `[dreamcycle] global finalizer sealed: job #${result.global_job_id}, ` +
      `JST ${result.jst_day}, ${result.source_count} source(s)`,
    );
    return;
  }
  console.error(`[dreamcycle] global_deferred: ${result.detail}`);
}

/** CLI handler. Returns a process verdict; cli.ts owns process exit/teardown. */
export async function runDreamcycle(engine: BrainEngine, args: string[]): Promise<number> {
  let parsed: ParsedDreamcycleArgs;
  try {
    parsed = parseDreamcycleArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (parsed.help) {
    console.log(DREAMCYCLE_HELP);
    return 0;
  }

  const queue = new MinionQueue(engine);
  const result = parsed.action === 'begin'
    ? await beginExternalDreamcycle(engine, queue)
    : await finalizeExternalDreamcycle(engine, queue);
  printResult(result, parsed.json);
  return result.outcome === 'global_deferred' ? 3 : 0;
}
