import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { PersistenceConsumer, type PrepareMutation } from './consumer.ts';
import { preparePageMutation } from './page-prepare.ts';
import { prepareSemanticPageMutation } from './semantic-pages.ts';
import { getWriteRequestById, getWriteRequestProgress, receiptFor, type WriteRequestProgress } from './journal.ts';
import { isTerminal, type WriteRequest } from './model.ts';
import { isWriteErrorCode, type WriteReceipt } from './types.ts';
import { registerPgliteReopen } from '../pglite-lifecycle.ts';
import { assertMutationProtocol } from './protocol.ts';
import { pendingWriteHint } from './health.ts';
import { receiptDeliveredHint } from './connector-errors.ts';
import type { PgAccessReason } from '../pg-access-classify.ts';
import { contentRefusalFromReceipt } from '../import-screen.ts';
import { fenceIssuesFromDetail, fenceLocationFromDetail } from '../fence-repair/refusal.ts';
import { heldFileDiagnostic } from './verb-errors.ts';
import { isMissingPageMessage } from './page-identity.ts';

interface Service { consumer: PersistenceConsumer; stopping: boolean; unregisterStop?: () => void; unregisterReopen?: () => void; }
const services = new WeakMap<BrainEngine, Service>();
type ProgressRead = { row: WriteRequestProgress | null } | { error: unknown } | { cancelled: true };
const receiptReads = new WeakMap<BrainEngine, Map<string, { read: Promise<ProgressRead>; abort: AbortController }>>();
const settledWaiters = new WeakMap<BrainEngine, Map<string, Set<(row: WriteRequest) => void>>>();
/** #6007: when this process last settled requests, for pending retry_after_ms estimates. */
const settlements = new WeakMap<BrainEngine, number[]>();
const SETTLEMENT_SAMPLES = 21;
function recordSettlement(engine: BrainEngine): void {
  let times = settlements.get(engine);
  if (!times) { times = []; settlements.set(engine, times); }
  times.push(performance.now());
  if (times.length > SETTLEMENT_SAMPLES) times.shift();
}
/**
 * #6007: a pending receipt's retry_after_ms from this process's recent pace:
 * `remaining` requests at the median gap between settlements, clamped to
 * 250 ms-30 s. Null until this process has settled at least two requests.
 */
