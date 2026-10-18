/**
 * Generic backfill runner — v0.30.1 (Fix 3).
 *
 * Generalizes the keyset+checkpoint+adaptive-batch pattern from
 * src/core/backfill-effective-date.ts so future backfills (embedding_voyage,
 * emotional_weight, etc.) reuse the proven pieces instead of cloning them.
 *
 * Codex T3 correction: writes go through engine.withReservedConnection so
 * BEGIN / SET LOCAL / UPDATE / COMMIT execute on the SAME backend. With
 * pooled engine.executeRaw, SET LOCAL evaporates between calls because
 * the next call can land on a different connection. Pinned backend +
 * SET LOCAL inside the same txn gives durable per-batch timeout semantics.
 *
 * Codex P2 / X4: backfills declare an optional `requiredIndex` (partial
 * index on the predicate column). On first run, the runner verifies the
 * index exists and creates it CONCURRENTLY if missing.
 */

import type { BrainEngine } from './engine.ts';
import { isStatementTimeoutError, isRetryableConnError } from './retry-matcher.ts';
// v0.41.18.0: swap inline setTimeout for shared abortableSleep so the sleep
// primitive is unified across the codebase. Backfill's outer-loop + batch-
// halving control flow stays intact (orthogonal to withRetry's per-call retry
// shape) — the unification is at the sleep primitive only, per codex H-6.
import { abortableSleep } from './retry.ts';
import { GBrainError } from './types.ts';
import { redactConnectionInfo } from './audit/redact-connection-info.ts';
import { classifyItemFailure, ItemRun } from './item-failure.ts';
import { OperationError } from './ops/contract.ts';
import { heldUnchanged, noteSkip, parseSkipLedger, readSkipLedgerRaw, reportSkips, restoreSkipLedger, rowRevision, type BackfillSkip } from './backfill-skips.ts';

function brief(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const message = redactConnectionInfo(err instanceof Error ? err.message : String(err)).slice(0, 200);
  return typeof code === 'string' ? `${code} ${message}` : message;
}

/**
 * #5730: a failed batch whose ROLLBACK also failed. The reserved connection's
 * transaction state is unknown, so the run stops instead of retrying on it;
 * the driver discards the connection when it is released. Nothing from the
 * batch was committed and the checkpoint was not advanced.
 */
export class BackfillRollbackError extends GBrainError {
  readonly code = 'backfill_rollback_failed';
  constructor(name: string, batchError: unknown, rollbackError: unknown) {
    super(
      `Backfill ${name} stopped: ROLLBACK of a failed batch also failed`,
      `batch error: ${brief(batchError)}; rollback error: ${brief(rollbackError)}`,
      `gbrain backfill ${name} --resume`,
      'docs/ENGINES.md#backfill-rollback-failed',
    );
    this.name = 'BackfillRollbackError';
  }
}

/**
 * GBRA-130 A-47: the COMMIT of a batch was sent and failed without a server
 * verdict (a lost connection, no SQLSTATE of the row's own), so the batch may
 * or may not have committed. The run stops: it never bisects or skips an
 * undecided batch, and the checkpoint stays before it. A resumed run re-selects
 * the batch; rows that did commit no longer match and are not redone.
 */
export class BackfillCommitIndeterminateError extends GBrainError {
  readonly code = 'backfill_commit_indeterminate';
  constructor(name: string, commitError: unknown) {
    super(
      `Backfill ${name} stopped: a batch COMMIT was sent but its outcome is unknown`,
      `commit error: ${brief(commitError)}; the checkpoint stays before the batch`,
      `gbrain backfill ${name} --resume`,
      'docs/ENGINES.md#backfill-commit-indeterminate',
    );
    this.name = 'BackfillCommitIndeterminateError';
  }
}

