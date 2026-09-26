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
import { assertMutationProtocol } from './protocol.ts';
import { pendingWriteHint } from './health.ts';
import type { PublicationHooks } from './coordinator.ts';

interface Service { consumer: PersistenceConsumer; stopping: boolean; unregisterStop?: () => void; unregisterReopen?: () => void; }
const services = new WeakMap<BrainEngine, Service>();
const receiptReads = new WeakMap<BrainEngine, Map<string, { read: Promise<WriteRequest | null>; abort: AbortController }>>();
const preparers = new Map<string, { prepare: PrepareMutation; target: 'page' | 'skill_bundle' }>();
export function registerMutationPreparer(operation: string, prepare: PrepareMutation, target: 'page' | 'skill_bundle' = 'page'): void {
  preparers.set(operation, { prepare, target });
}
export async function preparePersistedMutation(e: BrainEngine, row: WriteRequest, cfg: GBrainConfig, signal?: AbortSignal) {
  assertMutationProtocol(row);
  const registered = preparers.get(row.operation);
  if (registered) {
    if (registered.target !== (row.target_kind ?? 'page')) throw new OperationError('unsupported_mutation_protocol', 'The registered preparer does not support this mutation target.');
    return registered.prepare(e, row, cfg, signal);
  }
  if (row.target_kind === 'skill_bundle') {
    if (['put_skill', 'delete_skill'].includes(row.operation)) return (await import('../shared-skills/publication.ts')).prepareSharedSkillMutation(e, row, cfg);
    throw new OperationError('unsupported_mutation_protocol', 'No compatible skill mutation preparer is registered.');
  }
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_atom_')) return (await import('./atom-maintenance.ts')).prepareManagedAtomMutation(e, row, cfg);
  if (row.operation === 'extract_facts' && row.intent?.kind === 'managed_conversation_facts_page') return (await import('./conversation-facts-prepare.ts')).prepareManagedConversationFactsMutation(e, row, cfg);
  if (row.operation === 'extract_facts' && String(row.intent?.kind).startsWith('managed_facts_')) return (await import('./facts-prepare.ts')).prepareManagedFactsMutation(e, row, cfg);
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_connector_')) return (await import('./connector-sync.ts')).prepareConnectorMutation(e, row);
  if (row.operation === 'put_page' && row.intent?.kind === 'canonical_reconcile') return (await import('./reconcile-prepare.ts')).prepareReconcileMutation(e, row, cfg);
  if (row.operation === 'put_page' && row.intent?.kind === 'managed_grandfather') return (await import('./grandfather.ts')).prepareGrandfatherMutation(e, row);
  if (row.operation === 'submit_job' && row.intent?.kind === 'code_projection_reindex') return (await import('./projection-reindex.ts')).prepareCodeReindex(e, row);
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_sync_')) return (await import('./sync-prepare.ts')).prepareManagedSyncMutation(e, row, cfg);
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_maintenance_')) return (await import('./prepared-maintenance.ts')).prepareMaintenanceMutation(e, row, cfg);
  if (row.operation === 'put_page' && row.intent?.kind === 'managed_file_import') return (await import('./import-prepare.ts')).prepareManagedImportMutation(e, row, cfg);
  if (row.operation === 'remember') return (await import('./memory-mutations.ts')).prepareMemoryMutation(e, row, cfg, signal);
  if (['takes_add','takes_update','takes_supersede','takes_resolve'].includes(row.operation)) return (await import('./takes-prepare.ts')).prepareTakesMutation(e,row,cfg);
  if (['add_tag','remove_tag','add_timeline_entry'].includes(row.operation)) return prepareSemanticPageMutation(e, row, cfg);
  if (['put_page','capture','delete_page','restore_page','revert_version'].includes(row.operation)) return preparePageMutation(e, row, cfg, undefined, signal);
  throw new OperationError('unsupported_mutation_protocol', 'No compatible mutation preparer is registered for this operation.');
}
export function startPersistenceConsumer(engine: BrainEngine, config: GBrainConfig,
  options: { publicationHooks?: PublicationHooks } = {}): PersistenceConsumer {
  const prior = services.get(engine);
  if (prior) {
    if (prior.stopping) throw new OperationError('unavailable', 'The persistence owner is closing.');
    return prior.consumer;
  }
  const consumer = new PersistenceConsumer(engine, config, preparePersistedMutation, options);
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
  const pending = [...(receiptReads.get(engine)?.values() ?? [])];
  for (const entry of pending) entry.abort.abort();
  await service.consumer.stop();
  await Promise.all(pending.map(entry => entry.read));
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
  const service = services.get(engine)!;
  let reads = receiptReads.get(engine);
  if (!reads) { reads = new Map(); receiptReads.set(engine, reads); }
  const deadline = performance.now() + waitMs;
  while (!service.stopping && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - performance.now()))));
    const remaining = deadline - performance.now();
    if (service.stopping || remaining <= 0) break;
    let pending = reads.get(row.id);
    const ownsRead = !pending;
    if (!pending) {
      if (reads.size >= 4) continue;
      const abort = new AbortController();
      const id = row.id;
      const read = getWriteRequestById(engine, row.id, engine.kind === 'postgres' ? abort.signal : undefined)
        .catch(() => null).finally(() => { if (reads.get(id)?.read === read) reads.delete(id); });
      pending = { read, abort };
      reads.set(id, pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const found = await Promise.race([
      pending.read,
      new Promise<null>(resolve => { timer = setTimeout(() => { if (ownsRead) pending.abort.abort(); resolve(null); }, remaining); }),
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
      ? pendingWriteHint(receipt)
      : 'Inspect this receipt before submitting a new request_id.');
  error.writeRequest = receipt as WriteReceipt;
  error.writeError = isWriteErrorCode(reason) ? reason : reason === 'page_identity_changed' ? 'source_changed' : 'storage_error';
  throw error;
}
