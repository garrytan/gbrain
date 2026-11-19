/**
 * `readWithdrawalDiscovery` (src/core/engine-sql/withdrawal-discovery.ts), served from the store
 * (rust/crates/gbrain-store/src/facts/withdrawal_discovery.rs): the reads discoverWithdrawalTargets makes over the
 * fact, page and segmented-body records. Rows come back in PGLite's shapes: ids as numbers, `occurrence_id`,
 * `open_start` and `bytes` as text, `revision` as the page's knowledge revision.
 *
 * Refused (`engine_capability_missing`): a cursor, limit or page id that is not an integer, rather than guess at
 * Postgres's bind error.
 */
import type { BrainEngine } from '../../engine.ts';
import type { WithdrawalDiscoveryRead } from '../../engine-sql/withdrawal-discovery.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

const MEMBER = 'readWithdrawalDiscovery';

function integers(read: WithdrawalDiscoveryRead): number[] {
  switch (read.kind) {
    case 'inline_fence_pages': return [read.after, read.limit];
    case 'segment_fence_rows': return [...read.after, read.limit];
    case 'split_fence_slots': return [read.after[0], read.after[2], read.limit];
    case 'target_pages': case 'sample_slugs': return read.ids;
    case 'claim_matches': return read.incoming.map(i => i.id);
    default: return [];
  }
}

const numbered = (rows: Array<Record<string, unknown>>, fields: string[]) =>
  rows.map(row => ({ ...row, ...Object.fromEntries(fields.map(f => [f, Number(row[f])])) }));

export const readWithdrawalDiscovery = (async (brain, read: WithdrawalDiscoveryRead) => {
  if (integers(read).some(n => !Number.isSafeInteger(n))) refuseMember(MEMBER, 'a cursor, limit or page id that is not an integer');
  const rows: Array<Record<string, unknown>> = await storeCall({ member: MEMBER }, () => brain.readWithdrawalDiscovery(read));
  switch (read.kind) {
    case 'provenance_pages': case 'claim_matches': case 'inline_fence_pages': case 'segment_fence_rows': return numbered(rows, ['id']);
    case 'split_fence_slots': case 'target_pages': return numbered(rows, ['page_id']);
    default: return rows;
  }
}) as StoreMember<Parameters<BrainEngine['readWithdrawalDiscovery']>, Awaited<ReturnType<BrainEngine['readWithdrawalDiscovery']>>>;