export interface BackfillSpec<TRow = Record<string, unknown>> {
  /** Stable identifier — used in checkpoint key + CLI dispatch. */
  name: string;
  /** Postgres table name (used in keyset query). */
  table: string;
  /**
   * Primary-key column name. Keyset pagination uses `WHERE id > $lastId
   * ORDER BY id LIMIT $batchSize` — column name controls both ORDER BY
   * and the comparison. Defaults to 'id'.
   */
  idColumn?: string;
  /**
   * Columns to select for `compute()`. The id column is always included.
   */
  selectColumns: string[];
  /**
   * SQL fragment for `WHERE` (without `WHERE`). Names the un-backfilled rows.
   * E.g. "effective_date IS NULL" or "embedding_voyage IS NULL".
   */
  needsBackfill: string;
  /**
   * Compute updates for a batch of rows. Returns one entry per row that
   * needs updating; rows not present in the result are unchanged.
   */
  compute: (rows: TRow[], engine: BrainEngine) => Promise<Array<{ id: number; updates: Record<string, unknown> }>>;
  /**
   * Optional partial-index requirement (P2 / X4). Runner verifies/creates
   * the index CONCURRENTLY on first run. Skipped on PGLite (no CONCURRENTLY).
   */
  requiredIndex?: { name: string; sql: string };
  /** Estimate of rows-per-second for ETA reporting. Pure-display. */
  estimateRowsPerSecond?: number;
}

export interface BackfillRunOpts {
  /** Hard cap on total rows touched (testing). Undefined = no cap. */
  maxRows?: number;
  /** Initial batch size before adaptive halving. Default 1000. */
  batchSize?: number;
  /** Skip checkpoint, restart from id=0. Default false. */
  fresh?: boolean;
  /** Don't write; report what WOULD happen. Default false. */
  dryRun?: boolean;
  /** Per-batch progress callback. */
  onBatch?: (info: BackfillProgress) => void;
  /** Bail after N total errors. Default 200. */
  maxErrors?: number;
  /**
   * Per-batch statement timeout in seconds. Routed via SET LOCAL inside
   * the reserved-connection transaction. Default 600 (10min). Smaller
   * values fail fast; larger values let the runner do more work per batch.
   */
  perBatchTimeoutSec?: number;
}

export interface BackfillProgress {
  batch: number;
  rowsThisBatch: number;
  cumulative: number;
  lastId: number;
  errorsSeen: number;
  effectiveBatchSize: number;
}

export interface BackfillResult {
  examined: number;
  updated: number;
  errors: number;
  lastId: number;
  durationSec: number;
  /** True iff `maxRows` capped the run (more rows remain). */
  cappedByMaxRows: boolean;
  /** True iff `maxErrors` bailed the run. */
  cappedByErrors: boolean;
  /**
   * GBRA-130 A-47: every row recorded in `backfill.<name>.skipped` after this run (failing or held), with its code
   * and the command that retries it. A recorded row is behind the checkpoint and is retried by every later run.
   */
  skipped: BackfillSkip[];
}

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_ERRORS = 200;
const DEFAULT_PER_BATCH_TIMEOUT_SEC = 600;
const MIN_BATCH_SIZE = 16;

/** Config-table key a backfill's keyset cursor persists under. Exported so other
 *  resumable keyset loops (reindex-search-vector) share the convention. */
export function checkpointKey(name: string): string {
  return `backfill.${name}.last_id`;
}