export function estimatedRetryAfterMs(engine: BrainEngine, remaining: number): number | null {
  const times = settlements.get(engine) ?? [];
  if (times.length < 2 || remaining <= 0) return null;
  const gaps = times.slice(1).map((at, i) => at - times[i]!).sort((a, b) => a - b);
  return Math.round(Math.min(30_000, Math.max(250, gaps[Math.floor(gaps.length / 2)]! * remaining)));
}
const preparers = new Map<string, { prepare: PrepareMutation; target: 'page' | 'skill_bundle' }>();
export function registerMutationPreparer(operation: string, prepare: PrepareMutation, target: 'page' | 'skill_bundle' = 'page'): void {
  preparers.set(operation, { prepare, target });
}
export async function preparePersistedMutation(e: BrainEngine, row: WriteRequest, cfg: GBrainConfig, signal?: AbortSignal) {
  assertMutationProtocol(row);
  const registered = preparers.get(row.operation);
  if (registered) {
    if (registered.target !== (row.target_kind ?? 'page')) throw new OperationError('unsupported_mutation_protocol', 'The registered preparer does not support this mutation target.', `Request ${row.request_id} (${row.operation}) was accepted by a gbrain version whose preparer this one lacks, so it has not run. Run gbrain upgrade on every host that serves this brain; the request stays journaled and resumes after the upgrade.`);
    return registered.prepare(e, row, cfg, signal);
  }
  if (row.target_kind === 'skill_bundle') {
    if (['put_skill', 'delete_skill'].includes(row.operation)) return (await import('../shared-skills/publication.ts')).prepareSharedSkillMutation(e, row, cfg);
    throw new OperationError('unsupported_mutation_protocol', 'No compatible skill mutation preparer is registered.', `Request ${row.request_id} (${row.operation}) was accepted by a gbrain version whose preparer this one lacks, so it has not run. Run gbrain upgrade on every host that serves this brain; the request stays journaled and resumes after the upgrade.`);
  }
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_atom_')) return (await import('./atom-maintenance.ts')).prepareManagedAtomMutation(e, row, cfg);
  if (row.operation === 'extract_facts' && String(row.intent?.kind).startsWith('managed_facts_')) return (await import('./facts-prepare.ts')).prepareManagedFactsMutation(e, row, cfg);
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('connector_v2_')) return (await import('./connector-sync.ts')).prepareConnectorMutation(e, row);
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_connector_')) return (await import('./connector-sync.ts')).prepareOutdatedConnectorMutation(e, row);
  if (row.operation === 'put_page' && row.intent?.kind === 'canonical_reconcile') return (await import('./reconcile-prepare.ts')).prepareReconcileMutation(e, row, cfg);
  if (row.operation === 'put_page' && row.intent?.kind === 'managed_grandfather') return (await import('./grandfather.ts')).prepareGrandfatherMutation(e, row);
  if (row.operation === 'submit_job' && row.intent?.kind === 'code_projection_reindex') return (await import('./projection-reindex.ts')).prepareCodeReindex(e, row);
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_sync_')) return (await import('./sync-prepare.ts')).prepareManagedSyncMutation(e, row, cfg);
  if (row.operation === 'submit_job' && String(row.intent?.kind).startsWith('managed_maintenance_')) return (await import('./prepared-maintenance.ts')).prepareMaintenanceMutation(e, row, cfg);
  if (row.operation === 'put_page' && row.intent?.kind === 'managed_file_import') return (await import('./import-prepare.ts')).prepareManagedImportMutation(e, row, cfg);
  if (row.operation === 'put_page' && row.intent?.kind === 'managed_file_repair') return (await import('./file-repair.ts')).prepareManagedFileRepairMutation(e, row, cfg);
  if (row.operation === 'remember') return (await import('./memory-mutations.ts')).prepareMemoryMutation(e, row, cfg, signal);
  if (row.operation === 'loops_close' && row.intent?.kind === 'retire_loop_fact') return (await import('./loop-fact-retirement.ts')).prepareLoopFactRetirement(e, row, cfg);
  if (row.operation === 'decide_proposal') return (await import('../facts/proposal-supersede.ts')).prepareProposalMutation(e, row, cfg);
  if (row.operation === 'relink_facts') return (await import('../facts/relink-publish.ts')).prepareRelinkMutation(e, row, cfg);
  if (['takes_add','takes_update','takes_supersede','takes_resolve','takes_remove'].includes(row.operation)) return (await import('./takes-prepare.ts')).prepareTakesMutation(e,row,cfg);
  if (['add_tag','remove_tag','add_timeline_entry'].includes(row.operation)) return prepareSemanticPageMutation(e, row, cfg);
  if (['put_page','capture','delete_page','restore_page','revert_version','edit_page'].includes(row.operation)) return preparePageMutation(e, row, cfg, undefined, signal);
  throw new OperationError('unsupported_mutation_protocol', 'No compatible mutation preparer is registered for this operation.', `Request ${row.request_id} (${row.operation}) was accepted by a gbrain version whose preparer this one lacks, so it has not run. Run gbrain upgrade on every host that serves this brain; the request stays journaled and resumes after the upgrade.`);
}
export function startPersistenceConsumer(engine: BrainEngine, config: GBrainConfig): PersistenceConsumer {
  const prior = services.get(engine);
  if (prior) {
    if (prior.stopping) {
      throw new OperationError('unavailable', 'The persistence owner is closing.',
        'The persistence owner in this process is shutting down; start the command again after it exits. Accepted writes stay journaled and resume on the next owner.');
    }
    return prior.consumer;
  }
  const consumer = new PersistenceConsumer(engine, config, preparePersistedMutation,
    { onSettled: row => { recordSettlement(engine); for (const listener of settledWaiters.get(engine)?.get(row.id) ?? []) listener(row); } });
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
/** The config this process's consumer prepares writes with (its first caller's); undefined when none is running. */
export function persistenceConsumerConfig(engine: BrainEngine): GBrainConfig | undefined {
  const service = services.get(engine);
  return service && !service.stopping ? service.consumer.config : undefined;
}
export function persistenceConsumerStatus(engine: BrainEngine) {
  const service = services.get(engine);
  return service ? { state: service.stopping ? 'closing' : 'open', ...service.consumer.status() }
    : { state: 'not_running', accepting: false, active_preparations: 0, active_worktrees: 0 };
}
export function assertPersistenceAccepting(engine: BrainEngine): void {
  if (services.get(engine)?.stopping) {
    throw new OperationError('unavailable', 'The persistence owner is closing. Retry the same request_id after restart.',
      'Nothing new was accepted. After the owner restarts, resubmit with the same request_id so a write that was already accepted is never applied twice.');
  }
}
/** DX-A3: pending heads that need intervention, not more waiting. */
export const BLOCKED_WRITE_REASONS = ['recovery_required', 'owner_unavailable', 'unexpected_file_bytes', 'unexpected_staging_bytes'] as const;
const FATAL_READ_REASONS: readonly PgAccessReason[] = ['auth_failed', 'permission_denied', 'tenant_not_found', 'db_missing', 'schema_missing', 'storage_corrupt'];
/** CEO-A7: the first poll waits this long (at most half the wait) for an in-process handoff; later polls back off from 50 to 250 ms. */
export const WRITE_POLL_START_MS = 200;
export type WriteWait =
  | { kind: 'terminal' | 'pending'; row: WriteRequest }
  | { kind: 'blocked'; row: WriteRequest; request_id: string; cause: typeof BLOCKED_WRITE_REASONS[number]; command: string }
  | { kind: 'read_failed'; row: WriteRequest; request_id: string; reason: PgAccessReason; transient: boolean; sqlstate?: string;
      attempts: number; message: string; why: string };
/**
 * Waits for an admitted write and classifies how the wait ended. A request this
 * process publishes is handed over by its consumer without a read; otherwise a
 * narrow progress read polls, and the full row is read once when terminal. The
 * waiter's own cancelled reads are not failures; database read failures are
 * classified (`read_failed`) instead of reading as a still-pending write.
 * The waiter never owns a provider, database connection, or kernel lock.
 */
export async function awaitWrite(engine: BrainEngine, row: WriteRequest, config: GBrainConfig,
  opts: { waitMs?: number; signal?: AbortSignal } = {}): Promise<WriteWait> {
  if (isTerminal(row)) return { kind: 'terminal', row };
  const consumer = startPersistenceConsumer(engine, config);
  const service = services.get(engine)!;
  const id = row.id;
  let handed: WriteRequest | undefined;
  let wake: (() => void) | undefined;
  let waiters = settledWaiters.get(engine);
  if (!waiters) { waiters = new Map(); settledWaiters.set(engine, waiters); }
  const listeners = waiters.get(id) ?? new Set();
  const listener = (settled: WriteRequest) => { handed = settled; wake?.(); };
  listeners.add(listener); waiters.set(id, listeners);
  // The admission transaction has committed: publish now, not after the idle backoff.
  consumer.wake();
  const waitMs = opts.waitMs ?? 5000;
  const deadline = performance.now() + waitMs;
  const firstPoll = Math.min(WRITE_POLL_START_MS, waitMs / 2);
  let delay = firstPoll, failure: { error: unknown; attempts: number } | undefined;
  try {
    while (!service.stopping && !opts.signal?.aborted) {
      if (handed) { row = handed; handed = undefined; if (isTerminal(row)) return { kind: 'terminal', row }; }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); wake = undefined; opts.signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(delay, remaining));
        wake = done; opts.signal?.addEventListener('abort', done, { once: true });
      });
      if (handed || service.stopping || opts.signal?.aborted || performance.now() >= deadline) continue;
      delay = delay === firstPoll ? 50 : Math.min(250, delay * 2);
      if (consumer.holds(id)) continue;
      const read = await readProgress(engine, id, deadline - performance.now());
      if ('cancelled' in read) continue;
      if ('error' in read) {
        failure = { error: read.error, attempts: (failure?.attempts ?? 0) + 1 };
        const { classifyPgAccessError } = await import('../pg-access-classify.ts');
        if (FATAL_READ_REASONS.includes(classifyPgAccessError(read.error).reason)) break;
        continue;
      }
      failure = undefined;
      if (!read.row) continue;
      row = { ...row, ...read.row };
      if (isTerminal(row)) return { kind: 'terminal', row: await getWriteRequestById(engine, id).catch(() => null) ?? row };
    }
  } finally {
    listeners.delete(listener);
    if (!listeners.size && waiters.get(id) === listeners) waiters.delete(id);
  }
  if (handed) row = handed;
  if (isTerminal(row)) return { kind: 'terminal', row };
  if (failure) {
    const { classifyPgAccessError } = await import('../pg-access-classify.ts');
    const diagnosis = classifyPgAccessError(failure.error);
    return { kind: 'read_failed', row, request_id: row.request_id, reason: diagnosis.reason, transient: diagnosis.transient,
      ...(diagnosis.sqlstate ? { sqlstate: diagnosis.sqlstate } : {}), attempts: failure.attempts, message: diagnosis.message, why: diagnosis.remediation };
  }
  const cause = BLOCKED_WRITE_REASONS.find(reason => reason === row.blocked_reason);
  return cause ? { kind: 'blocked', row, request_id: row.request_id, cause, command: `gbrain sources writer status ${row.source_id} --json` } : { kind: 'pending', row };
}
/** At most four progress reads per engine; concurrent waiters on one request share a read. */
async function readProgress(engine: BrainEngine, id: string, remaining: number): Promise<ProgressRead> {
  let reads = receiptReads.get(engine);
  if (!reads) { reads = new Map(); receiptReads.set(engine, reads); }
  let pending = reads.get(id);
  const ownsRead = !pending;
  if (!pending) {
    if (reads.size >= 4) return { cancelled: true };
    const abort = new AbortController();
    const shared = reads;
    const read: Promise<ProgressRead> = getWriteRequestProgress(engine, id, engine.kind === 'postgres' ? abort.signal : undefined)
      .then(row => ({ row }), error => abort.signal.aborted ? { cancelled: true as const } : { error })
      .finally(() => { if (shared.get(id)?.read === read) shared.delete(id); });
    pending = { read, abort };
    reads.set(id, pending);
  }
  const owned = pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([owned.read, new Promise<ProgressRead>(resolve => {
    timer = setTimeout(() => { if (ownsRead) owned.abort.abort(); resolve({ cancelled: true }); }, remaining);
  })]).finally(() => { if (timer) clearTimeout(timer); });
}
/** Compatibility form of `awaitWrite`: the latest row, terminal or still pending. */
export async function waitForWrite(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, waitMs = 5000): Promise<WriteRequest> {
  return (await awaitWrite(engine, row, config, { waitMs })).row;
}
/**
 * #6007: wait for several admitted writes against one deadline. Every row waits at once, so each one's consumer handoff is registered
 * before a grouped publication settles them together; waiting one after
 * another left all but the first to the progress polls.
 */
