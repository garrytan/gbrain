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
 *
 * `listHeldRows` (the held-row read of trust/fence-guard.ts `heldRows`) is served for take and timeline rows, which the
 * store stamps with their tier (rust/docs/store/takes.md, rust/docs/store/timeline.md). The store runs one write at a time,
 * so the SQL's `FOR UPDATE` lock has nothing to add.
 *
 * `listGuardedTakeRows` (the batch guard of trust/fence-guard.ts `guardTakeRows`) reads the same stamped take tiers, with
 * the writer's tier from the write trust context.
 */
import type { FenceFactRow, GuardedTakeRow, GuardedTakeRowsQuery, HeldRowsQuery, PageTrustRestore } from '../../engine-sql/trust-fence.ts';
import type { FenceOverlayIncomingRow, FenceOverlayRow, FenceRowKey, FenceRowTrust, HeldFenceCellKey, HeldFenceCellRow } from '../../engine-sql/cli-reads-ops.ts';
import { callerMember, memberPageSlug } from '../../access/member-facts.ts';
import { privateFactSources, privatePagesFilterForCaller } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePageTextPolicy } from './private-provenance.ts';

export const listFenceFactRows: StoreMember<[target: { sourceId: string; slug: string; incoming: string }], FenceFactRow[]> = async (brain, target) => {
  const rows = await storeCall({ member: 'listFenceFactRows', slug: target.slug, sourceId: target.sourceId },
    () => brain.listFenceFactRows({ sourceId: target.sourceId, slug: target.slug, incoming: target.incoming })) as FenceFactRow[];
  return rows.map((row) => ({ ...row, id: Number(row.id), row_num: Number(row.row_num) }));
};

export const listGuardedTakeRows: StoreMember<[q: GuardedTakeRowsQuery], GuardedTakeRow[]> = async (brain, q) => {
  const member = 'listGuardedTakeRows';
  const nums = [...q.incoming.flatMap(r => [r.page_id, r.row_num]), ...q.gone.flatMap(r => [r.page_id, r.row_num])];
  if (!nums.every(Number.isSafeInteger)) refuseMember(member, 'a page id or row number that is not an integer');
  if (!q.incoming.length && !q.gone.length) return [];
  const rows = await storeCall({ member }, () => brain.listGuardedTakeRows({
    incoming: q.incoming.map(r => ({ page_id: r.page_id, row_num: r.row_num, claim: r.claim, kind: r.kind, holder: r.holder, active: r.active })),
    gone: q.gone.map(r => ({ page_id: r.page_id, row_num: r.row_num })),
    pending: q.pending === true,
  })) as GuardedTakeRow[];
  return rows.map(r => ({ id: Number(r.id), page_id: Number(r.page_id), row_num: Number(r.row_num), trust_tier: r.trust_tier, change: r.change }));
};
