/**
 * The fence guard's read of a page's fact rows with their trust tier (BrainEngine listFenceFactRows;
 * engine-sql/trust-fence.ts on the SQL engines), and the fence append's restore of its page's tier and origin
 * (restorePageTrust, trust/fence-append.ts withPageTierKept): the store applies the same trust stamp as an UPDATE that
 * sets both columns, so a raise back needs the promotion the caller opens.
 *
 * The store reads the writer's tier and the opened fact ids from its write trust context (rust/docs/store/write_trust.md),
 * which the engine's transaction sets in place of `gbrain.write_trust_tier` and `gbrain.write_open_facts`; with none set,
 * the writer is undeclared (`unknown`) and nothing is opened. Every stored fact reads as `unknown` (Rust facts store no
 * tier yet), so only an opened row, or a writer below `unknown`, lists a row. What the read answers and why:
 * rust/docs/store/facts.md, "The fence guard's reads".
 */
import type { FenceFactRow, PageTrustRestore } from '../../engine-sql/trust-fence.ts';
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
