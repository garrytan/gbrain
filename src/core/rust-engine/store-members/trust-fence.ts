/**
 * The fence guard's read of a page's fact rows with their trust tier (BrainEngine listFenceFactRows;
 * engine-sql/trust-fence.ts on the SQL engines), the held fence cells of a world-only fact read (listHeldFenceCells;
 * engine-sql/cli-reads-ops.ts), and the fence overlay's read of one page (readFenceOverlayRows; engine-sql/cli-reads-ops.ts),
 * and the fence append's restore of its page's tier and origin (restorePageTrust, trust/fence-append.ts withPageTierKept):
 * the store applies the same trust stamp as an UPDATE that sets both columns, so a raise back needs the promotion the
 * caller opens.
 *
 * The store reads the writer's tier and the opened fact ids from its write trust context (rust/docs/store/write_trust.md),
 * which the engine's transaction sets in place of `gbrain.write_trust_tier` and `gbrain.write_open_facts`; with none set,
 * the writer is undeclared (`unknown`) and nothing is opened. Every stored fact reads as `unknown` (Rust facts store no
 * tier yet), so only an opened row, or a writer below `unknown`, lists a row. What the read answers and why:
 * rust/docs/store/facts.md, "The fence guard's reads".
 */
import type { FenceFactRow, PageTrustRestore } from '../../engine-sql/trust-fence.ts';
import type { FenceOverlayIncomingRow, FenceOverlayRow, HeldFenceCellKey, HeldFenceCellRow } from '../../engine-sql/cli-reads-ops.ts';
import { grantedPrivateFactSql, memberFactAdmitSql } from '../../access/member-facts.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

export const listFenceFactRows: StoreMember<[target: { sourceId: string; slug: string; incoming: string }], FenceFactRow[]> = async (brain, target) => {
  const rows = await storeCall({ member: 'listFenceFactRows', slug: target.slug, sourceId: target.sourceId },
    () => brain.listFenceFactRows({ sourceId: target.sourceId, slug: target.slug, incoming: target.incoming })) as FenceFactRow[];
  return rows.map((row) => ({ ...row, id: Number(row.id), row_num: Number(row.row_num) }));
};

export const restorePageTrust: StoreMember<[spec: PageTrustRestore], void> = async (brain, spec) => {
  const member = 'restorePageTrust';
  if (!Number.isSafeInteger(spec.pageId)) refuseMember(member, 'a page id that is not an integer');
  if (typeof spec.trustTier !== 'string') refuseMember(member, 'a trust tier that is not text');
  if (spec.writeOrigin !== null && typeof spec.writeOrigin !== 'string') refuseMember(member, 'a write origin that is not JSON text or null');
  await storeCall({ member }, () => brain.restorePageTrust({ pageId: spec.pageId, trustTier: spec.trustTier, writeOrigin: spec.writeOrigin }));
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

/**
 * #5575 ENG-1: the fence overlay's read of one page (BrainEngine readFenceOverlayRows), one row per incoming row in
 * incoming order. `purged` reads the store's fact purge ledger (`facts/purge_ledger.rs` `purged_claim`). With `hideHeld`, `narrower` is listHeldFenceCells' rule for an uncut claim, and a member caller
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
