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
 * store stamps with their tier (rust/docs/store/takes.md, rust/docs/store/timeline.md). The SQL's `FOR UPDATE` lock is
 * skipped while explicit transactions hold the writer (`serialized_transactions`); the store asserts it. `listFenceFactRows`
 * skips the same lock and asserts it here.
 *
 * `listGuardedTakeRows` (the batch guard of trust/fence-guard.ts `guardTakeRows`) reads the same stamped take tiers, with
 * the writer's tier from the write trust context.
 */
import type { FenceFactRow, GuardedTakeRow, GuardedTakeRowsQuery, HeldRowsQuery, PageTrustRestore } from '../../engine-sql/trust-fence.ts';
import type { FenceOverlayIncomingRow, FenceOverlayRow, FenceRowKey, FenceRowTrust, HeldFenceCellKey, HeldFenceCellRow } from '../../engine-sql/cli-reads-ops.ts';
import { callerMember, memberPageSlug } from '../../access/member-facts.ts';
import { privateFactSources, privatePagesFilterForCaller } from '../../search/private-visibility.ts';
import { assertStoreSerializedTransactions, refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePageTextPolicy } from './private-provenance.ts';

export const listFenceFactRows: StoreMember<[target: { sourceId: string; slug: string; incoming: string }], FenceFactRow[]> = async (brain, target) => {
  assertStoreSerializedTransactions(brain, 'listFenceFactRows');
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
/** The caller's admissions heldRowSql reads (its own member page and its private-facts grant), as the store takes them. */
function heldCaller(member: string): { member?: { slug: string; principal: string; policy: ReturnType<typeof storePageTextPolicy> }; grantSources?: string[] } {
  const own = callerMember();
  const page = own === null ? undefined : {
    slug: memberPageSlug(own),
    principal: `member:${own}`,
    policy: storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true, fragment: 'caller' }),
  };
  const grantSources = [...privateFactSources()];
  return { ...(page ? { member: page } : {}), ...(grantSources.length ? { grantSources } : {}) };
}

export const listHeldFenceCells: StoreMember<[keys: readonly HeldFenceCellKey[]], HeldFenceCellRow[]> = async (brain, keys) => {
  if (!keys.length) return [];
  const input = { keys, ...heldCaller('listHeldFenceCells') };
  const rows = await storeCall({ member: 'listHeldFenceCells' }, () => brain.listHeldFenceCells(input)) as HeldFenceCellRow[];
  return rows.map((row) => ({ ...row, row_num: Number(row.row_num) }));
};

/**
 * #5575 ENG-1: the fence overlay's read of one page (BrainEngine readFenceOverlayRows), one row per incoming row in
 * incoming order. `purged` reads the store's fact purge ledger (`facts/purge_ledger.rs` `purged_claim`). With `hideHeld`, `narrower` is listHeldFenceCells' rule for an uncut claim,
 * with the caller's member page and private-facts grant as listHeldFenceCells takes them. rust/docs/store/facts.md, "The fence overlay".
 */
export const readFenceOverlayRows: StoreMember<[page: { sourceId: string; slug: string }, incoming: readonly FenceOverlayIncomingRow[], opts: { hideHeld: boolean }], FenceOverlayRow[]> =
  async (brain, page, incoming, opts) => {
    if (!incoming.length) return [];
    // With hideHeld, `narrower` is listHeldFenceCells' rule: the caller's own member page and private-facts grant admit
    // their facts (memberFactAdmitSql, grantedPrivateFactSql), so the store takes the same caller input.
    const caller = opts.hideHeld ? heldCaller('readFenceOverlayRows') : {};
    const rows = await storeCall({ member: 'readFenceOverlayRows', slug: page.slug, sourceId: page.sourceId },
      () => brain.readFenceOverlayRows({ sourceId: page.sourceId, slug: page.slug, incoming, hideHeld: opts.hideHeld === true, ...caller })) as FenceOverlayRow[];
    return rows.map((row) => ({ ...row, row_num: Number(row.row_num) }));
  };

/**
 * #5575 37-1/37-2/A5: the newest live fact at each fence row key (BrainEngine listFenceRowTrust; engine-sql/cli-reads-ops.ts),
 * read from the store's facts (facts/fence_overlay.rs `list_fence_row_trust`): its tier, `activationSuppressedSql` and
 * `contestedRefSql`. A row number that is not an integer refuses, as the `int[]` bind would fail.
 */
export const listFenceRowTrust: StoreMember<[keys: readonly FenceRowKey[]], FenceRowTrust[]> = async (brain, keys) => {
  if (!keys.length) return [];
  if (!keys.every(k => Number.isSafeInteger(k.row_num))) refuseMember('listFenceRowTrust', 'a row number that is not an integer');
  const rows = await storeCall({ member: 'listFenceRowTrust' }, () =>
    brain.listFenceRowTrust(keys.map(k => ({ source_id: k.source_id, slug: k.slug, row_num: k.row_num })))) as FenceRowTrust[];
  return rows.map(row => ({ ...row, row_num: Number(row.row_num), flagged: row.flagged === true, contested: row.contested ?? null }));
};

/**
 * The page's take or timeline rows a write may not delete or overwrite (BrainEngine listHeldRows; engine-sql/trust-fence.ts):
 * the store keeps a trust tier on timeline rows only, so any other table refuses.
 */
export const listHeldRows: StoreMember<[q: HeldRowsQuery], Array<{ id: number; trust_tier: string }>> = async (brain, q) => {
  const member = 'listHeldRows';
  if (q.table !== 'takes' && q.table !== 'timeline_entries') refuseMember(member, `table ${String(q.table)}: the store keeps no trust tier on it`);
  if (!Number.isSafeInteger(q.pageId) || !q.ids.every(Number.isSafeInteger)) refuseMember(member, 'a page or row id that is not an integer');
  if (q.writer !== undefined && typeof q.writer !== 'string') refuseMember(member, 'a writer tier that is not text');
  if (!q.ids.length) return [];
  const rows = await storeCall({ member }, () => brain.listHeldRows({
    table: q.table, pageId: q.pageId, ids: [...q.ids], ...(q.writer !== undefined ? { writer: q.writer } : {}), pending: q.pending === true,
  })) as Array<{ id: number; trust_tier: string }>;
  return rows.map(row => ({ id: Number(row.id), trust_tier: row.trust_tier }));
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
