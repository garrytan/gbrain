/**
 * The git sync hold store and the managed sync pass row reads: the statements persistence/sync-holds.ts,
 * persistence/sync-pass-row.ts ran through `executeRaw` (Rust engine lane 9, step 2b).
 * The statement text is the caller's, byte for byte, so PGLite and Postgres answer exactly as before; each engine
 * runs them through its own `executeRaw`, so a statement fault a test injects on the engine reaches them and a
 * transaction-bound engine runs them in its transaction. The hold semantics (what a write keeps, the escalation
 * stamps, which run wins) stay with the callers; these are the row reads and writes they compose. A Rust brain keeps
 * the same rows in its op checkpoint store (src/core/rust-engine/store-members/sync-hold-store.ts).
 */
import { GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP } from './persistence-journal.ts';
import { MANAGED_SYNC_PASS_OP } from './sync-hold-op.ts';

/** The op_checkpoints op of a source incarnation's managed sync pass row (sync-pass-row.ts re-exports it; defined in the leaf sync-hold-op.ts). */
export { MANAGED_SYNC_PASS_OP };

/** The engine's own executeRaw (see the module comment). */
export interface HoldStoreExec {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

export function gitHoldFingerprint(sourceId: string, incarnation: string, path: string): string {
  return `${sourceId}:${incarnation}:${path}`;
}

export const summaryFingerprint = (sourceId: string, incarnation: string) => `${sourceId}:${incarnation}`;

/**
 * The summary row's counters besides `count`: `stale` the holds of files whose page exists, `images` the #5493
 * unsupported-image holds, `fences` the #6188 `invalid_fence` holds, `concurrent` the #6194 `concurrent_write` holds,
 * `stalled` the #6278 out-of-attempts holds, `dirty` the #6340 `worktree_dirty` holds, `drift` the #6712 `file_drift` holds.
 */
export const GIT_HOLD_SUMMARY_COUNTERS = ['stale', 'images', 'fences', 'concurrent', 'stalled', 'dirty', 'drift'] as const;
export type GitHoldSummaryWeights = Record<typeof GIT_HOLD_SUMMARY_COUNTERS[number], number>;

/** Creates the source incarnation's summary row when missing, else touches it (on Postgres the upsert locks it), and returns its count. */
export async function lockGitHoldSummary(exec: HoldStoreExec, sourceId: string, incarnation: string): Promise<number> {
  const [row] = await exec.executeRaw<{ count: number | string }>(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('source_id',$3::text,'incarnation',$4::text,'count',0,'stale',0)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET updated_at=now()
    RETURNING COALESCE((completed_keys->0->>'count')::int,0) AS count`,
  [GIT_HOLD_SUMMARY_OP, summaryFingerprint(sourceId, incarnation), sourceId, incarnation]);
  return Number(row?.count ?? 0);
}

/**
 * The summary adjustment, one `GREATEST(0, stored + $N)` pair per GIT_HOLD_SUMMARY_COUNTERS entry in order ($4 on), written out so
 * the statement is constant text (check:engine-sql-dynamic); test/engine-sql-caller-raw-sql-pins.test.ts renders it from the counter list.
 */
const ADJUST_GIT_HOLD_SUMMARY_SQL = `UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0)||jsonb_build_object(
      'count',GREATEST(0,COALESCE((completed_keys->0->>'count')::int,0)+$3::int),'stale',GREATEST(0,COALESCE((completed_keys->0->>'stale')::int,0)+$4::int),'images',GREATEST(0,COALESCE((completed_keys->0->>'images')::int,0)+$5::int),'fences',GREATEST(0,COALESCE((completed_keys->0->>'fences')::int,0)+$6::int),'concurrent',GREATEST(0,COALESCE((completed_keys->0->>'concurrent')::int,0)+$7::int),'stalled',GREATEST(0,COALESCE((completed_keys->0->>'stalled')::int,0)+$8::int),'dirty',GREATEST(0,COALESCE((completed_keys->0->>'dirty')::int,0)+$9::int),'drift',GREATEST(0,COALESCE((completed_keys->0->>'drift')::int,0)+$10::int))),updated_at=now() WHERE op=$1 AND fingerprint=$2`;

/** Adds `delta` to the summary's count and each weight to its counter, none below zero; no summary row, no write. */
export async function adjustGitHoldSummary(exec: HoldStoreExec, sourceId: string, incarnation: string, delta: number, weights: GitHoldSummaryWeights): Promise<void> {
  await exec.executeRaw(ADJUST_GIT_HOLD_SUMMARY_SQL,
  [GIT_HOLD_SUMMARY_OP, summaryFingerprint(sourceId, incarnation), delta, ...GIT_HOLD_SUMMARY_COUNTERS.map(name => weights[name])]);
}

/** The hold record at `path` as stored (no read-only mirror mark), or null. */
export async function readGitHoldRow<R = Record<string, unknown>>(exec: HoldStoreExec, sourceId: string, incarnation: string, path: string): Promise<R | null> {
  const [row] = await exec.executeRaw<{ record: R }>('SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [GIT_HOLD_OP, gitHoldFingerprint(sourceId, incarnation, path)]);
  return row?.record ?? null;
}

/** Stores `record` as the hold at `path`, replacing any. */
export async function writeGitHoldRow(exec: HoldStoreExec, sourceId: string, incarnation: string, path: string, record: object): Promise<void> {
  await exec.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`,
  [GIT_HOLD_OP, gitHoldFingerprint(sourceId, incarnation, path), JSON.stringify([record])]);
}

