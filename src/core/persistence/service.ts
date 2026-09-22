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
/**
 * Idle-poll interval for the consumer loop, in milliseconds. Env-only
 * incident escape hatch in the `GBRAIN_POOL_SIZE` mould: the 250ms default
 * issues four queries per tick (brain gate, request scan, claim update,
 * projection drain), which a resident `serve` keeps paying on a managed
 * Postgres even when the brain has persistence disabled and the queue is
 * empty. Raising it trades write-pickup latency for egress.
 *
 * The bounds are load-bearing, not decoration.
 *
 * The value must be a WHOLE integer string: `parseInt` would read `60s` as 60,
 * turning an operator who meant "60 seconds" into a 60ms poll — four times
 * BUSIER than the default, the exact opposite of the intent.
 *
 * The ceiling is tied to `waitForWrite`'s budget below, NOT chosen for taste.
 * Nothing wakes this consumer on admission — no LISTEN/NOTIFY, and
 * `startPersistenceConsumer` returns the running service without ticking — so
 * in a resident `serve` a synchronous write is picked up only by the next idle
 * poll. A poll interval at or above that budget makes the first write after a
 * quiet stretch miss its deadline and fail `write_pending`, which would break
 * put_page/capture/remember rather than merely slow them. MAX stays a safe
 * margin under it. A ceiling is also what keeps a hostile value harmless: past
 * the 32-bit timer range Bun clamps the timeout to 1ms (the same footgun
 * inverted), and a near-infinite one poisons consumer.ts's `pollMs * 2`
 * recovery backoff into `Infinity`, stranding a root in its retry-exclusion
 * map. Anything outside the window is refused (warn once, keep the built-in
 * default) rather than silently reinterpreted.
 */
const MIN_CONSUMER_POLL_MS = 50;
const MAX_CONSUMER_POLL_MS = 3_000;
let warnedBadConsumerPollMs = false;
export function resolveConsumerPollMs(): number | undefined {
  const raw = process.env.GBRAIN_PERSISTENCE_POLL_MS?.trim();
  if (!raw) return undefined;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed >= MIN_CONSUMER_POLL_MS && parsed <= MAX_CONSUMER_POLL_MS) return parsed;
  if (!warnedBadConsumerPollMs) {
    warnedBadConsumerPollMs = true;
    process.stderr.write(`[gbrain] ignoring GBRAIN_PERSISTENCE_POLL_MS=${raw}: expected a whole number of milliseconds `
      + `between ${MIN_CONSUMER_POLL_MS} and ${MAX_CONSUMER_POLL_MS}; keeping the built-in default.\n`);
  }
  return undefined;
}
/** Test-only: reset the warn-once latch. */
export function resetConsumerPollMsWarning(): void { warnedBadConsumerPollMs = false; }
export function startPersistenceConsumer(engine: BrainEngine, config: GBrainConfig): PersistenceConsumer {
  const prior = services.get(engine);
  if (prior) {
    if (prior.stopping) throw new OperationError('unavailable', 'The persistence owner is closing.');
    return prior.consumer;
  }
  const consumer = new PersistenceConsumer(engine, config, async (e, row, cfg) => {
    const registered = preparers.get(row.operation);
    if (registered) return registered(e, row, cfg);
    if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_sync_')) return (await import('./sync-prepare.ts')).prepareManagedSyncMutation(e, row, cfg);
    if (row.operation === 'remember') return (await import('./memory-mutations.ts')).prepareMemoryMutation(e, row, cfg);
    if (['takes_add','takes_update','takes_supersede','takes_resolve'].includes(row.operation)) return (await import('./takes-prepare.ts')).prepareTakesMutation(e,row,cfg);
    return (['add_tag','remove_tag','add_timeline_entry'].includes(row.operation) ? prepareSemanticPageMutation : preparePageMutation)(e, row, cfg);
  }, { pollMs: resolveConsumerPollMs() });
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
