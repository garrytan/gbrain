import { OperationError } from '../ops/contract.ts';
import { acceptedPendingReceipt } from '../persistence/accepted-pending.ts';

/** Publication waits and confirmed admission rollback are not dream failures.
 * Never infer deferral from a message, a generic storage error, or a terminal
 * receipt: those must still reach the phase's normal failure path.
 */
export function maintenancePublicationDeferral(error: unknown): 'pending' | 'contention' | null {
  if (acceptedPendingReceipt(error)) return 'pending';
  if (error instanceof OperationError && error.code === 'storage_error' &&
    error.detail === 'database_contention' && !error.writeRequest) return 'contention';
  return null;
}
