import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';

interface PublicationContext { brainId: string; sourceIds: ReadonlySet<string>; active: boolean; }
const publication = new AsyncLocalStorage<PublicationContext>();
/** Only the coordinator and guarded projection workers establish this execution capability. */
export async function withCoordinatedWrite<T>(engine: BrainEngine, sourceIds: string[], fn: () => Promise<T>): Promise<T> {
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  if (!brain) throw new OperationError('writer_not_initialized', 'Persistence identity is missing.');
  const context: PublicationContext = { brainId: brain.brain_id, sourceIds: new Set(sourceIds), active: true };
  const [previous] = await engine.executeRaw<{ value: string | null }>("SELECT current_setting('gbrain.write_sources',true) AS value");
  await engine.executeRaw("SELECT set_config('gbrain.write_sources',$1,true)", [JSON.stringify(sourceIds)]);
  return publication.run(context, async () => {
    let failed = false;
    try { return await fn(); }
    catch (error) { failed = true; throw error; }
    finally {
      context.active = false;
      // An aborted transaction cannot accept statements; its rollback clears
      // SET LOCAL automatically. A success restores the enclosing capability.
      try { await engine.executeRaw("SELECT set_config('gbrain.write_sources',$1,true)", [previous?.value ?? '']); }
      catch (error) { if (!failed) throw error; }
    }
  });
}
export async function assertCoordinatedWrite(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<void> {
  const [brain] = await engine.executeRaw<{ brain_id: string; enabled: boolean }>('SELECT brain_id,enabled FROM persistence_brain WHERE singleton=1');
  if (!brain?.enabled) return;
  const held = publication.getStore();
  if (!held?.active || held.brainId !== brain.brain_id || !held.sourceIds.has(sourceId)) {
    throw new OperationError('writer_coordinator_required', 'This writer must enter the canonical persistence coordinator.',
      'Use supported page operations, or drain managed writers before running this maintenance command.');
  }
}
