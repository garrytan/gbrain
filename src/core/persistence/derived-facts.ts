import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { maintenanceTransaction } from './attribution.ts';
import { managedPersistenceEnabled } from './ownership.ts';

/**
 * Unmanaged brains: database-only fact rows derived from page text (the
 * conversation fact index) commit in one maintenance transaction under the
 * maintenance principal. A managed brain publishes them as receipted
 * maintenance requests instead (facts/conversation-publication.ts,
 * cycle/extract-facts.ts), so this refuses there rather than write a guarded
 * table without a receipt.
 */
export async function writeDerivedFacts<T>(engine: BrainEngine, sourceId: string, slug: string,
  fn: (db: BrainEngine) => Promise<T>): Promise<T> {
  if (await managedPersistenceEnabled(engine)) {
    throw opError('writer_coordinator_required', 'Managed brains publish derived facts through receipted maintenance requests.',
      `The derived facts of ${slug} in source ${sourceId} were not written: a managed brain publishes them through the coordinator, which this caller bypassed. Run the extraction command again; report this if it repeats.`);
  }
  return maintenanceTransaction(engine, fn);
}
