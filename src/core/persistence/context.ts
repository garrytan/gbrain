import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import type { WriteAttribution } from './attribution.ts';

interface PublicationContext { brainId: string; sourceIds: ReadonlySet<string>; active: boolean; }
const publication = new AsyncLocalStorage<PublicationContext>();
const ATTRIBUTION_SETTINGS = ['gbrain.write_request', 'gbrain.write_principal_kind', 'gbrain.write_principal_id'] as const;

/**
 * Sets transaction-local settings around `fn` in one round trip each way. An
 * aborted transaction cannot accept statements; its rollback clears SET LOCAL
 * automatically. A success restores the enclosing values.
 */
async function withTransactionSettings<T>(engine: Pick<BrainEngine, 'executeRaw'>, names: readonly string[],
  next: (previous: string[]) => string[], fn: () => Promise<T>): Promise<T> {
  const [row] = await engine.executeRaw<Record<string, string | null>>(
    `SELECT ${names.map((name, index) => `current_setting('${name}',true) AS s${index}`).join(',')}`);
  const previous = names.map((_, index) => row?.[`s${index}`] ?? '');
  const apply = (values: string[]) => engine.executeRaw(
    `SELECT ${names.map((name, index) => `set_config('${name}',$${index + 1},true)`).join(',')}`, values);
  await apply(next(previous));
  let failed = false;
  try { return await fn(); }
  catch (error) { failed = true; throw error; }
  finally {
    try { await apply(previous); }
    catch (error) { if (!failed) throw error; }
  }
}
/** A nested scope keeps the outer actor: a request publication that calls a derived writer stays attributed to the request. */
const attributionValues = (outer: string[], attribution: WriteAttribution) => outer[1]
  ? outer : [attribution.requestId ?? '', attribution.principal.kind, attribution.principal.id];

/**
 * Only the coordinator and guarded projection workers establish this execution
 * capability. `attribution` names the actor the database stamps on every
 * content row and page revision written inside (persistence/attribution-schema.ts).
 */
export async function withCoordinatedWrite<T>(engine: BrainEngine, sourceIds: string[], fn: () => Promise<T>, attribution: WriteAttribution): Promise<T> {
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  if (!brain) {
    throw opError('writer_not_initialized', 'Persistence identity is missing.',
      'This brain has no persistence identity row, so coordinated writes cannot run and nothing was written. List the pending migrations that create it and ask the user to approve applying them.',
      { fix: { argv: ['gbrain', 'apply-migrations', '--dry-run', '--json'], consent: [], actor: 'agent', why: 'Lists the pending migrations without applying them.', requires_exclusive: false } });
  }
  const context: PublicationContext = { brainId: brain.brain_id, sourceIds: new Set(sourceIds), active: true };
  return withTransactionSettings(engine, ['gbrain.write_sources', ...ATTRIBUTION_SETTINGS],
    ([, ...outer]) => [JSON.stringify(sourceIds), ...attributionValues(outer, attribution)],
    () => publication.run(context, async () => {
      try { return await fn(); }
      finally { context.active = false; }
    }));
}
/** Attribution without coordinator capability, for unmanaged legacy transactions. */
export function withWriteAttribution<T>(engine: Pick<BrainEngine, 'executeRaw'>, attribution: WriteAttribution, fn: () => Promise<T>): Promise<T> {
  return withTransactionSettings(engine, ATTRIBUTION_SETTINGS, outer => attributionValues(outer, attribution), fn);
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
