/**
 * A resumable op's checkpoint (op-checkpoint.ts; SQL in engine-sql/op-checkpoint.ts and engine-sql/write-misc.ts),
 * served by gbrain-store `persistence::op_checkpoint`: the parent row's completed keys and the op's child paths. An op
 * stopped midway on this engine resumes with the keys it banked. What the store keeps and how it differs:
 * rust/docs/store/persistence.md, "Op checkpoints".
 */
import { MARKDOWN_CHUNKER_VERSION } from '../../chunkers/recursive.ts';
import type { SyncImportPageQuery, SyncImportPageRow, SyncImportPageWindow } from '../../engine-sql/sync-pass-pages.ts';
import { storeCall, type StoreMember } from './common.ts';

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


/** The checkpoints stamped more than `ttlDays` days ago and not exempt deleted with their paths; how many. */
export const purgeStaleCheckpoints: StoreMember<[ttlDays: number], number> = (brain, ttlDays) =>
  storeCall({ member: 'purgeStaleCheckpoints' }, () => brain.purgeStaleCheckpoints(ttlDays));