/** Replaces the hold at `path` with `next` only while it is still `expected` (JSON equality); true when it landed. */
export async function replaceGitHoldRow(exec: HoldStoreExec, sourceId: string, incarnation: string, path: string, expected: object, next: object): Promise<boolean> {
  const rows = await exec.executeRaw(`UPDATE op_checkpoints SET completed_keys=$3::text::jsonb, updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND completed_keys=$4::text::jsonb RETURNING 1`,
  [GIT_HOLD_OP, gitHoldFingerprint(sourceId, incarnation, path), JSON.stringify([next]), JSON.stringify([expected])]);
  return rows.length > 0;
}

/** Deletes the hold at `path` (none, no change). */
export async function deleteGitHoldRow(exec: HoldStoreExec, sourceId: string, incarnation: string, path: string): Promise<void> {
  await exec.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [GIT_HOLD_OP, gitHoldFingerprint(sourceId, incarnation, path)]);
}

/** Outstanding holds of the source incarnation: its summary's count (one indexed read), 0 without a summary. */
export async function countGitHolds(exec: HoldStoreExec, sourceId: string, incarnation: string): Promise<number> {
  const [row] = await exec.executeRaw<{ count: number | string }>("SELECT COALESCE((completed_keys->0->>'count')::int,0) AS count FROM op_checkpoints WHERE op=$1 AND fingerprint=$2",
    [GIT_HOLD_SUMMARY_OP, summaryFingerprint(sourceId, incarnation)]);
  return Number(row?.count ?? 0);
}

/** One row per source incarnation: the blocked requests recent managed syncs converted in place (sync-holds.ts re-exports it). */
export const SYNC_CONVERSION_OP = 'sync-conversions';
/** How many conversions a source's log keeps, newest first (sync-holds.ts re-exports it). */
export const SYNC_CONVERSION_KEEP = 20;
/** One logged conversion: the blocked request a managed sync converted in place and how (sync-holds.ts re-exports it). */
export interface SyncConversion { request_id: string; path: string | null; slug: string | null; run_id: string; outcome: 'held' | 'refrozen'; converted_at: string }

/** A row of the bounded hold listing: the source, its current incarnation and outstanding count, and one hold record (null when none is listed). */
export interface GitHoldListingRow<R = Record<string, unknown>> { source_id: string; incarnation: string; count: number; record: R | null }

/**
 * Each listed source with outstanding holds (its summary count above 0) and its first `limit` hold records of the current
 * incarnation in fingerprint order, marked `read_only_checkout` on a read-only mirror; a source with no record listed
 * answers one row with a null record. By source, then fingerprint.
 */
export async function readGitHoldListingRows<R = Record<string, unknown>>(exec: HoldStoreExec, sourceIds: readonly string[], limit: number): Promise<Array<GitHoldListingRow<R>>> {
  if (!sourceIds.length) return [];
  const rows = await exec.executeRaw<{ source_id: string; incarnation: string; count: number | string; record: R | null }>(`SELECT s.id AS source_id,
      s.incarnation::text AS incarnation, COALESCE((sm.completed_keys->0->>'count')::int,0) AS count, h.record
    FROM sources s
    JOIN op_checkpoints sm ON sm.op=$1 AND sm.fingerprint=s.id||':'||s.incarnation::text
    LEFT JOIN LATERAL (SELECT x.fingerprint, CASE WHEN COALESCE(s.config->>'mirror_read_only','false')='true' THEN jsonb_set(x.completed_keys->0,'{read_only_checkout}','true'::jsonb) ELSE x.completed_keys->0 END AS record FROM op_checkpoints x
      WHERE x.op=$2 AND x.completed_keys->0->>'source_id'=s.id AND x.completed_keys->0->>'incarnation'=s.incarnation::text
      ORDER BY x.fingerprint COLLATE "C" LIMIT $4) h ON true
    WHERE s.id=ANY($3::text[]) AND COALESCE((sm.completed_keys->0->>'count')::int,0)>0
    ORDER BY s.id COLLATE "C", h.fingerprint COLLATE "C"`, [GIT_HOLD_SUMMARY_OP, GIT_HOLD_OP, [...sourceIds], Math.max(0, Math.floor(limit))]);
  return rows.map(row => ({ source_id: row.source_id, incarnation: row.incarnation, count: Number(row.count), record: row.record }));
}