async function getCheckpoint(engine: BrainEngine, name: string, fresh: boolean): Promise<number> {
  if (fresh) return 0;
  try {
    const rows = await engine.executeRaw<{ value: string }>(
      `SELECT value FROM config WHERE key = $1 LIMIT 1`,
      [checkpointKey(name)],
    );
    if (rows.length === 0) return 0;
    const n = Number(rows[0].value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function setCheckpoint(engine: BrainEngine, name: string, lastId: number): Promise<void> {
  await engine.setConfig(checkpointKey(name), String(lastId));
}

/**
 * Verify or create the partial index a backfill declares. Postgres-only
 * (PGLite ignores CONCURRENTLY anyway, and partial-index is not always
 * supported). Returns false if the index is missing AND we couldn't create
 * it (caller decides whether to bail).
 */
export async function ensureBackfillIndex<TRow>(
  engine: BrainEngine,
  spec: BackfillSpec<TRow>,
): Promise<{ existed: boolean; created: boolean }> {
  if (engine.kind !== 'postgres' || !spec.requiredIndex) {
    return { existed: true, created: false };
  }
  const { name, sql } = spec.requiredIndex;
  try {
    const rows = await engine.executeRaw<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname = $1) AS exists`,
      [name],
    );
    if (rows[0]?.exists) return { existed: true, created: false };
    // Create the index. CONCURRENTLY can't run inside a transaction, so we
    // route via the reserved connection and let the engine handle txn
    // semantics directly.
    await engine.withReservedConnection(async conn => {
      await conn.executeRaw(sql);
    }, { selfContained: true });
    return { existed: false, created: true };
  } catch (err) {
    process.stderr.write(`[backfill] index creation failed: ${(err as Error).message}; will continue without partial index\n`);
    return { existed: false, created: false };
  }
}

/** A COMMIT failure the server decided (a row's own SQLSTATE error): the batch rolled back, so it may be bisected. */
function decidedCommitFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && classifyItemFailure(err).scope === 'item';
}

/** Failures of a batch transaction's BEGIN or SET LOCAL: never the rows' fault. */
const SETUP_FAILURES = new WeakSet<object>();

/** A failure of the batch's own rows (not a setup failure, a timeout, a dropped connection, a failed ROLLBACK or an undecided COMMIT): bisect it. */
function isolatable(err: unknown): boolean {
  if (err instanceof BackfillRollbackError || err instanceof BackfillCommitIndeterminateError) return false;
  if (typeof err === 'object' && err !== null && SETUP_FAILURES.has(err)) return false;
  if (isStatementTimeoutError(err) || isRetryableConnError(err)) return false;
  return classifyItemFailure(err).scope === 'item';
}

/**
 * Run a backfill end-to-end. Honors the checkpoint, halves on timeout,
 * reconnects on conn drop, bails on max errors.
 *
 * GBRA-130 A-47: a batch whose compute or write fails with an item-scoped
 * error is bisected down to single rows, each part computed and written in its
 * own transaction; a single failing row is recorded (backfill-skips.ts) and the
 * checkpoint moves past it. Recorded rows are retried first on every later run.
 * Inside a bisection any other failure stops the run with the checkpoint before
 * the batch. When most attempted rows fail (ItemRun's breaker), the run stops
 * `item_failures_systemic` and restores the skip record and checkpoint it began with.
 */
export async function runBackfill<TRow = Record<string, unknown>>(
  engine: BrainEngine,
  spec: BackfillSpec<TRow>,
  opts: BackfillRunOpts = {},
): Promise<BackfillResult> {
  const t0 = Date.now();
  const idCol = spec.idColumn ?? 'id';
  const cols = [idCol, ...spec.selectColumns.filter(c => c !== idCol)];
  const maxErrors = opts.maxErrors ?? DEFAULT_MAX_ERRORS;
  const perBatchTimeoutSec = opts.perBatchTimeoutSec ?? DEFAULT_PER_BATCH_TIMEOUT_SEC;
  const idOf = (row: TRow) => Number((row as Record<string, unknown>)[idCol]);

  // X4 / P2: verify/create the partial index up-front when declared.
  if (spec.requiredIndex) {
    await ensureBackfillIndex(engine, spec);
  }

  let batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const startCheckpoint = await getCheckpoint(engine, spec.name, false);
  let lastId = opts.fresh === true ? 0 : startCheckpoint;
  let examined = 0;
  let updated = 0;
  let errors = 0;
  let batchNum = 0;
  const startLedger = opts.dryRun ? null : await readSkipLedgerRaw(engine, spec.name);
  const ledger = parseSkipLedger(opts.fresh === true ? null : startLedger);
  const items = new ItemRun('backfill.rows');
  const { VERSION: producer } = await import('../version.ts');

  const saveLedger = async () => {
    const raw = JSON.stringify(ledger);
    if (!opts.dryRun && raw !== startLedger && (startLedger !== null || Object.keys(ledger.items).length > 0)) await engine.setConfig(`backfill.${spec.name}.skipped`, raw);
  };
  const finish = async (flags: { cappedByMaxRows: boolean; cappedByErrors: boolean }): Promise<BackfillResult> => {
    if (items.systemic()) throw items.systemic();
    await saveLedger();
    return { examined, updated, errors, lastId, durationSec: (Date.now() - t0) / 1000, ...flags, skipped: reportSkips(ledger, spec.name) };
  };

  // T3 fix: writes go through withReservedConnection so BEGIN / SET LOCAL
  // / UPDATE / COMMIT all happen on the same backend. Without this,
  // pooled executeRaw can land BEGIN on backend-A and UPDATE on backend-B
  // and SET LOCAL evaporates.
  const writeBatch = async (computedUpdates: Array<{ id: number; updates: Record<string, unknown> }>): Promise<number> => {
    if (opts.dryRun || computedUpdates.length === 0) return 0;
    return engine.withReservedConnection(async conn => {
      await conn.executeRaw(`BEGIN`);
      let batchUpdated = 0;
      let stage: 'setup' | 'update' | 'commit' = 'setup';
      try {
        if (engine.kind === 'postgres') {
          await conn.executeRaw(`SET LOCAL statement_timeout = '${perBatchTimeoutSec}s'`);
        }
        stage = 'update';
        for (const { id, updates } of computedUpdates) {
          const setClauses: string[] = [];
          const params: unknown[] = [id];
          let paramIdx = 2;
          for (const [col, val] of Object.entries(updates)) {
            setClauses.push(`${col} = $${paramIdx}`);
            params.push(val);
            paramIdx++;
          }
          if (setClauses.length === 0) continue;
          await conn.executeRaw(
            `UPDATE ${spec.table} SET ${setClauses.join(', ')} WHERE ${idCol} = $1`,
            params,
          );
          batchUpdated++;
        }
        stage = 'commit';
        await conn.executeRaw(`COMMIT`);
        return batchUpdated;
      } catch (err) {
        if (stage === 'setup' && typeof err === 'object' && err !== null) SETUP_FAILURES.add(err);
        if (stage === 'commit' && !decidedCommitFailure(err)) {
          await conn.executeRaw(`ROLLBACK`).catch(() => undefined);
          throw new BackfillCommitIndeterminateError(spec.name, err);
        }
        try {
          await conn.executeRaw(`ROLLBACK`);
        } catch (rollbackErr) {
          throw new BackfillRollbackError(spec.name, err, rollbackErr);
        }
        throw err;
      }
    }, { selfContained: true });
  };

  const now = () => new Date().toISOString();
  const attempt = async (rows: TRow[]): Promise<void> => {
    updated += await writeBatch(await spec.compute(rows, engine));
    for (const row of rows) { items.succeed(); delete ledger.items[String(idOf(row))]; }
  };
  /** Bisects rows that failed together with `first` down to single rows; returns how many rows it recorded as skipped. */
  const isolate = async (rows: TRow[], first: unknown): Promise<number> => {
    let skipped = 0;
    const visit = async (part: TRow[], error?: unknown): Promise<void> => {
      if (error === undefined) {
        try { await attempt(part); return; } catch (err) {
          if (!isolatable(err)) throw err;
          error = err;
        }
      }
      if (part.length === 1) {
        noteSkip(ledger, idOf(part[0]), rowRevision(part[0]), items.fail(String(idOf(part[0])), error), now(), producer);
        skipped++;
        return;
      }
      const mid = Math.ceil(part.length / 2);
      await visit(part.slice(0, mid));
      await visit(part.slice(mid));
    };
    await visit(rows, first);
    return skipped;
  };

  try {
    // Rows recorded by earlier runs that still need the backfill are retried one at a time first;
    // a held row is retried only once it or the gbrain version changed. Records of rows that landed or went away are dropped.
    const recorded = opts.dryRun ? [] : Object.keys(ledger.items).map(Number).filter(id => id <= lastId);
    for (let i = 0; i < recorded.length; i += 500) {
      const ids = recorded.slice(i, i + 500);
      const pending = await engine.executeRaw<TRow>(
        `SELECT ${cols.join(', ')} FROM ${spec.table} WHERE ${idCol} IN (${ids.map((_, n) => `$${n + 1}`).join(', ')}) AND (${spec.needsBackfill}) ORDER BY ${idCol}`, ids);
      const present = new Set(pending.map(idOf));
      for (const id of ids) if (!present.has(id)) delete ledger.items[String(id)];
      for (const row of pending) {
        if (heldUnchanged(ledger.items[String(idOf(row))], rowRevision(row), producer)) continue;
        examined++;
        try { await attempt([row]); } catch (err) {
          if (!isolatable(err)) throw err;
          errors += await isolate([row], err);
        }
      }
    }

    while (true) {
      const remaining = opts.maxRows ? Math.max(0, opts.maxRows - examined) : Number.POSITIVE_INFINITY;
      if (remaining <= 0) return await finish({ cappedByMaxRows: true, cappedByErrors: false });
      const effective = Math.min(batchSize, remaining);

      let rows: TRow[];
      try {
        rows = await engine.executeRaw<TRow>(
          `SELECT ${cols.join(', ')} FROM ${spec.table}
           WHERE ${idCol} > $1 AND (${spec.needsBackfill})
           ORDER BY ${idCol}
           LIMIT $2`,
          [lastId, effective],
        );
      } catch (err) {
        errors++;
        if (errors >= maxErrors) return await finish({ cappedByMaxRows: false, cappedByErrors: true });
        // Connection drop: brief sleep + retry the same window.
        if (isRetryableConnError(err)) {
          await abortableSleep(1000);
          continue;
        }
        throw err;
      }

      // No more rows match the predicate. Done.
      if (rows.length === 0) return await finish({ cappedByMaxRows: false, cappedByErrors: false });
      examined += rows.length;
      batchNum++;

      let computedUpdates: Array<{ id: number; updates: Record<string, unknown> }> | null = null;
      let skippedRows: number | null = null;
      try {
        computedUpdates = await spec.compute(rows, engine);
      } catch (err) {
        errors++;
        if (errors >= maxErrors) break;
        if (isStatementTimeoutError(err)) {
          batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2));
          process.stderr.write(`[backfill:${spec.name}] compute timeout; halving batch to ${batchSize}\n`);
          continue;
        }
        if (!isolatable(err)) throw err;
        skippedRows = await isolate(rows, err);
      }

      if (computedUpdates) {
        try {
          updated += await writeBatch(computedUpdates);
        } catch (err) {
          if (err instanceof BackfillRollbackError || err instanceof BackfillCommitIndeterminateError) throw err;
          errors++;
          if (errors >= maxErrors) break;
          if (isStatementTimeoutError(err)) {
            batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2));
            process.stderr.write(`[backfill:${spec.name}] write timeout; halving batch to ${batchSize}\n`);
            continue;
          }
          if (isRetryableConnError(err)) {
            await abortableSleep(1000);
            continue;
          }
          if (!isolatable(err)) throw err;
          skippedRows = await isolate(rows, err);
        }
      }
      if (skippedRows === null) for (const _ of rows) items.succeed();
      else {
        errors += skippedRows;
        // The skipped rows are recorded before the checkpoint moves past them.
        await saveLedger();
      }

      // Advance the checkpoint to the highest id we examined this batch.
      const lastBatchId = (rows[rows.length - 1] as Record<string, unknown>)[idCol];
      if (typeof lastBatchId === 'number') lastId = lastBatchId;
      if (!opts.dryRun) await setCheckpoint(engine, spec.name, lastId);

      opts.onBatch?.({
        batch: batchNum,
        rowsThisBatch: rows.length,
        cumulative: examined,
        lastId,
        errorsSeen: errors,
        effectiveBatchSize: effective,
      });
      if (errors >= maxErrors) break;
    }

    return await finish({ cappedByMaxRows: false, cappedByErrors: errors >= maxErrors });
  } catch (err) {
    // A systemic run records nothing: the skip record and the checkpoint go back to what the run began with.
    if (!opts.dryRun && err instanceof OperationError && err.code === 'item_failures_systemic') {
      await restoreSkipLedger(engine, spec.name, startLedger);
      if (startCheckpoint > 0) await setCheckpoint(engine, spec.name, startCheckpoint);
      else await clearBackfillCheckpoint(engine, spec.name);
    }
    throw err;
  }
}

/**
 * Clear the checkpoint for a backfill. Used by --fresh + after manual reset.
 */
export async function clearBackfillCheckpoint(engine: BrainEngine, name: string): Promise<void> {
  try {
    await engine.executeRaw(`DELETE FROM config WHERE key = $1`, [checkpointKey(name)]);
  } catch {
    /* best-effort */
  }
}
