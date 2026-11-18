/**
 * The fence guard's read of a page's fact rows with their trust tier (BrainEngine listFenceFactRows;
 * engine-sql/trust-fence.ts on the SQL engines).
 *
 * The store answers in the default write context: no declared writer tier (read as `unknown`) and no opened fact ids,
 * because the Rust engine has no transaction settings to read them from. Every stored fact reads as `unknown`, which is
 * not above `unknown`, so the answer is empty until the write context reaches the store. What the read answers and why:
 * rust/docs/store/facts.md, "The fence guard's reads".
 */
import type { FenceFactRow } from '../../engine-sql/trust-fence.ts';
import { storeCall, type StoreMember } from './common.ts';

export const listFenceFactRows: StoreMember<[target: { sourceId: string; slug: string; incoming: string }], FenceFactRow[]> = async (brain, target) => {
  const rows = await storeCall({ member: 'listFenceFactRows', slug: target.slug, sourceId: target.sourceId },
    () => brain.listFenceFactRows({ sourceId: target.sourceId, slug: target.slug, incoming: target.incoming })) as FenceFactRow[];
  return rows.map((row) => ({ ...row, id: Number(row.id), row_num: Number(row.row_num) }));
};