/** Each listed source's current-incarnation holds counted per code (`code` null for a record without one), in no set order. */
export async function readGitHoldCodeCountRows(exec: HoldStoreExec, sourceIds: readonly string[]): Promise<Array<{ source_id: string; code: string | null; n: number }>> {
  if (!sourceIds.length) return [];
  const rows = await exec.executeRaw<{ source_id: string; code: string | null; n: number | string }>(`SELECT s.id AS source_id, x.completed_keys->0->>'code' AS code, count(*) AS n
    FROM sources s JOIN op_checkpoints x ON x.op=$1 AND x.completed_keys->0->>'source_id'=s.id AND x.completed_keys->0->>'incarnation'=s.incarnation::text
    WHERE s.id=ANY($2::text[]) GROUP BY 1,2`, [GIT_HOLD_OP, [...sourceIds]]);
  return rows.map(row => ({ source_id: row.source_id, code: row.code, n: Number(row.n) }));
}

/** Each listed source whose current-incarnation summary counts unsupported-image holds, with that count, in no set order. */
export async function readGitImageHoldCountRows(exec: HoldStoreExec, sourceIds: readonly string[]): Promise<Array<{ source_id: string; images: number }>> {
  if (!sourceIds.length) return [];
  const rows = await exec.executeRaw<{ source_id: string; images: number | string }>(`SELECT s.id AS source_id, COALESCE((h.completed_keys->0->>'images')::int,0) AS images
    FROM op_checkpoints h JOIN sources s ON h.fingerprint=s.id||':'||s.incarnation::text
    WHERE h.op=$1 AND s.id=ANY($2::text[]) AND COALESCE((h.completed_keys->0->>'images')::int,0)>0`, [GIT_HOLD_SUMMARY_OP, [...sourceIds]]);
  return rows.map(row => ({ source_id: row.source_id, images: Number(row.images) }));
}

/** The stored conversion log of each listed source's current incarnation (sources without a log row are absent), in no set order. */
export function readSyncConversionRows<C = Record<string, unknown>>(exec: HoldStoreExec, sourceIds: readonly string[]): Promise<Array<{ source_id: string; conversions: C[] | null }>> {
  if (!sourceIds.length) return Promise.resolve([]);
  return exec.executeRaw<{ source_id: string; conversions: C[] | null }>(`SELECT s.id AS source_id, c.completed_keys->0->'conversions' AS conversions
    FROM sources s JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text WHERE s.id=ANY($2::text[])`, [SYNC_CONVERSION_OP, [...sourceIds]]);
}

/**
 * Puts `conversion` first in the source incarnation's conversion log, keeping the newest SYNC_CONVERSION_KEEP; the
 * first write creates the row. The other keys of the stored record stay. Call it in the transaction that saves the
 * converted cursor.
 */
