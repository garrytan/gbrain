/**
 * `I⋈P` of a managed sync pass (persistence/sync-pass.ts `readPages`): every page of a source with a recorded origin,
 * joined with the fields of its sync import provenance record that the classifier reads. One statement text, sent in
 * three shapes, each byte for byte the statement sync-pass.ts ran before it became a member (pinned by
 * test/engine-sql-caller-raw-sql-pins.test.ts):
 *  - a window of page ids (a confirm round) and a keyset page (PGLite's full read): `readSyncImportPageRows`;
 *  - Postgres's full read, a `NO SCROLL` cursor over the statement with its record subquery kept unflattened by
 *    `OFFSET 0`: `declareSyncImportPageCursor`, then `fetchSyncImportPageCursor` until a short page.
 * The statement text comes from `syncImportPagesSql` (persistence/sync-pass-pages-sql.ts). Each runs on the engine's
 * own `executeRaw`, so inside `transaction()` it reads the round's snapshot. A Rust brain serves `readSyncImportPageRows` from its store
 * (rust/crates/gbrain-store/src/persistence/sync_pass_pages.rs); it has no cursor, so the two cursor members refuse
 * there by name.
 */
import type { BrainEngine } from '../engine.ts';
import type { SyncImportParser } from '../persistence/sync-holds.ts';
import { SYNC_IMPORT_PROVENANCE_OP, syncImportPagesSql } from '../persistence/sync-pass-pages-sql.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The pages a `readSyncImportPageRows` call reads: the named ids, or the next `limit` pages after page id `after`. */
export type SyncImportPageWindow = { ids: readonly string[] } | { after: number; limit: number };

/** One source's `I⋈P`: the pages of `sourceId` and their records of import `incarnation`; `expected` is the parser the level expects. */
export interface SyncImportPageQuery { sourceId: string; incarnation: string; expected: SyncImportParser }

/**
 * One `I⋈P` row. A record field that repeats the page's comes back as a flag (`rec_origin_same`, `rec_disk_same`, a NULL
 * `rec_revision`, `rec_parser_expected`) instead of a second copy. `id` is the driver's bigint (a number on PGLite and
 * Rust, a string on Postgres).
 */
export interface SyncImportPageRow {
  id: number | string; slug: string; source_path: string; revision: string; deleted: boolean; request_id: string | null;
  has_record: boolean; rec_origin_same: boolean; rec_origin: string | null; rec_blob_oid: string | null; rec_disk_same: boolean;
  rec_disk_blob_oid: string | null; rec_revision_null: boolean; rec_revision: string | null; rec_parser: string | null;
  rec_parser_expected: boolean | null; rec_full_episode: string | null; rec_working: string | null; derived_current: boolean | null;
  sync_deleted: boolean | null;
}

/** The cursor `declareSyncImportPageCursor` opens; it lives until the transaction ends. */
const CURSOR = 'sync_pass_pages';

/**
 * `$1`..`$4`. `$4` binds the expected parser as an object, never its JSON text: postgres.js sends a string bound to
 * `$4::jsonb` as a jsonb string scalar (CLAUDE.md, the positional double-encode trap), so no record's parser equalled it
 * and every Postgres row carried its parser text. PGLite takes the object the same way.
 */
function params(q: SyncImportPageQuery): unknown[] {
  return [q.sourceId, SYNC_IMPORT_PROVENANCE_OP, `${q.sourceId}:${q.incarnation}:`, q.expected];
}

/** The window's rows in page id order: the named ids (an id with no `I⋈P` row is absent), or a keyset page. */
export async function readSyncImportPageRows(raw: Raw, q: SyncImportPageQuery, window: SyncImportPageWindow): Promise<SyncImportPageRow[]> {
  if ('ids' in window) return raw.executeRaw<SyncImportPageRow>(syncImportPagesSql({ shape: 'ids' }), [...params(q), [...window.ids]]);
  return raw.executeRaw<SyncImportPageRow>(syncImportPagesSql({ shape: 'keyset', limit: window.limit }), [...params(q), window.after]);
}

/**
 * Opens the whole-source cursor: `cursor_tuple_fraction = 1` (keep the whole-result plan) and the `DECLARE`, both sent
 * before this returns, so fetches queued right after it run behind them on the transaction's connection.
 */
export function declareSyncImportPageCursor(raw: Raw, q: SyncImportPageQuery): Promise<void> {
  const sent = Promise.all([raw.executeRaw('SET LOCAL cursor_tuple_fraction = 1'), raw.executeRaw(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${syncImportPagesSql({ shape: 'cursor' })}`, params(q))]);
  return sent.then(() => undefined);
}

/** The cursor's next `rows` rows; fewer means the cursor is done. */
export function fetchSyncImportPageCursor(raw: Raw, rows: number): Promise<SyncImportPageRow[]> {
  if (!Number.isFinite(rows) || !Number.isSafeInteger(rows) || rows < 1) return Promise.reject(new Error(`fetchSyncImportPageCursor: rows must be a positive integer, got ${rows}`));
  return raw.executeRaw<SyncImportPageRow>(`FETCH ${rows} FROM ${CURSOR}`);
}
