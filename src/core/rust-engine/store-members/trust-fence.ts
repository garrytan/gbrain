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
import { callerMember, grantedPrivateFactSql, memberPageSlug } from '../../access/member-facts.ts';
import { privatePagesFilterForCaller } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePageTextPolicy } from './private-provenance.ts';

export const listFenceFactRows: StoreMember<[target: { sourceId: string; slug: string; incoming: string }], FenceFactRow[]> = async (brain, target) => {
  const rows = await storeCall({ member: 'listFenceFactRows', slug: target.slug, sourceId: target.sourceId },
    () => brain.listFenceFactRows({ sourceId: target.sourceId, slug: target.slug, incoming: target.incoming })) as FenceFactRow[];
  return rows.map((row) => ({ ...row, id: Number(row.id), row_num: Number(row.row_num) }));
};

/**
 * GST-2891: the fence cells held from a world-only fact reader (BrainEngine listHeldFenceCells; heldRowSql on the SQL
 * engines). The store answers a caller with no private-facts grant, where heldRowSql renders that admission as FALSE: a
 * cell is held when the page's live fact at its row number is narrower than world, or when a live narrower fact of the
 * page states its claim (contains it, for a cut claim) and no live world fact of the page does. For a member caller the
 * member passes its page, principal and page policy (`privatePagesFilterForCaller`, which memberFactAdmitSql applies to
 * the member page), and the store does not count the private facts of that page as narrower while the caller may read
 * the live page. A private-facts grant, or a member caller whose page policy is not one the store renders, refuses here;
 * heldFenceLines then holds every fence row line (fail closed), as it does for any failed lookup.
 * rust/docs/store/facts.md, "Held fence cells".
 */
export const listHeldFenceCells: StoreMember<[keys: readonly HeldFenceCellKey[]], HeldFenceCellRow[]> = async (brain, keys) => {
  if (!keys.length) return [];
  if (grantedPrivateFactSql('hr') !== 'FALSE') refuseMember('listHeldFenceCells', 'a private-facts grant');
  const own = callerMember();
  const member = own === null ? undefined : {
    slug: memberPageSlug(own),
    principal: `member:${own}`,
    policy: storePageTextPolicy('listHeldFenceCells', () => privatePagesFilterForCaller('p'), { callerReaders: true }),
  };
  const rows = await storeCall({ member: 'listHeldFenceCells' },
    () => brain.listHeldFenceCells(member ? { keys, member } : { keys })) as HeldFenceCellRow[];
  return rows.map((row) => ({ ...row, row_num: Number(row.row_num) }));
};
