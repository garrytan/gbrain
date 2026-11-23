/**
 * A resumable op's checkpoint (op-checkpoint.ts; SQL in engine-sql/op-checkpoint.ts and engine-sql/write-misc.ts),
 * served by gbrain-store `persistence::op_checkpoint`: the parent row's completed keys and the op's child paths. An op
 * stopped midway on this engine resumes with the keys it banked. What the store keeps and how it differs:
 * rust/docs/store/persistence.md, "Op checkpoints".
 */
import { MARKDOWN_CHUNKER_VERSION } from '../../chunkers/recursive.ts';
import type { SyncImportPageQuery, SyncImportPageRow, SyncImportPageWindow } from '../../engine-sql/sync-pass-pages.ts';
import { storeCall, type StoreMember } from './common.ts';
import { FENCE_UNCOMMITTED_OP } from '../../fence-repair/uncommitted-op.ts';
import type { OpCheckpointRecord } from '../../engine-sql/write-misc.ts';

/**
 * The op's completed keys: the child paths in path order, then the parent's array, each key once. `corruptParent` is
 * true when the parent's keys are not an array (the store never writes one; a SQL brain's CHECK refuses one).
 */
export const readOpCheckpointKeys: StoreMember<[op: string, fingerprint: string], { keys: string[]; corruptParent: boolean }> =
  (brain, op, fingerprint) => storeCall({ member: 'readOpCheckpointKeys' }, () => brain.readOpCheckpointKeys(op, fingerprint));

/** The parent's keys replaced with `keys`, stamped now; the child paths stay. */
export const writeOpCheckpointKeys: StoreMember<[op: string, fingerprint: string, keys: string[]], void> = async (brain, op, fingerprint, keys) => {
  await storeCall({ member: 'writeOpCheckpointKeys' }, () => brain.writeOpCheckpointKeys(op, fingerprint, keys));
};

/** The parent created with no keys or stamped now, then each path not yet banked added. */
export const appendOpCheckpointPaths: StoreMember<[op: string, fingerprint: string, paths: string[]], void> = async (brain, op, fingerprint, paths) => {
  await storeCall({ member: 'appendOpCheckpointPaths' }, () => brain.appendOpCheckpointPaths(op, fingerprint, paths));
};

/** The parent and its paths deleted; a missing parent is a no-op. */
export const deleteOpCheckpoint: StoreMember<[op: string, fingerprint: string], void> = async (brain, op, fingerprint) => {
  await storeCall({ member: 'deleteOpCheckpoint' }, () => brain.deleteOpCheckpoint(op, fingerprint));
};

/** The paths deleted, the parent kept. */
export const deleteOpCheckpointPaths: StoreMember<[op: string, fingerprint: string], void> = async (brain, op, fingerprint) => {
  await storeCall({ member: 'deleteOpCheckpointPaths' }, () => brain.deleteOpCheckpointPaths(op, fingerprint));
};

/** Each found parent's first completed key (`completed_keys->0`, null for an empty array), one per parent found. */
export const readOpCheckpointRecords: StoreMember<[op: string, fingerprints: readonly string[]], unknown[]> =
  (brain, op, fingerprints) => storeCall({ member: 'readOpCheckpointRecords' }, () => brain.readOpCheckpointRecords(op, [...fingerprints]));

/**
 * The uncommitted fence-repair notices: every `fence-repair-uncommitted` parent in key order (byte order of fingerprint,
 * as `ORDER BY fingerprint COLLATE "C"`), with its first completed key (null for an empty or non-array value, as
 * `completed_keys->0` reads), kept when `sourceIds` is null or names the record's `source_id` text.
 */
export const listUncommittedFenceRepairRows: StoreMember<[sourceIds: readonly string[] | null], Array<{ fingerprint: string; record: unknown }>> =
  async (brain, sourceIds) => {
    const rows = await storeCall({ member: 'listUncommittedFenceRepairRows' }, () => brain.listOpCheckpointRecords(FENCE_UNCOMMITTED_OP)) as Array<{ fingerprint: string; completed_keys: unknown }>;
    const wanted = sourceIds === null ? null : new Set(sourceIds);
    const out: Array<{ fingerprint: string; record: unknown }> = [];
    for (const row of rows) {
      const record = Array.isArray(row.completed_keys) ? row.completed_keys[0] ?? null : null;
      const sourceId = jsonText((record as Record<string, unknown> | null)?.source_id);
      if (wanted !== null && (sourceId === null || !wanted.has(sourceId))) continue;
      out.push({ fingerprint: row.fingerprint, record });
    }
    return out;
  };

/** The text `->>` reads from a JSON value: a string as itself, any other non-null value as its JSON, null as null. */
function jsonText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Each row's parent set to `[record]`, stamped now; the child paths stay. A record holding NUL is refused whole. */
export const writeOpCheckpointRecords: StoreMember<[op: string, rows: ReadonlyArray<{ fingerprint: string; record: unknown }>], void> = async (brain, op, rows) => {
  await storeCall({ member: 'writeOpCheckpointRecords' }, () => brain.writeOpCheckpointRecords(op, rows.map(({ fingerprint, record }) => ({ fingerprint, record }))));
};

/**
 * A sync pass's `I⋈P` rows (engine-sql/sync-pass-pages.ts): the store reads the pages and their import records itself, so
 * it is sent the Markdown chunker version the SQL statement embeds.
 */
export const readSyncImportPageRows: StoreMember<[q: SyncImportPageQuery, window: SyncImportPageWindow], SyncImportPageRow[]> = (brain, q, window) =>
  storeCall({ member: 'readSyncImportPageRows' }, () => brain.readSyncImportPageRows(
    { sourceId: q.sourceId, incarnation: q.incarnation, expected: q.expected, chunkerVersion: MARKDOWN_CHUNKER_VERSION },
    'ids' in window ? { ids: [...window.ids] } : { after: window.after, limit: window.limit }));


/**
 * A checkpoint parent whose keys are JSON records (the repair cursor, the preview-approval sets), or null; its stamp in
 * ISO 8601 with milliseconds, and `fresh` against the store clock when `freshWithinDays` is given.
 */
export const readOpCheckpointRecord: StoreMember<[op: string, fingerprint: string, opts?: { freshWithinDays?: number }], OpCheckpointRecord | null> =
  (brain, op, fingerprint, opts) => storeCall({ member: 'readOpCheckpointRecord' }, () =>
    brain.readOpCheckpointRecord(op, fingerprint, opts?.freshWithinDays ?? null));

/** The parent's records replaced and stamped now; `null` deletes the parent and its paths. */
export const writeOpCheckpointRecord: StoreMember<[op: string, fingerprint: string, completedKeys: readonly unknown[] | null], void> =
  async (brain, op, fingerprint, completedKeys) => {
    await storeCall({ member: 'writeOpCheckpointRecord' }, () => brain.writeOpCheckpointRecord(op, fingerprint, completedKeys));
  };
/** The checkpoints stamped more than `ttlDays` days ago and not exempt deleted with their paths; how many. */
export const purgeStaleCheckpoints: StoreMember<[ttlDays: number], number> = (brain, ttlDays) =>
  storeCall({ member: 'purgeStaleCheckpoints' }, () => brain.purgeStaleCheckpoints(ttlDays));
