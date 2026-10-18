/**
 * The CLI dispatcher's operation lookup, built from the handler-free
 * manifest (src/core/operation-manifest.generated.ts) so resolving a command,
 * its flags or its help never loads the handler graph behind
 * src/core/operations.ts; runSharedOperation imports that only to run an op.
 */
import { OPERATION_MANIFEST } from '../core/operation-manifest.generated.ts';
import { registerOpRoutes } from '../core/fix-routing.ts';
import type { OperationMeta } from '../core/ops/contract.ts';

export { OPERATION_MANIFEST };

// operations.ts registers the op half of the A1 fix-routing pin as it loads;
// fixes rendered before an op runs (flag errors, help) need it too.
registerOpRoutes(OPERATION_MANIFEST);

/** CLI name -> operation (hidden ops excluded). */
export const cliOps = new Map<string, OperationMeta>();
for (const op of OPERATION_MANIFEST) {
  const name = op.cliHints?.name;
  if (name && !op.cliHints?.hidden) cliOps.set(name, op);
}
