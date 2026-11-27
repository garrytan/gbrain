/**
 * A resumable op's checkpoint (op-checkpoint.ts; SQL in engine-sql/op-checkpoint.ts and engine-sql/write-misc.ts),
 * served by gbrain-store `persistence::op_checkpoint`: the parent row's completed keys and the op's child paths. An op
 * stopped midway on this engine resumes with the keys it banked. What the store keeps and how it differs:
 * rust/docs/store/persistence.md, "Op checkpoints".
 */
import { MARKDOWN_CHUNKER_VERSION } from '../../chunkers/recursive.ts';
import type { SyncImportPageQuery, SyncImportPageRow, SyncImportPageWindow } from '../../engine-sql/sync-pass-pages.ts';
import { storeCall, type StoreMember } from './common.ts';
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
 * The whole-source sync pass cursor (engine-sql/sync-pass-pages.ts `declareSyncImportPageCursor`, `FETCH n`). The store
 * has no SQL cursor: the declare records the query, and each fetch reads the next keyset page after the last id it
 * returned (readSyncImportPageRows), so the rows come in page id order, one of the orders the statement allows. One cursor
 * per open brain (a slot on the store handle), as one named cursor per transaction on SQL; a fetch with none declared refuses as FETCH does.
 */
const SYNC_PASS_CURSOR = Symbol('gbrain.syncPassCursor');
type SyncPassCursor = { q: SyncImportPageQuery; after: number };
const cursorSlot = (brain: object) => brain as { [SYNC_PASS_CURSOR]?: SyncPassCursor };

export const declareSyncImportPageCursor: StoreMember<[q: SyncImportPageQuery], void> = async (brain, q) => {
  cursorSlot(brain)[SYNC_PASS_CURSOR] = { q: { ...q }, after: 0 };
};

export const fetchSyncImportPageCursor: StoreMember<[rows: number], SyncImportPageRow[]> = async (brain, rows) => {
  if (!Number.isFinite(rows) || !Number.isSafeInteger(rows) || rows < 1) throw new Error(`fetchSyncImportPageCursor: rows must be a positive integer, got ${rows}`);
  const cursor = cursorSlot(brain)[SYNC_PASS_CURSOR];
  if (!cursor) throw new Error('fetchSyncImportPageCursor: no sync pass cursor is open (declareSyncImportPageCursor first)');
  const page = await readSyncImportPageRows(brain, cursor.q, { after: cursor.after, limit: rows });
  if (page.length) cursor.after = Number(page[page.length - 1]!.id);
  if (page.length < rows) delete cursorSlot(brain)[SYNC_PASS_CURSOR];
  return page;
};


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
/** The atom generation a page's content keys on (op_checkpoint.rs `read_atom_generation`). */
export const readAtomGeneration: StoreMember<[pageId: number, contentHash: string], number> = (brain, pageId, contentHash) =>
  storeCall({ member: 'readAtomGeneration' }, () => brain.readAtomGeneration(pageId, contentHash));

/** A page's atom generation bump (op_checkpoint.rs `record_atom_generation_bump`); the store keeps no extract_atoms_page_state rows. */
export const recordAtomGenerationBump: StoreMember<[sourceId: string, incarnation: string, pageId: number, keepContentHash: string | null, keepGeneration: number | null], void> =
  async (brain, sourceId, incarnation, pageId, keepContentHash, keepGeneration) => {
    await storeCall({ member: 'recordAtomGenerationBump' }, () =>
      brain.recordAtomGenerationBump({ sourceId, incarnation, pageId, keepContentHash, keepGeneration }));
  };
/** The checkpoints stamped more than `ttlDays` days ago and not exempt deleted with their paths; how many. */
export const purgeStaleCheckpoints: StoreMember<[ttlDays: number], number> = (brain, ttlDays) =>
  storeCall({ member: 'purgeStaleCheckpoints' }, () => brain.purgeStaleCheckpoints(ttlDays));
/**
 * `purgeStaleAppliedCaptures`: the store keeps no applied captures (every writer, ingestion/applied-captures.ts, goes
 * through `executeRaw`, which this engine refuses), so none is stale.
 */
export const purgeStaleAppliedCaptures: StoreMember<[ttlDays: number], number> = async () => 0;

/** One soak counter added to (persistence/op_checkpoint.rs `add_soak_counter_event_in`, one store write). */
export const addSoakCounterEvent: StoreMember<[op: string, day: string, kind: string, n: number], void> = async (brain, op, day, kind, n) => {
  await storeCall({ member: 'addSoakCounterEvent' }, () => brain.addSoakCounterEvent(op, day, kind, n));
};