export async function recordSyncConversion(exec: HoldStoreExec, sourceId: string, incarnation: string, conversion: SyncConversion): Promise<void> {
  await exec.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('source_id',$3::text,'incarnation',$4::text,'conversions',$5::text::jsonb)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array((op_checkpoints.completed_keys->0)||jsonb_build_object('conversions',
      (SELECT COALESCE(jsonb_agg(c ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements($5::text::jsonb||COALESCE(op_checkpoints.completed_keys->0->'conversions','[]'::jsonb))
        WITH ORDINALITY AS e(c,n) WHERE n<=$6))),updated_at=now()`,
  [SYNC_CONVERSION_OP, summaryFingerprint(sourceId, incarnation), sourceId, incarnation, JSON.stringify([conversion]), SYNC_CONVERSION_KEEP]);
}

/** A managed sync pass row as read: the stored value (null when the row holds none), its stamp and the database clock at the read. */
export interface SyncPassRowRead<V = Record<string, unknown>> { value: V | null; updated_at: Date | string; read_at: Date | string }

/** The pass row of one source incarnation, or null when no pass has run on it. */
export async function readSyncPassRow<V = Record<string, unknown>>(exec: HoldStoreExec, sourceId: string, incarnation: string): Promise<SyncPassRowRead<V> | null> {
  const [row] = await exec.executeRaw<SyncPassRowRead<V>>(
    'SELECT completed_keys->0 AS value, updated_at, now() AS read_at FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [MANAGED_SYNC_PASS_OP, summaryFingerprint(sourceId, incarnation)]);
  return row ?? null;
}

/** The pass rows of the sources' live incarnations (every source for null `sourceIds`), in no set order. */
export function readLiveSyncPassRows<V = Record<string, unknown>>(exec: HoldStoreExec, sourceIds: readonly string[] | null): Promise<Array<SyncPassRowRead<V> & { source_id: string }>> {
  return exec.executeRaw<SyncPassRowRead<V> & { source_id: string }>(
    `SELECT s.id AS source_id, c.completed_keys->0 AS value, c.updated_at, now() AS read_at FROM sources s
       JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text
      WHERE ($2::text[] IS NULL OR s.id=ANY($2::text[]))`, [MANAGED_SYNC_PASS_OP, sourceIds ? [...sourceIds] : null]);
}

/** `writeSyncPassRow` options: see persistence/sync-pass-row.ts `writePassRow`. */
/** The pass row writes: an upsert, or (`onlyOpen`) an update of an open row; the `_CLOCK` forms stamp `telemetry.started_at` with the database clock. */
const UPSERT_PASS_ROW_SQL = `INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,jsonb_build_array($3::text::jsonb),now())
      ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()
        WHERE ($4::boolean OR op_checkpoints.completed_keys->0->>'lease_token'=$5) RETURNING 1`;
const UPSERT_PASS_ROW_CLOCK_SQL = `INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,jsonb_build_array(jsonb_set($3::text::jsonb,'{telemetry,started_at}',to_jsonb(to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))),now())
      ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()
        WHERE ($4::boolean OR op_checkpoints.completed_keys->0->>'lease_token'=$5) RETURNING 1`;
const UPDATE_OPEN_PASS_ROW_SQL = `UPDATE op_checkpoints SET completed_keys=jsonb_build_array($3::text::jsonb), updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND ($4::boolean OR completed_keys->0->>'lease_token'=$5) AND completed_keys->0->'telemetry'->>'outcome'='open' RETURNING 1`;
const UPDATE_OPEN_PASS_ROW_CLOCK_SQL = `UPDATE op_checkpoints SET completed_keys=jsonb_build_array(jsonb_set($3::text::jsonb,'{telemetry,started_at}',to_jsonb(to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))), updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND ($4::boolean OR completed_keys->0->>'lease_token'=$5) AND completed_keys->0->'telemetry'->>'outcome'='open' RETURNING 1`;

/** Every statement `writeSyncPassRow` can send (op_checkpoints only): the shadow write sampler judges the member by them (shadow/write-capture.ts). */
export const SYNC_PASS_ROW_SQL: readonly string[] = [UPSERT_PASS_ROW_SQL, UPSERT_PASS_ROW_CLOCK_SQL, UPDATE_OPEN_PASS_ROW_SQL, UPDATE_OPEN_PASS_ROW_CLOCK_SQL];

export interface SyncPassRowWrite { pin?: boolean; clock?: boolean; onlyOpen?: boolean }

/**
 * Writes `[value]` as the pass row; false when it did not land. It lands when `pin` is set or the stored row carries
 * `value.lease_token` (no row: it inserts, unless `onlyOpen`), and with `onlyOpen` only on a row whose telemetry
 * outcome is still `open`. `clock` stamps `telemetry.started_at` with the database clock.
 */
export async function writeSyncPassRow(exec: HoldStoreExec, sourceId: string, incarnation: string, value: { lease_token?: unknown }, opts: SyncPassRowWrite = {}): Promise<boolean> {
  const params = [MANAGED_SYNC_PASS_OP, summaryFingerprint(sourceId, incarnation), JSON.stringify(value), opts.pin === true, value.lease_token];
  const sql = opts.onlyOpen ? (opts.clock ? UPDATE_OPEN_PASS_ROW_CLOCK_SQL : UPDATE_OPEN_PASS_ROW_SQL) : (opts.clock ? UPSERT_PASS_ROW_CLOCK_SQL : UPSERT_PASS_ROW_SQL);
  const rows = await exec.executeRaw(sql, params);
  return rows.length > 0;
}
