/**
 * The bookkeeping statements of `gbrain repair fences` and `gbrain repair slug-conflicts` and their helpers, as typed
 * members: the fence repair attempt store's compare-and-swap (fence-repair/attempts.ts), the per-source checkpoint
 * listing of uncommitted repairs (fence-repair/uncommitted.ts), the oldest hold each kind's verification reports
 * (repair/fences.ts, repair/slug-conflicts.ts) and the last finished maintenance job (fence-repair/hold-fix.ts). Both SQL
 * engines delegate here; the Rust store serves the same members (persistence/op_checkpoint.rs, jobs/status.rs and
 * rust-engine/store-members/fence-repair-records.ts). rust/docs/store/repair-fences.md.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One checkpoint parent of an op: its fingerprint and its first record. */
export interface SourceCheckpointRecord<R> { fingerprint: string; record: R }

/**
 * The first record of each `op` checkpoint whose record names one of `sourceIds` as `source_id` (every one when null), in
 * fingerprint byte order.
 */
export async function listSourceCheckpointRecords<R>(exec: Raw, op: string, sourceIds: readonly string[] | null): Promise<SourceCheckpointRecord<R>[]> {
  return exec.executeRaw<SourceCheckpointRecord<R>>(`SELECT fingerprint, completed_keys->0 AS record FROM op_checkpoints
    WHERE op=$1 AND ($2::text[] IS NULL OR completed_keys->0->>'source_id'=ANY($2::text[])) ORDER BY fingerprint COLLATE "C"`, [op, sourceIds ? [...sourceIds] : null]);
}

/** Stores the checkpoint parent with `completedKeys` when none exists; true when this call stored it. */
export async function insertOpCheckpointIfAbsent(exec: Raw, op: string, fingerprint: string, completedKeys: readonly unknown[]): Promise<boolean> {
  const rows = await exec.executeRaw(
    'INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ($1, $2, $3::text::jsonb, now()) ON CONFLICT (op, fingerprint) DO NOTHING RETURNING 1',
    [op, fingerprint, JSON.stringify(completedKeys)]);
  return rows.length === 1;
}

/** Replaces the parent's records only while its first record's `v` is `expected`; true when this call replaced them. */
export async function replaceOpCheckpointAtVersion(exec: Raw, op: string, fingerprint: string, completedKeys: readonly unknown[], expected: number): Promise<boolean> {
  const rows = await exec.executeRaw(
    "UPDATE op_checkpoints SET completed_keys = $3::text::jsonb, updated_at = now() WHERE op = $1 AND fingerprint = $2 AND (completed_keys->0->>'v')::int = $4 RETURNING 1",
    [op, fingerprint, JSON.stringify(completedKeys), expected]);
  return rows.length === 1;
}

/**
 * The fence trend row of one sync run (fence-repair/census-store.ts recordSyncRunTrend): stored as `record` when the
 * parent is new; a rewrite of the run replaces the record but keeps the `day` of the first write, so a run counts once.
 */
export async function upsertFenceTrendRunRecord(exec: Raw, op: string, fingerprint: string, record: unknown): Promise<void> {
  await exec.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,$3::text::jsonb,now())
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=jsonb_build_array((EXCLUDED.completed_keys->0)||jsonb_build_object('day',op_checkpoints.completed_keys->0->'day')),updated_at=now()`,
  [op, fingerprint, JSON.stringify([record])]);
}

/** The earliest `held_at` of the sources' Git sync holds with hold code `code`, or null. */
export async function readOldestSyncHoldAt(exec: Raw, code: string, sourceIds: readonly string[]): Promise<string | null> {
  const [row] = await exec.executeRaw<{ held_at: string | null }>(`SELECT min(completed_keys->0->>'held_at') AS held_at FROM op_checkpoints
    WHERE op='sync-hold' AND completed_keys->0->>'code'=$2 AND completed_keys->0->>'source_id'=ANY($1::text[])`, [[...sourceIds], code]);
  return row?.held_at ?? null;
}

/** The latest `finished_at` of the completed jobs named `name`, as UTC ISO seconds (`YYYY-MM-DDTHH:MM:SSZ`), or null. */
export async function readLastFinishedJobAt(exec: Raw, name: string): Promise<string | null> {
  const [row] = await exec.executeRaw<{ at: string | null }>(`SELECT to_char(max(finished_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
    FROM minion_jobs WHERE name=$1 AND status='completed'`, [name]);
  return row?.at ?? null;
}
