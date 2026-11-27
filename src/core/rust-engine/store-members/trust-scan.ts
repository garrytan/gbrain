/**
 * The trust scan's state (src/core/engine-sql/trust-scan.ts), served by gbrain-store: the cursor from
 * `persistence/trust_scan_cursor.rs` (the `op_checkpoints` row lane members read under the same key), the claimed
 * sources and each table's ceiling from `trust/scan_state.rs`. A trust scan on this engine stops and resumes as it
 * does on PGLite. What the store keeps and how it differs: rust/docs/store/trust.md, "Trust scan state".
 */
import { CONNECTOR_SOURCE_KINDS } from '../../persistence/connector-identity.ts';
import type { TrustScanTable } from '../../engine-sql/trust-tier-reads.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The cursor row's `completed_keys`, or null when the scan has no cursor. */
export const readTrustScanCursor: StoreMember<[], unknown> = async (brain) =>
  (await storeCall({ member: 'readTrustScanCursor' }, () => brain.readTrustScanCursor())) ?? null;

/** The cursor row's keys replaced with `completedKeys`, stamped now. */
export const writeTrustScanCursor: StoreMember<[completedKeys: readonly unknown[]], void> = async (brain, completedKeys) => {
  await storeCall({ member: 'writeTrustScanCursor' }, () => brain.writeTrustScanCursor([...completedKeys]));
};

/** The claimed sources whose lift has not finished, by id (byte order). */
export const listClaimPendingSourceIds: StoreMember<[], string[]> = (brain) =>
  storeCall({ member: 'listClaimPendingSourceIds' }, () => brain.listClaimPendingSourceIds({ connectorKinds: [...CONNECTOR_SOURCE_KINDS] }));

/** Each scanned table's max id; 0 for an empty table. */
export const readTrustScanCeilings: StoreMember<[], Record<TrustScanTable, number>> = (brain) =>
  storeCall({ member: 'readTrustScanCeilings' }, () => brain.readTrustScanCeilings());
