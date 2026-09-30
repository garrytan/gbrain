import { OperationError } from '../ops/contract.ts';

/** Shape/trust checks do not read the current page or resolve a replay target. */
export function assertPurgeParams(params: Record<string, unknown>, remote: boolean | undefined): void {
  if (params.purge !== undefined && typeof params.purge !== 'boolean') {
    throw new OperationError('invalid_params', 'purge must be a boolean.', 'Pass purge: true (CLI: gbrain delete <slug> --purge).');
  }
  if (params.purge === true && remote !== false) {
    throw new OperationError('permission_denied', 'purge is only available to the local CLI.',
      'Remote callers soft-delete only; run `gbrain delete <slug> --purge` on the host to remove a page immediately.');
  }
}