export async function waitForWrites(engine: BrainEngine, rows: readonly WriteRequest[], config: GBrainConfig, waitMs = 5000): Promise<WriteRequest[]> {
  return Promise.all(rows.map(row => waitForWrite(engine, row, config, waitMs)));
}
/** B4: what a terminal receipt means for the caller, without guessing a mutation. */
function terminalReceiptHint(row: WriteRequest, reason: string): string {
  const what = `The ${row.operation ? `${row.operation} ` : ''}write (request_id ${row.request_id}) ended ${row.state} with ${reason}; it will not publish.`;
  return row.state === 'cancelled'
    ? `${what} Submit again only if the change is still wanted, with a new request_id.`
    : `${what} Read the receipt and the current state before deciding to submit again; a new attempt needs a new request_id.`;
}
export function writeResponse(row: WriteRequest, hints: { retryAfterMs?: number | null } = {}): Record<string, unknown> {
  const receipt = receiptFor(row);
  // #6007: an in-process estimate beats the fixed fallback, never an owner-inspection hold.
  if (!isTerminal(row) && hints.retryAfterMs != null && receipt.diagnostic?.next_action !== 'inspect_owner') receipt.retry_after_ms = hints.retryAfterMs;
  if (row.state === 'committed') return { ...receipt, write_request: receipt };
  const reason = !isTerminal(row) ? 'write_pending' : row.error_code ?? (row.state === 'cancelled' ? 'cancelled' : 'storage_error');
  const delivered = isTerminal(row) ? receiptDeliveredHint(row) : null;
  // #5988: a content refusal reports its typed code, reason, key and line, and the content fix.
  const content = isTerminal(row) ? contentRefusalFromReceipt(row.error_code, row.error_message) : null;
  // The page's file is held by sync: name the repair, so the caller does not retry into the same refusal.
  const held = isTerminal(row) && reason === 'source_changed' ? heldFileDiagnostic(row.error_message, row.source_id) : null;
  const error = new OperationError(reason, !isTerminal(row) ? 'The write is accepted and is still pending.'
    : row.error_message ?? 'The write did not commit.', !isTerminal(row)
      ? pendingWriteHint(receipt, row.operation)
      : delivered?.suggestion ?? content?.suggestion ?? held?.suggestion ?? terminalReceiptHint(row, reason), delivered?.docs);
  if (delivered?.detail ?? held?.reason) error.detail = delivered?.detail ?? held?.reason;
  if (content) {
    if (content.code !== reason) error.canonical = content.code;
    if (content.reason) error.reason = content.reason;
    // #6188: the stored fence location and blocking issues (the caller's own rows; refused before any merge).
    if (content.code === 'invalid_fence') {
      const fence = fenceLocationFromDetail(row.error_detail) ?? content.fence;
      if (fence) error.fence = { ...fence };
      const issues = fenceIssuesFromDetail(row.error_detail);
      if (issues.length) error.fenceIssues = issues;
    }
    if (content.key || content.line !== undefined) error.detail = [content.key ? `key ${content.key}` : '', content.line !== undefined ? `line ${content.line}` : ''].filter(Boolean).join(', ');
  }
  if (reason === 'page_identity_changed' && isMissingPageMessage(row.error_message)) error.canonical = 'page_not_found';
  error.receiptFields = { operation: row.operation, source_id: row.source_id, slug: row.slug || null, principal_kind: row.principal_kind, principal_id: row.principal_id };
  error.writeRequest = receipt as WriteReceipt;
  error.writeError = isWriteErrorCode(reason) ? reason : reason === 'page_identity_changed' ? 'source_changed' : 'storage_error';
  throw error;
}
