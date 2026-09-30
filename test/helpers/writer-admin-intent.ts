import type { BrainEngine } from '../../src/core/engine.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import type { PersistenceAdminOperation } from '../../src/core/persistence/admin-contract.ts';

export async function reviewedWriterIntent(engine: BrainEngine, operation: PersistenceAdminOperation) {
  const status = await runPersistenceAdministration(engine, 'writer_status', {});
  if (typeof status.admin_state !== 'string') throw new Error('Writer status did not return a reviewed state fingerprint.');
  return { admin_intent: operation, expected_state: status.admin_state };
}
