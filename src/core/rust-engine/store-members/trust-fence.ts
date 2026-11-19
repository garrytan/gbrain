/**
 * The fence guard's read of a page's fact rows with their trust tier (BrainEngine listFenceFactRows;
 * engine-sql/trust-fence.ts on the SQL engines), and the held fence cells of a world-only fact read (listHeldFenceCells;
 * engine-sql/cli-reads-ops.ts).
 *
 * The store reads the writer's tier and the opened fact ids from its write trust context (rust/docs/store/write_trust.md),
 * which the engine's transaction sets in place of `gbrain.write_trust_tier` and `gbrain.write_open_facts`; with none set,
 * the writer is undeclared (`unknown`) and nothing is opened. Every stored fact reads as `unknown` (Rust facts store no
 * tier yet), so only an opened row, or a writer below `unknown`, lists a row. What the read answers and why:
 * rust/docs/store/facts.md, "The fence guard's reads".
 */
import type { FenceFactRow } from '../../engine-sql/trust-fence.ts';
import type { HeldFenceCellKey, HeldFenceCellRow } from '../../engine-sql/cli-reads-ops.ts';
import { grantedPrivateFactSql, memberFactAdmitSql } from '../../access/member-facts.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

export const listFenceFactRows: StoreMember<[target: { sourceId: string; slug: string; incoming: string }], FenceFactRow[]> = async (brain, target) => {
  const rows = await storeCall({ member: 'listFenceFactRows', slug: target.slug, sourceId: target.sourceId },
    () => brain.listFenceFactRows({ sourceId: target.sourceId, slug: target.slug, incoming: target.incoming })) as FenceFactRow[];
  return rows.map((row) => ({ ...row, id: Number(row.id), row_num: Number(row.row_num) }));
};

/**
 * GST-2891: the fence cells held from a world-only fact reader (BrainEngine listHeldFenceCells; heldRowSql on the SQL
 * engines). The store answers the caller with no member page and no private-facts grant, where heldRowSql renders both
 * admissions as FALSE: a cell is held when the page's live fact at its row number is not world, or when a live fact of
 * the page that is not world states its claim (contains it, for a cut claim) and no live world fact of the page does.
 * A member caller or a private-facts grant renders the admissions for itself and refuses here; heldFenceLines then holds
 * every fence row line (fail closed), as it does for any failed lookup. rust/docs/store/facts.md, "Held fence cells".
 */
export const listHeldFenceCells: StoreMember<[keys: readonly HeldFenceCellKey[]], HeldFenceCellRow[]> = async (brain, keys) => {
  if (!keys.length) return [];
  if (memberFactAdmitSql('hr') !== 'FALSE') refuseMember('listHeldFenceCells', "a member caller's own page facts");
  if (grantedPrivateFactSql('hr') !== 'FALSE') refuseMember('listHeldFenceCells', 'a private-facts grant');
  const rows = await storeCall({ member: 'listHeldFenceCells' }, () => brain.listHeldFenceCells({ keys })) as HeldFenceCellRow[];
  return rows.map((row) => ({ ...row, row_num: Number(row.row_num) }));
};
