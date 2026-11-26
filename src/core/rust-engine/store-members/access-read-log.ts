/**
 * The access read log (src/core/engine-sql/access-read-log.ts), served from the store
 * (rust/crates/gbrain-store/src/access_read_log.rs; rust/docs/store/telemetry.md, "Access read log"): the read-log
 * writer's batched insert and retention prune, and the reads of `gbrain access log` and `gbrain access who-read`.
 * Times cross the binding as ISO text; the callers read them with `new Date(...)`, as they read the Dates PGLite and
 * Postgres return.
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 */
import type { AccessReadLogEntryRow, AccessReadTallyRow, ReadLogRow } from '../../engine-sql/access-read-log.ts';
import { storeCall, type StoreMember } from './common.ts';

export const insertAccessReadLogRows: StoreMember<[rows: readonly ReadLogRow[]], void> = async (brain, rows) => {
  await storeCall({ member: 'insertAccessReadLogRows' }, () => brain.insertAccessReadLogRows(rows.map(r => ({ ...r }))));
};

export const pruneAccessReadLog: StoreMember<[days: number, maxRows: number], void> = async (brain, days, maxRows) => {
  await storeCall({ member: 'pruneAccessReadLog' }, () => brain.pruneAccessReadLog(days, maxRows));
};

export const readAccessReadLog: StoreMember<[query: { since: string; member: string | null; limit: number }], AccessReadLogEntryRow[]> = (brain, q) =>
  storeCall({ member: 'readAccessReadLog' }, () => brain.readAccessReadLog({ since: q.since, member: q.member, limit: q.limit })) as Promise<AccessReadLogEntryRow[]>;

export const listAccessReadPageRefs: StoreMember<[slug: string, sourceId: string | null], Array<{ id: number; source_id: string; slug: string }>> = (brain, slug, sourceId) =>
  storeCall({ member: 'listAccessReadPageRefs' }, () => brain.listAccessReadPageRefs(slug, sourceId)) as Promise<Array<{ id: number; source_id: string; slug: string }>>;

export const readAccessReadsOfPages: StoreMember<[query: { pageIds: readonly number[]; since: string; limit: number }], AccessReadLogEntryRow[]> = (brain, q) =>
  storeCall({ member: 'readAccessReadsOfPages' }, () => brain.readAccessReadsOfPages({ pageIds: [...q.pageIds], since: q.since, limit: q.limit })) as Promise<AccessReadLogEntryRow[]>;

export const tallyAccessReadsOfPages: StoreMember<[query: { pageIds: readonly number[]; since: string }], AccessReadTallyRow[]> = (brain, q) =>
  storeCall({ member: 'tallyAccessReadsOfPages' }, () => brain.tallyAccessReadsOfPages({ pageIds: [...q.pageIds], since: q.since })) as Promise<AccessReadTallyRow[]>;
