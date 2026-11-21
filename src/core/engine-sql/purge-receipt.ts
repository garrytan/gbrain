/**
 * The two reads a page purge's receipt and verification make on the brain's own tables: whether a relation exists
 * (persistence/rebuildable-cache.ts relationExists) and the state of a request's derivation sweep (page-body/segment-derive.ts
 * derivationPurgeState). Each ran through `executeRaw`; SQL once for both engines, so the Rust store serves the same members
 * (src/core/rust-engine/store-members/purge-receipt.ts).
 *
 * Every function takes the engine (or transaction) it runs on. Static text: `$1` the relation name or the request id.
 */
import type { BrainEngine } from '../engine.ts';
import type { DerivationPendingReason, DerivationStallReason, DerivationSweepState } from '../page-body/segment-derive.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The state of a request's derivation sweep, with why it stalled or why a pending one has not ended. */
export interface DerivationPurgeState { state: DerivationSweepState; reason: DerivationStallReason | DerivationPendingReason | null }

/** Whether `table` resolves on the connection's search path, the same resolution the statement that uses it gets. */
export async function relationExists(tx: Raw, table: string): Promise<boolean> {
  const [row] = await tx.executeRaw<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
  return row?.present === true;
}

/** The state of a purge request's derivation sweep, or null once it is verified and its record is gone. Reads page_segment_derivation_purges. */
export async function readDerivationPurgeState(tx: Raw, requestId: string): Promise<DerivationPurgeState | null> {
  const [row] = await tx.executeRaw<{ stalled: boolean; reason: DerivationStallReason | null; pending: DerivationPendingReason | null }>(
    'SELECT stalled_at IS NOT NULL AS stalled, stalled_reason AS reason, pending_reason AS pending FROM page_segment_derivation_purges WHERE request_id=$1::uuid', [requestId]);
  return row ? { state: row.stalled ? 'stalled' : 'pending', reason: row.stalled ? row.reason ?? 'statement_timeout' : row.pending ?? null } : null;
}
