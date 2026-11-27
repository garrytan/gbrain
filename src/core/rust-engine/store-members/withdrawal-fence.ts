/**
 * `hasWithdrawnFenceClaim` (src/core/engine-sql/withdrawal-fence.ts), served from the store
 * (rust/crates/gbrain-store/src/facts/withdrawal_fence.rs): the withdrawal check a prepared import runs on a
 * malformed facts fence, answered from the fact withdrawal ledger and the fact purge ledger.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

export const hasWithdrawnFenceClaim: StoreMember<Parameters<BrainEngine['hasWithdrawnFenceClaim']>, boolean> =
  async (brain, sourceId, claims, subject) => {
    if (!claims.length) return false;
    const rows = claims.map(c => ({ claim: c.claim, visibility: c.visibility }));
    return storeCall({ member: 'hasWithdrawnFenceClaim' }, () => brain.hasWithdrawnFenceClaim(sourceId, rows, subject));
  };
