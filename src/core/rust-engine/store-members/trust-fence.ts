/**
 * The fence guard's read of a page's fact rows with their trust tier (BrainEngine listFenceFactRows;
 * engine-sql/trust-fence.ts on the SQL engines).
 *
 * The store reads the writer's tier and the opened fact ids from its write trust context (rust/docs/store/write_trust.md),
 * which the engine's transaction sets in place of `gbrain.write_trust_tier` and `gbrain.write_open_facts`; with none set,
 * the writer is undeclared (`unknown`) and nothing is opened. Every stored fact reads as `unknown` (Rust facts store no
 * tier yet), so only an opened row, or a writer below `unknown`, lists a row. What the read answers and why:
 * rust/docs/store/facts.md, "The fence guard's reads".
 *
 * `listHeldRows` (the held-row read of trust/fence-guard.ts `heldRows`) is served for timeline rows, which the store stamps
 * with their tier (rust/docs/store/timeline.md). Take rows store no tier yet, so a takes read refuses. The store runs one
 * write at a time, so the SQL's `FOR UPDATE` lock has nothing to add.
 */
import type { FenceFactRow, HeldRowsQuery } from '../../engine-sql/trust-fence.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

export const listFenceFactRows: StoreMember<[target: { sourceId: string; slug: string; incoming: string }], FenceFactRow[]> = async (brain, target) => {
  const rows = await storeCall({ member: 'listFenceFactRows', slug: target.slug, sourceId: target.sourceId },
    () => brain.listFenceFactRows({ sourceId: target.sourceId, slug: target.slug, incoming: target.incoming })) as FenceFactRow[];
  return rows.map((row) => ({ ...row, id: Number(row.id), row_num: Number(row.row_num) }));
};

export const listHeldRows: StoreMember<[q: HeldRowsQuery], Array<{ id: number; trust_tier: string }>> = async (brain, q) => {
  const member = 'listHeldRows';
  if (q.table !== 'timeline_entries') refuseMember(member, `table ${String(q.table)}: the store keeps no trust tier on it`);
  if (!Number.isSafeInteger(q.pageId) || !q.ids.every(Number.isSafeInteger)) refuseMember(member, 'a page or row id that is not an integer');
  if (q.writer !== undefined && typeof q.writer !== 'string') refuseMember(member, 'a writer tier that is not text');
  if (!q.ids.length) return [];
  const rows = await storeCall({ member }, () => brain.listHeldRows({
    table: q.table, pageId: q.pageId, ids: [...q.ids], ...(q.writer !== undefined ? { writer: q.writer } : {}), pending: q.pending === true,
  })) as Array<{ id: number; trust_tier: string }>;
  return rows.map(row => ({ id: Number(row.id), trust_tier: row.trust_tier }));
};
