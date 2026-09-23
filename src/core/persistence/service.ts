import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { PersistenceConsumer, type PrepareMutation } from './consumer.ts';
import { preparePageMutation } from './page-prepare.ts';
import { prepareSemanticPageMutation } from './semantic-pages.ts';
import { getWriteRequestById, receiptFor } from './journal.ts';
import { isTerminal, type WriteRequest } from './model.ts';
import { isWriteErrorCode, type WriteReceipt } from './types.ts';
import { registerPgliteReopen } from '../pglite-lifecycle.ts';

interface Service { consumer: PersistenceConsumer; stopping: boolean; unregisterStop?: () => void; unregisterReopen?: () => void; }
const services = new WeakMap<BrainEngine, Service>();
const preparers = new Map<string, PrepareMutation>();
export function registerMutationPreparer(operation: string, prepare: PrepareMutation): void { preparers.set(operation, prepare); }
export function startPersistenceConsumer(engine: BrainEngine, config: GBrainConfig): PersistenceConsumer {
  const prior = services.get(engine);
  if (prior) {
    if (prior.stopping) throw new OperationError('unavailable', 'The persistence owner is closing.');
    return prior.consumer;
  }
  const consumer = new PersistenceConsumer(engine, config, async (e, row, cfg) => {
    const registered = preparers.get(row.operation);
    if (registered) return registered(e, row, cfg);
    if (row.operation === 'put_page' && row.intent?.kind === 'canonical_reconcile') return (await import('./reconcile-prepare.ts')).prepareReconcileMutation(e, row, cfg);
    if (row.operation === 'submit_job' && row.intent?.kind === 'code_projection_reindex') return (await import('./projection-reindex.ts')).prepareCodeReindex(e, row);
    if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_sync_')) return (await import('./sync-prepare.ts')).prepareManagedSyncMutation(e, row, cfg);
    if (row.operation === 'remember') return (await import('./memory-mutations.ts')).prepareMemoryMutation(e, row, cfg);
    if (['takes_add','takes_update','takes_supersede','takes_resolve'].includes(row.operation)) return (await import('./takes-prepare.ts')).prepareTakesMutation(e,row,cfg);
    return (['add_tag','remove_tag','add_timeline_entry'].includes(row.operation) ? prepareSemanticPageMutation : preparePageMutation)(e, row, cfg);
  });
  const service: Service = { consumer, stopping: false };
  services.set(engine, service);
  const lifecycle = engine as BrainEngine & { registerBeforeDisconnect?: (run: () => Promise<void>) => unknown };
  const unregister = lifecycle.registerBeforeDisconnect?.(() => stopPersistenceConsumer(engine));
  if (typeof unregister === 'function') service.unregisterStop = unregister;
  if (engine.kind === 'pglite') service.unregisterReopen = registerPgliteReopen(engine, sameDatastore => {
    if (services.get(engine) !== service || !service.stopping) return;
    discardStoppedService(engine, service);
    // An explicit switch to another datastore must not inherit the old brain's config.
    if (sameDatastore) startPersistenceConsumer(engine, config);
  });
  consumer.start();
  return consumer;
}
export async function stopPersistenceConsumer(engine: BrainEngine): Promise<void> {
  const service = services.get(engine);
  if (!service) return;
  service.stopping = true;
  await service.consumer.stop();
}
/** Reset fixtures and drained lifecycle owners may discard a stopped service. */
export async function disposePersistenceConsumer(engine: BrainEngine): Promise<void> {
  const service = services.get(engine);
  await stopPersistenceConsumer(engine);
  if (service && services.get(engine) === service) discardStoppedService(engine, service);
}
function discardStoppedService(engine: BrainEngine, service: Service): void {
  service.unregisterStop?.(); service.unregisterReopen?.(); services.delete(engine);
}
export function foregroundWriteCompletions(engine: BrainEngine, worktreeId: string): number {
  return services.get(engine)?.consumer.foregroundCompletions(worktreeId) ?? 0;
}
export function persistenceConsumerStatus(engine: BrainEngine) {
  const service = services.get(engine);
  return service ? { state: service.stopping ? 'closing' : 'open', ...service.consumer.status() }
    : { state: 'not_running', accepting: false, active_preparations: 0, active_worktrees: 0 };
}
export function assertPersistenceAccepting(engine: BrainEngine): void {
  if (services.get(engine)?.stopping) throw new OperationError('unavailable', 'The persistence owner is closing. Retry the same request_id after restart.');
}
/** The waiter never owns a provider, database connection, or kernel lock. */
export async function waitForWrite(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, waitMs = 5000): Promise<WriteRequest> {
  if (isTerminal(row)) return row;
  startPersistenceConsumer(engine, config);
  const deadline = performance.now() + waitMs;
  while (performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - performance.now()))));
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    // A DB outage must not stretch a bounded synchronous wait indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const found = await Promise.race([
      getWriteRequestById(engine, row.id).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (found) row = found;
    if (isTerminal(row)) return row;
  }
  return row;
}
export function writeResponse(row: WriteRequest): Record<string, unknown> {
  const receipt = receiptFor(row);
  if (row.state === 'committed') return { ...receipt, write_request: receipt };
  const reason = !isTerminal(row) ? 'write_pending' : row.error_code ?? (row.state === 'cancelled' ? 'cancelled' : 'storage_error');
  const error = new OperationError(reason, !isTerminal(row) ? 'The write is accepted and is still pending.'
    : row.error_message ?? 'The write did not commit.', !isTerminal(row)
      ? 'Repeat the same operation, arguments, and request_id, or inspect get_write_request.'
      : 'Inspect this receipt before submitting a new request_id.');
  error.writeRequest = receipt as WriteReceipt;
  error.writeError = isWriteErrorCode(reason) ? reason : reason === 'page_identity_changed' ? 'source_changed' : 'storage_error';
  throw error;
}
