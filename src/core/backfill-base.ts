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
}

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_ERRORS = 200;
const DEFAULT_PER_BATCH_TIMEOUT_SEC = 600;
const MIN_BATCH_SIZE = 16;

function checkpointKey(name: string): string {
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
    });
    return { existed: false, created: true };
  } catch (err) {
    process.stderr.write(`[backfill] index creation failed: ${(err as Error).message}; will continue without partial index\n`);
    return { existed: false, created: false };
  }
}

/**
 * Run a backfill end-to-end. Honors the checkpoint, halves on timeout,
 * reconnects on conn drop, bails on max errors.
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

  // X4 / P2: verify/create the partial index up-front when declared.
  if (spec.requiredIndex) {
    await ensureBackfillIndex(engine, spec);
  }

  let batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let lastId = await getCheckpoint(engine, spec.name, opts.fresh === true);
  let examined = 0;
  let updated = 0;
  let errors = 0;
  let batchNum = 0;

  while (true) {
    const remaining = opts.maxRows ? Math.max(0, opts.maxRows - examined) : Number.POSITIVE_INFINITY;
    if (remaining <= 0) {
      return {
        examined, updated, errors, lastId,
        durationSec: (Date.now() - t0) / 1000,
        cappedByMaxRows: true, cappedByErrors: false,
      };
    }
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
      if (errors >= maxErrors) {
        return {
          examined, updated, errors, lastId,
          durationSec: (Date.now() - t0) / 1000,
          cappedByMaxRows: false, cappedByErrors: true,
        };
      }
      // Connection drop: brief sleep + retry the same window.
      if (isRetryableConnError(err)) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }

    if (rows.length === 0) {
      // No more rows match the predicate. Done.
      return {
        examined, updated, errors, lastId,
        durationSec: (Date.now() - t0) / 1000,
        cappedByMaxRows: false, cappedByErrors: false,
      };
    }
    examined += rows.length;
    batchNum++;

    let computedUpdates: Array<{ id: number; updates: Record<string, unknown> }>;
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
      throw err;
    }

    // T3 fix: writes go through withReservedConnection so BEGIN / SET LOCAL
    // / UPDATE / COMMIT all happen on the same backend. Without this,
    // pooled executeRaw can land BEGIN on backend-A and UPDATE on backend-B
    // and SET LOCAL evaporates.
    if (!opts.dryRun && computedUpdates.length > 0) {
      try {
        await engine.withReservedConnection(async conn => {
          await conn.executeRaw(`BEGIN`);
          try {
            if (engine.kind === 'postgres') {
              await conn.executeRaw(`SET LOCAL statement_timeout = '${perBatchTimeoutSec}s'`).catch(() => {
                /* some Postgres tiers restrict SET LOCAL; falls through */
              });
            }
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
              updated++;
            }
            await conn.executeRaw(`COMMIT`);
          } catch (err) {
            await conn.executeRaw(`ROLLBACK`).catch(() => {});
            throw err;
          }
        });
      } catch (err) {
        errors++;
        if (errors >= maxErrors) break;
        if (isStatementTimeoutError(err)) {
          batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 2));
          process.stderr.write(`[backfill:${spec.name}] write timeout; halving batch to ${batchSize}\n`);
          continue;
        }
        if (isRetryableConnError(err)) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }

    // Advance the checkpoint to the highest id we examined this batch.
    const idAccessor = idCol;
    const lastBatchId = (rows[rows.length - 1] as Record<string, unknown>)[idAccessor];
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
  }

  return {
    examined, updated, errors, lastId,
    durationSec: (Date.now() - t0) / 1000,
    cappedByMaxRows: false, cappedByErrors: errors >= maxErrors,
  };
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
