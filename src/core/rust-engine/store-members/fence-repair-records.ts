/**
 * The bookkeeping members of the fence and slug-conflict repairs (engine-sql/fence-repair-records.ts) on the Rust store:
 * the attempt store's compare-and-swap (persistence/op_checkpoint.rs, one store write each), the per-source checkpoint
 * listing and the oldest sync hold (over `listOpCheckpointRecords`, the store's listing of one op's parents in
 * fingerprint byte order), and the last finished job (jobs/status.rs). rust/docs/store/repair-fences.md.
 */
import type { SourceCheckpointRecord } from '../../engine-sql/fence-repair-records.ts';
import { storeCall, type StoreMember } from './common.ts';

interface CheckpointRow { fingerprint: string; completed_keys: unknown }

const firstRecord = (row: CheckpointRow): Record<string, unknown> | undefined =>
  Array.isArray(row.completed_keys) ? row.completed_keys[0] as Record<string, unknown> | undefined : undefined;

const listOp = (brain: Parameters<StoreMember<[], unknown>>[0], member: string, op: string) =>
  storeCall({ member }, () => brain.listOpCheckpointRecords(op)) as Promise<CheckpointRow[]>;

/** The first record of each `op` parent naming one of `sourceIds` as `source_id` (every one when null), in fingerprint byte order. */
export const listSourceCheckpointRecords: StoreMember<[op: string, sourceIds: readonly string[] | null], SourceCheckpointRecord<unknown>[]> = async (brain, op, sourceIds) => {
  const wanted = sourceIds ? new Set(sourceIds) : null;
  return (await listOp(brain, 'listSourceCheckpointRecords', op))
    .filter(row => wanted === null || (typeof firstRecord(row)?.source_id === 'string' && wanted.has(firstRecord(row)!.source_id as string)))
    .map(row => ({ fingerprint: row.fingerprint, record: firstRecord(row) ?? null }));
};

export const insertOpCheckpointIfAbsent: StoreMember<[op: string, fingerprint: string, completedKeys: readonly unknown[]], boolean> = (brain, op, fingerprint, completedKeys) =>
  storeCall({ member: 'insertOpCheckpointIfAbsent' }, () => brain.insertOpCheckpointIfAbsent(op, fingerprint, [...completedKeys])) as Promise<boolean>;

export const replaceOpCheckpointAtVersion: StoreMember<[op: string, fingerprint: string, completedKeys: readonly unknown[], expected: number], boolean> =
  (brain, op, fingerprint, completedKeys, expected) =>
    storeCall({ member: 'replaceOpCheckpointAtVersion' }, () => brain.replaceOpCheckpointAtVersion(op, fingerprint, [...completedKeys], expected)) as Promise<boolean>;

/** The sync run's trend row: stored as given, or rewritten keeping the first write's `day` (one store write). */
export const upsertFenceTrendRunRecord: StoreMember<[op: string, fingerprint: string, record: unknown], void> = async (brain, op, fingerprint, record) => {
  await storeCall({ member: 'upsertFenceTrendRunRecord' }, () => brain.upsertFenceTrendRunRecord(op, fingerprint, record));
};

/** The earliest `held_at` text of the sources' `sync-hold` records with hold code `code`, by text order as `min(text)` compares it, or null. */
export const readOldestSyncHoldAt: StoreMember<[code: string, sourceIds: readonly string[]], string | null> = async (brain, code, sourceIds) => {
  const wanted = new Set(sourceIds);
  let oldest: string | null = null;
  for (const row of await listOp(brain, 'readOldestSyncHoldAt', 'sync-hold')) {
    const record = firstRecord(row);
    if (!record || record.code !== code || typeof record.source_id !== 'string' || !wanted.has(record.source_id)) continue;
    const at = record.held_at;
    if (at == null) continue;
    const text = typeof at === 'string' ? at : JSON.stringify(at);
    if (oldest === null || text < oldest) oldest = text;
  }
  return oldest;
};

export const readLastFinishedJobAt: StoreMember<[name: string], string | null> = (brain, name) =>
  storeCall({ member: 'readLastFinishedJobAt' }, () => brain.readLastFinishedJobAt(name)) as Promise<string | null>;
