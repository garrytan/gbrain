/**
 * The fence guard's read of a page's fact rows with their trust tier (BrainEngine listFenceFactRows;
 * engine-sql/trust-fence.ts on the SQL engines), fence-guard's held timeline rows (listHeldTimelineRows; the same module), the held fence cells of a world-only fact read (listHeldFenceCells;
 * engine-sql/cli-reads-ops.ts), and the fence overlay's read of one page (readFenceOverlayRows; engine-sql/cli-reads-ops.ts).
 *
 * The store reads the writer's tier and the opened fact ids from its write trust context (rust/docs/store/write_trust.md),
 * which the engine's transaction sets in place of `gbrain.write_trust_tier` and `gbrain.write_open_facts`; with none set,
 * the writer is undeclared (`unknown`) and nothing is opened. Every stored fact reads as `unknown` (Rust facts store no
 * tier yet), so only an opened row, or a writer below `unknown`, lists a row. What the read answers and why:
 * rust/docs/store/facts.md, "The fence guard's reads".
 */
import type { FenceFactRow, HeldTimelineRow, HeldTimelineRowsSpec } from '../../engine-sql/trust-fence.ts';
import type { FenceOverlayIncomingRow, FenceOverlayRow, HeldFenceCellKey, HeldFenceCellRow } from '../../engine-sql/cli-reads-ops.ts';
import { callerMember, grantedPrivateFactSql, memberFactAdmitSql, memberPageSlug } from '../../access/member-facts.ts';
import { privateFactSources, privatePagesFilterForCaller } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePageTextPolicy } from './private-provenance.ts';

export const listFenceFactRows: StoreMember<[target: { sourceId: string; slug: string; incoming: string }], FenceFactRow[]> = async (brain, target) => {
  const rows = await storeCall({ member: 'listFenceFactRows', slug: target.slug, sourceId: target.sourceId },
    () => brain.listFenceFactRows({ sourceId: target.sourceId, slug: target.slug, incoming: target.incoming })) as FenceFactRow[];
  return rows.map((row) => ({ ...row, id: Number(row.id), row_num: Number(row.row_num) }));
};

/**
 * Fence-guard's held timeline rows (BrainEngine listHeldTimelineRows; engine-sql/trust-fence.ts on the SQL engines): of
 * the listed ids, the rows more trusted than the writer and, with `pending`, the rows a pending `forget` proposal targets.
 * The store compares each row's stamped tier; without `writer` the writer is its write trust context's tier.
 * rust/docs/store/timeline_queries.md, "Held timeline rows".
 */
export const listHeldTimelineRows: StoreMember<[spec: HeldTimelineRowsSpec], HeldTimelineRow[]> = async (brain, spec) => {
  if (!spec.ids.length) return [];
  const input = { ids: [...spec.ids], ...(spec.writer !== undefined ? { writer: spec.writer } : {}), ...(spec.pending ? { pending: true } : {}) };
  const rows = await storeCall({ member: 'listHeldTimelineRows' }, () => brain.listHeldTimelineRows(input)) as HeldTimelineRow[];
  return rows.map((row) => ({ id: Number(row.id), trust_tier: row.trust_tier }));
};

/**
 * GST-2891: the fence cells held from a world-only fact reader (BrainEngine listHeldFenceCells; heldRowSql on the SQL
 * engines): a cell is held when the page's live fact at its row number is narrower than world, or when a live narrower
 * fact of the page states its claim (contains it, for a cut claim) and no live world fact of the page does. For a member
 * caller the member passes its page, principal and page policy (`privatePagesFilterForCaller`, which memberFactAdmitSql
 * applies to the member page), and the store does not count the private facts of that page as narrower while the caller
 * may read the live page. For a caller with a private-facts grant (GBRA-575) the member passes the granted sources
 * (`privateFactSources`, `grantSources`), and the store does not count the private facts grantedPrivateFactSql admits,
 * with heldRowSql's visibility-proposal clause. A member caller whose page policy is not one the store renders refuses
 * here; heldFenceLines then holds every fence row line (fail closed), as it does for any failed lookup.
 * rust/docs/store/facts.md, "Held fence cells".
 */
export const listHeldFenceCells: StoreMember<[keys: readonly HeldFenceCellKey[]], HeldFenceCellRow[]> = async (brain, keys) => {
  if (!keys.length) return [];
  const own = callerMember();
  const member = own === null ? undefined : {
    slug: memberPageSlug(own),
    principal: `member:${own}`,
    policy: storePageTextPolicy('listHeldFenceCells', () => privatePagesFilterForCaller('p'), { callerReaders: true }),
  };
  const grantSources = [...privateFactSources()];
  const input = { keys, ...(member ? { member } : {}), ...(grantSources.length ? { grantSources } : {}) };
  const rows = await storeCall({ member: 'listHeldFenceCells' }, () => brain.listHeldFenceCells(input)) as HeldFenceCellRow[];
  return rows.map((row) => ({ ...row, row_num: Number(row.row_num) }));
};

/**
 * #5575 ENG-1: the fence overlay's read of one page (BrainEngine readFenceOverlayRows), one row per incoming row in
 * incoming order. `purged` is always false: fact purges are written through `executeRaw` only, which this engine refuses,
 * so the store keeps none. With `hideHeld`, `narrower` is listHeldFenceCells' rule for an uncut claim, and a member caller
 * or a private-facts grant refuses here as it does there. rust/docs/store/facts.md, "The fence overlay".
 */
export const readFenceOverlayRows: StoreMember<[page: { sourceId: string; slug: string }, incoming: readonly FenceOverlayIncomingRow[], opts: { hideHeld: boolean }], FenceOverlayRow[]> =
  async (brain, page, incoming, opts) => {
    if (!incoming.length) return [];
    if (opts.hideHeld) {
      if (memberFactAdmitSql('hr') !== 'FALSE') refuseMember('readFenceOverlayRows', "a member caller's own page facts");
      if (grantedPrivateFactSql('hr') !== 'FALSE') refuseMember('readFenceOverlayRows', 'a private-facts grant');
    }
    const rows = await storeCall({ member: 'readFenceOverlayRows', slug: page.slug, sourceId: page.sourceId },
      () => brain.readFenceOverlayRows({ sourceId: page.sourceId, slug: page.slug, incoming, hideHeld: opts.hideHeld === true })) as FenceOverlayRow[];
    return rows.map((row) => ({ ...row, row_num: Number(row.row_num) }));
  };
