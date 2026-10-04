import { realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { loadConfig } from '../config.ts';
import { importFromContent } from '../import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { slugifyPath } from '../sync.ts';
import type { Page } from '../types.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import type { RegistryCode } from '../error-registry.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { authorizeStoredRequest, authorizeWrite } from './authority.ts';
import { materializeTimeline, prepareCanonicalProjections } from './canonical-projections.ts';
import { digest, sha256 } from './digest.ts';
import { admitWriteInTransaction, assertReplayIntent, getWriteRequest, getWriteRequestById, intentDigest, receiptFor } from './journal.ts';
import { acquireWorktree, containsPath, getWorktreeBinding, probeWorktreeWriter, type WorktreeBinding } from './ownership.ts';
import { localHostId } from './identity.ts';
import { assertPersistenceAccepting, startPersistenceConsumer, waitForWrite, writeResponse } from './service.ts';
import { AGENT_WRITE_WAIT_MS, configuredWriteWaitMs } from './write-wait.ts';
import { managedSyncAuthority, validateManagedSyncOptions, validateSyncAuthority, type SyncAuthority } from './sync-authority.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import { persistenceFileHash, type PreparedMutation } from './coordinator.ts';
import { isTerminal, type WriteRequest } from './model.ts';
import { databaseOnlyPublication, prepareFileTarget } from './page-prepare.ts';
import { assertPhysicalRoot } from './physical-root.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { LockStolenError, syncLockId, withRefreshingLock, type DbLockHandle } from '../db-lock.ts';
import { ownedGoogleReceipts, prepareGoogleReceiptPatch, type GoogleReceipts } from './connector-google-receipts.ts';
import { connectorCheckpointKey, connectorIdentity, type ConnectorIdentity, type ConnectorKind } from './connector-identity.ts';
import { readManagedConnectorState, recordConnectorSyncAttempt, sameConnectorAccount, writeManagedConnectorState, type ConnectorAccount, type ConnectorPendingEntry, type ConnectorRunCounts, type ConnectorState } from './connector-state.ts';
import { connectorAccountChanged, connectorFenceHint, docsAnchor, receiptDeliveredHint, CONNECTOR_INTENT_OUTDATED_OLD_HOST, CONNECTOR_INTENT_OUTDATED_PRE_UPGRADE } from './connector-errors.ts';
import { inspectUnchanged, screeningRequest } from './noop-kernel.ts';
import { conceptPreservationHold, preserveCanonicalFences } from '../cycle/concept-publication.ts';
import { FACTS_FENCE_BEGIN } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN } from '../takes-fence.ts';
import { readJournalLimits } from './limits.ts';
import { withCoordinatedWrite } from './context.ts';
import { maintenanceAttribution } from './attribution.ts';
import { readConnectorV2Cutoff } from './connector-checkpoint-migration.ts';
import type { GoogleSourceConfig } from '../google/types.ts';

interface ConnectorLease { handle: DbLockHandle; signal: AbortSignal; }
type ConnectorIntentKind = 'connector_v2_import' | 'connector_v2_delete' | 'connector_v2_checkpoint' | 'connector_v2_google_receipts';
const CONNECTOR_V2_KINDS: readonly string[] = ['connector_v2_import', 'connector_v2_delete', 'connector_v2_checkpoint', 'connector_v2_google_receipts'];
const CHECKPOINT_SLUG = '__managed_connector_checkpoint__';
/**
 * #5600: one connector run waits at most this long in total for accepted
 * writes. A write that commits within the grace costs no budget, so a healthy
 * owner never exhausts it; the reserve keeps the last second of the budget
 * for the checkpoint and state writes.
 */
export const CONNECTOR_WAIT_BUDGET_MS = 30_000;
/** Test seam: fixtures that pause the owner shorten the budget instead of waiting 30 s per run. */
export const connectorWaitBudget = { ms: CONNECTOR_WAIT_BUDGET_MS };
const WAIT_RESERVE_MS = 1_000;
const COMMIT_GRACE_MS = 1_000;
const ITEM_WAIT_MS = 5_000;
/**
 * Accepted-pending writes stop the sweep: the run ends partial with its pending
 * set recorded. A `write_pending` error, so direct session callers and
 * `rethrowConnectorWriteError` treat it like any accepted, unfinished write.
 */
export class ConnectorWaitBudgetStop extends OperationError {
  constructor(row?: WriteRequest) {
    super('write_pending', 'The connector wait budget is spent with accepted writes still pending.',
      'The pending writes are recorded and resolved first on the next run of the same connector sync.');
    this.name = 'ConnectorWaitBudgetStop';
    if (row) { this.writeRequest = receiptFor(row); this.writeError = 'write_pending'; }
  }
}
interface ConnectorSource { incarnation: string; archived: boolean; local_path: string | null; config: Record<string, unknown>; }
interface ConnectorRetry {
  checkpointKey: string;
  principalId: string;
  principalKind: string;
  baseRequestId: string;
  requestId: string;
  retryOf: string;
  attempt: number;
  /** Written by `gbrain sources retry-held` (fix wave 4): approved, but nothing is admitted under `requestId` yet. */
  pending?: boolean;
}
interface ConnectorIntent extends Record<string, unknown> {
  kind: ConnectorIntentKind;
  connector: ConnectorKind;
  configHash: string;
  sourceRoot: string | null;
  syncAuthority: SyncAuthority;
  expected_revision: string | null;
  sourcePath: string | null;
  content?: string;
  googleReceipts?: GoogleReceipts;
  googlePageId?: number;
  noEmbed: boolean;
  noSchemaPack: boolean;
  checkpointKey: string;
  checkpointBefore: unknown[];
  checkpointAfter?: unknown[];
  receipts?: string[];
  fresh?: boolean;
  newestContentAt?: string;
  ownerEpoch: string | null;
  canonicalRoot: string | null;
  filePath: string | null;
  fileBeforeHash: string | null;
}

/** Read-only: the owner's view of a source's binding, queue and blocking receipts. */
function ownerStatusFix(sourceId: string, why: string): Action {
  return { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'], consent: [], actor: 'agent', why, requires_exclusive: false };
}

/** Read-only: one connector write receipt; connector writes run under the local CLI writer, so the CLI reads its own receipt. */
function receiptFix(requestId: string, why: string): Action {
  return { argv: ['gbrain', 'write-request', '--', requestId], consent: [], actor: 'agent', why, requires_exclusive: false };
}

/** The next run of a connector source's sync: it resolves the recorded pending set before it sweeps. */
function connectorSyncFix(sourceId: string, why: string): Action {
  return { argv: ['gbrain', 'sync', '--source', sourceId], consent: [], actor: 'agent', why, requires_exclusive: false };
}

/**
 * Publishing an admitted connector item was refused. The coordinator keeps
 * only code and message, so the suggestion stands alone: read the receipt,
 * then re-attempt the item explicitly once the cause is fixed.
 */
function connectorPublicationRefusal(code: RegistryCode, message: string, row: WriteRequest, cause: string): OperationError {
  return opError(code, message, `${cause} Read receipt ${row.request_id} first (gbrain write-request -- ${row.request_id}); once it is final and the cause is fixed, `
    + `gbrain sync --source ${row.source_id} --retry-failed re-attempts the item under a new request ID.`,
  { fix: receiptFix(row.request_id, 'The receipt records whether this connector write published anything; nothing is resubmitted until it is final.') });
}

/** The connector binding's owner and incarnation checks; returns the paths they prove present. */
function checkedConnectorBinding(sourceId: string, source: ConnectorSource, binding: WorktreeBinding) {
  if (binding.owner_host_id !== localHostId() || !binding.local_path || !binding.coordination_path) {
    throw opError('owner_unavailable', 'The connector canonical owner is unavailable on this host.',
      `Source ${sourceId} is owned by another host or its worktree binding is incomplete; run its connector sync on the owner host that gbrain sources writer status --source ${sourceId} --json names.`,
      { fix: ownerStatusFix(sourceId, 'Shows which host owns the source and whether its binding records a local and coordination path.') });
  }
  if (binding.source_id !== sourceId || binding.source_incarnation !== source.incarnation || !source.local_path) {
    throw opError('source_changed', 'The connector source does not match its canonical binding.',
      `The canonical binding of ${sourceId} belongs to another source incarnation, or the source has no local path. Inspect the binding before syncing ${sourceId} again; nothing was written.`,
      { fix: ownerStatusFix(sourceId, 'Shows the binding\'s source incarnation and recorded paths next to the source registration.') });
  }
  return { localPath: binding.local_path, coordinationPath: binding.coordination_path, sourcePath: source.local_path };
}

function connectorBindingRoot(sourceId: string, source: ConnectorSource, binding: WorktreeBinding | null): string | null {
  if (!binding) return null;
  const { localPath, coordinationPath, sourcePath } = checkedConnectorBinding(sourceId, source, binding);
  assertPhysicalRoot(localPath, { worktreeId: binding.worktree_id, coordinationPath });
  try {
    const root = realpathSync(join(localPath, binding.relative_path));
    const configured = source.config[source.config.kind === 'google' ? 'g_dir' : 'gh_dir'];
    const directory = typeof configured === 'string' && configured.length > 0 ? configured : sourcePath;
    if (!containsPath(localPath, root) || !statSync(root).isDirectory() || realpathSync(sourcePath) !== root || realpathSync(directory) !== root) {
      throw new Error('root mismatch');
    }
    return root;
  } catch {
    throw opError('source_changed', 'The connector directory no longer matches its canonical source root.',
      `The directory configured for ${sourceId} (g_dir, gh_dir or the source path) no longer resolves to the owner's recorded canonical root. Restore that directory, then run gbrain sync --source ${sourceId}; nothing was written.`,
      { fix: ownerStatusFix(sourceId, 'Shows the canonical root the owner recorded, to compare with the configured connector directory.') });
  }
}

/**
 * Fix wave 4: a page intent binds to the connector cursor, not to its item
 * holds or the checkpoint generation. A holds-only publication (the abort
 * path, a partial run) therefore neither invalidates accepted page writes nor
 * changes their request identity, so an ordinary rerun still replays the same
 * receipt. Checkpoint intents keep the full checkpoint.
 */
function cursorOnly(checkpoint: unknown): unknown[] {
  return (Array.isArray(checkpoint) ? checkpoint : []).map(entry => {
    const state = (entry as { state?: unknown } | null)?.state ?? null;
    if (!state || typeof state !== 'object') return { state };
    const { item_holds: _holds, ...cursor } = state as Record<string, unknown>;
    return { state: cursor };
  });
}

function stableId(value: unknown): string {
  const hash = digest(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function connectorFileTarget(engine: BrainEngine, row: Pick<WriteRequest, 'source_id' | 'worktree_id' | 'slug'>,
  snapshot: PageSnapshot | null, content: string | null, sourcePath: string | null, root: string | null): Promise<PreparedMutation['file']> {
  if (!row.worktree_id || snapshot || !sourcePath || !root) return prepareFileTarget(engine, row, snapshot, content);
  const path = resolve(root, sourcePath);
  if (!isWriteTargetContained(path, root)) throw opError('source_changed', 'The canonical file target is outside its registered source.',
    `The file for ${row.slug} would resolve outside the registered root of ${row.source_id}, so nothing was written. Check the root with gbrain sources writer status --source ${row.source_id} --json before syncing again.`,
    { fix: ownerStatusFix(row.source_id, 'Shows the registered canonical root the connector file must stay inside.') });
  const before = persistenceFileHash(path);
  if (before && content !== null && before !== sha256(content)) {
    throw new OperationError('source_changed', 'An unindexed file already occupies the canonical page path.', 'Import the file before replacing it.');
  }
  return { path, root, content, expectedBeforeHash: before };
}

export async function beginConnectorSync(engine: BrainEngine, sourceId: string, connector: ConnectorKind,
  suppliedConfig: unknown, opts: SyncOpts & { resetCheckpoint?: boolean }, lease?: ConnectorLease): Promise<ManagedConnectorSync | null> {
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (!brain?.enabled) return null;
  assertPersistenceAccepting(engine);
  validateManagedSyncOptions(opts);
  if (opts.dryRun || opts.skipFailed || opts.srcSubpath || opts.exclude?.length || opts.includeHidden?.length ||
      opts.includeGitignored || opts.workingTree || opts.strategy === 'code' || connector === 'google' && opts.githubItem) {
    throw opError('invalid_params', 'Managed connector sync does not support dry runs, Git file filters, or --skip-failed.',
      `Run gbrain sync --source ${sourceId} without --dry-run, --skip-failed, --src-subpath, --exclude, --include-hidden, --include-gitignored, --working-tree or --strategy code; a connector imports provider items, not Git files. Nothing was synced.`,
      { fix: connectorSyncFix(sourceId, 'The plain connector sync is the supported managed run; it keeps every pending-write and checkpoint guard.') });
  }
  const caller = currentSubmissionAuthority();
  if (caller && caller.kind !== 'application') throw opError('permission_denied', 'Connector sync requires a trusted local CLI writer; remote jobs cannot acquire connector credentials.',
    `Connector credentials stay on the brain host, so ${sourceId} syncs only from the gbrain CLI there: gbrain sync --source ${sourceId}. Ask the brain host's operator to run it.`,
    { fix: { ...connectorSyncFix(sourceId, 'Only the trusted local CLI on the brain host can read connector credentials.'), actor: 'host_admin',
      user_message: `The ${connector} connector source ${sourceId} has to sync on the machine that hosts the brain. Please ask whoever runs it to run the command shown there.` } });
  const [source] = await engine.executeRaw<ConnectorSource>('SELECT incarnation,archived,local_path,config FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw opError('source_changed', 'The connector source is not active.',
    `Source ${sourceId} is missing or archived, so nothing was synced. Check it in gbrain sources list --json; an archived connector source syncs again only after gbrain sources restore ${sourceId}.`,
    { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', why: 'Lists every source with its archived state.', requires_exclusive: false } });
  if (source.config.kind !== connector) throw opError('writer_coordinator_required', 'Managed connector sync requires a registered connector source; legacy filesystem calls are unsupported.',
    `Source ${sourceId} is not registered as a ${connector} connector source. Run gbrain sync --source ${sourceId}, which dispatches to the importer its registration names.`,
    { fix: connectorSyncFix(sourceId, 'The sync command routes a source to its registered connector or filesystem importer.') });
  const identity = connectorIdentity(connector, source.config, source.local_path);
  if (digest(identity.config) !== digest(suppliedConfig) || opts.sourceId !== undefined && opts.sourceId !== sourceId) {
    throw opError('source_changed', 'Connector options do not match the registered source.',
      `The connector options supplied for ${sourceId} differ from its registered configuration, so nothing was synced. Run gbrain sync --source ${sourceId}, which reads the registered configuration itself.`,
      { fix: connectorSyncFix(sourceId, 'The sync command loads the source\'s registered connector configuration instead of caller-supplied options.') });
  }
  const authority = await managedSyncAuthority(engine, sourceId, source.incarnation, source.local_path ?? '');
  const binding = await getWorktreeBinding(engine, sourceId);
  // The locked acquisition re-stamps a device-only physical-root change (#5604) before the root is asserted.
  if (binding) { checkedConnectorBinding(sourceId, source, binding); await probeWorktreeWriter(binding, engine); }
  else authority.writer.databaseOnlyReason = 'connector_database';
  const canonicalRoot = connectorBindingRoot(sourceId, source, binding);
  const session = new ManagedConnectorSync(engine, sourceId, identity, source, authority, binding, canonicalRoot, opts.noEmbed === true, opts.noSchemaPack === true,
    opts.retryFailed === true, lease, opts.resetCheckpoint === true, opts.githubItem !== undefined, opts.full === true);
  await session.load();
  return session;
}

/**
 * Runs one managed connector sweep under the per-source sync lease. `onPending`
 * shapes the caller's result when accepted writes are still pending at the end
 * (the checkpoint did not advance) or the wait budget stopped the sweep;
 * without it, a stopped sweep reports `write_pending`.
 */
export async function withConnectorSync<T>(engine: BrainEngine, sourceId: string, connector: ConnectorKind,
  config: unknown, opts: SyncOpts & { resetCheckpoint?: boolean }, work: (session: ManagedConnectorSync | null, opts: SyncOpts) => Promise<T>,
  onPending?: (result: T | null, session: ManagedConnectorSync) => T): Promise<T> {
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (!brain?.enabled) {
    if (opts.resetCheckpoint) throw new OperationError('invalid_params', '--reset-checkpoint applies to managed connector sources.',
      `This brain does not use managed persistence; re-walk this connector with: gbrain sync --source ${sourceId} --full`);
    // A preview never opens the autopilot dispatch gate (#5673).
    if (!opts.dryRun) await recordConnectorSyncAttempt(engine, sourceId);
    return work(null, opts);
  }
  opts.signal?.throwIfAborted();
  return withRefreshingLock(engine, syncLockId(sourceId), async (signal, handle) => {
    const combined = opts.signal ? AbortSignal.any([opts.signal, signal]) : signal;
    const options = { ...opts, signal: combined };
    const session = await beginConnectorSync(engine, sourceId, connector, config, options, { handle, signal: combined });
    if (!session) throw opError('source_changed', 'The managed connector mode changed before the sweep.',
      `Managed persistence was switched while the sync of ${sourceId} started, so nothing was swept. Check the mode with gbrain sources writer status --source ${sourceId} --json, then run gbrain sync --source ${sourceId}.`,
      { fix: ownerStatusFix(sourceId, 'Shows whether managed persistence is active for this brain and source.') });
    // Only a validated, authorized sweep opens the autopilot dispatch gate (#5673); the
    // session keeps the stamp in the state row it writes back.
    await recordConnectorSyncAttempt(engine, sourceId);
    session.markSyncAttempted();
    let result: T;
    try {
      result = await work(session, options);
    } catch (error) {
      if (!(error instanceof ConnectorWaitBudgetStop)) {
        if (error instanceof OperationError) await session.finish().catch(() => {});
        throw error;
      }
      await session.finish();
      if (onPending) return onPending(null, session);
      error.suggestion = `Accepted connector writes are still pending; they are recorded and resolved first on the next run: gbrain sync --source ${sourceId}`;
      throw error;
    }
    await session.assertLease(engine);
    await session.finish();
    return session.deferred && onPending ? onPending(result, session) : result;
  });
}

interface PendingWrite { entry: ConnectorPendingEntry; row: WriteRequest; bytes: number }

/** A connector sweep that ended with accepted writes pending, or stopped on its wait budget, reports `partial` / `writer_pending`. */
export function pendingConnectorResult(result: SyncResult | null, session: ManagedConnectorSync): SyncResult {
  const base: SyncResult = result ?? { status: 'partial', fromCommit: null, toCommit: '', added: session.counts.created, modified: session.counts.updated,
    deleted: session.counts.deleted, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
  return { ...base, status: 'partial', reason: 'writer_pending' };
}

export class ManagedConnectorSync {
  private checkpoint: unknown[] = [];
  private receipts: string[] = [];
  private retryApprovals = new Map<string, string>();
  /** Failed receipts a previous run ended with: retried automatically, without --retry-failed. */
  private autoRetry = new Set<string>();
  private carried: ConnectorPendingEntry[] = [];
  private pendingRows = new Map<string, PendingWrite>();
  private failedPending: ConnectorPendingEntry[] = [];
  private reseen = new Set<string>();
  private reseenItems = new Set<string>();
  private connectorState!: ConnectorState;
  private waitCharged = 0;
  private outstandingCap = 90;
  private intentByteCap = 16 * 1024 ** 2;
  private lastSaveCommitted = false;
  private stopped = false;
  private blockedByCheckpoint = false;
  private pendingCheckpoint: ConnectorPendingEntry | null = null;
  /** Page slugs of held connector items: their terminal, recovery-free failed receipts leave the automatic retry set. */
  private heldSlugs = new Set<string>();
  /** True when this run ended with accepted writes pending, so its checkpoint did not advance. */
  deferred = false;
  readonly counts: Omit<ConnectorRunCounts, 'finished_at' | 'pending' | 'stopped_on_wait_budget'> & { created: number; updated: number; deleted: number } = {
    page_admissions: 0, skipped_unchanged: 0, checkpoint_admissions: 0, dropped_upstream: 0, created: 0, updated: 0, deleted: 0 };
  readonly checkpointKey: string;
  private readonly connector: ConnectorKind;
  constructor(private engine: BrainEngine, readonly sourceId: string, private identity: ConnectorIdentity,
    private source: ConnectorSource, private authority: SyncAuthority, private binding: WorktreeBinding | null,
    private canonicalRoot: string | null, private noEmbed: boolean, private noSchemaPack: boolean, private retryFailed = false,
    private lease?: ConnectorLease, private resetRequested = false, private targeted = false, private fullSweep = false) {
    this.connector = identity.kind;
    this.checkpointKey = connectorCheckpointKey(sourceId, source.incarnation, identity);
  }
  async assertLease(engine: BrainEngine): Promise<void> {
    if (!this.lease) return;
    this.lease.signal.throwIfAborted();
    const { handle } = this.lease;
    const [owned] = await engine.executeRaw(`SELECT id FROM gbrain_cycle_locks
      WHERE id=$1 AND acquisition_token=$2::uuid AND extract(epoch from acquired_at)::text=$3
        AND ttl_expires_at>now() FOR SHARE`, [handle.id, handle.acquisitionToken, handle.acquiredAt]);
    if (!owned) throw new LockStolenError(handle.id);
    this.lease.signal.throwIfAborted();
  }
  async load(): Promise<void> {
    await this.recover('__managed_sync_checkpoint__');
    if (this.retryFailed) {
      const blocked = await this.retryBlocker(this.engine);
      if (blocked) {
        await this.authorizeRetryReceipt(this.engine, blocked);
        if (!isTerminal(blocked) && !blocked.recovery) {
          writeResponse(await waitForWrite(this.engine, blocked, loadConfig() ?? { engine: this.engine.kind }));
          await this.recover('__managed_sync_checkpoint__');
        }
        await this.refuseRetryBlocker(this.engine);
      }
    }
    const limits = await readJournalLimits(this.engine);
    this.outstandingCap = Math.max(1, Math.min(90, limits.principalOutstanding - 10));
    this.intentByteCap = Math.max(1024 ** 2, Math.floor(limits.principalIntentBytes / 2));
    this.connectorState = await readManagedConnectorState(this.engine, this.sourceId, this.source.incarnation);
    await this.resolvePendingSet();
    const [row] = await this.engine.executeRaw<{ completed_keys: unknown[] }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [this.checkpointKey]);
    this.checkpoint = row?.completed_keys ?? [];
    const pointers = await this.engine.executeRaw<{ completed_keys: ConnectorRetry[] }>(`SELECT completed_keys FROM op_checkpoints
      WHERE op='managed-connector-retry' AND completed_keys->0->>'checkpointKey'=$1
      AND completed_keys->0->>'principalId'=$2 AND completed_keys->0->>'principalKind'=$3`,
    [this.checkpointKey, this.authority.writer.principal.id, this.authority.writer.principal.kind]);
    this.retryApprovals = new Map(pointers.map(row => [row.completed_keys[0].baseRequestId, row.completed_keys[0].requestId]));
  }
  /**
   * #5600: the pending set a previous run ended with is resolved before the
   * sweep. Committed receipts are dropped; still-pending ones stay outstanding
   * and gate this run's checkpoint; failed or conflicted ones authorize one
   * automatic retry when the re-walk reaches their item. A checkpoint save
   * still pending is waited for (within the budget) before anything else.
   */
  private async resolvePendingSet(): Promise<void> {
    for (const entry of this.connectorState.pending) {
      // By source incarnation, not the current principal: a replaced writer registration must not orphan the ledger.
      let [row] = await this.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid AND source_id=$2 AND source_incarnation=$3::uuid',
        [entry.requestId, this.sourceId, this.source.incarnation]);
      if (!row) { this.carried.push(entry); continue; }
      if (row && entry.itemRef === CHECKPOINT_SLUG && !isTerminal(row)) row = await this.budgetedWait(row, connectorWaitBudget.ms);
      if (row.state === 'committed') continue;
      if (entry.itemRef === CHECKPOINT_SLUG && !isTerminal(row)) { this.pendingCheckpoint = entry; this.blockedByCheckpoint = true; continue; }
      if (!isTerminal(row)) { this.pendingRows.set(row.id, { entry, row, bytes: 0 }); continue; }
      this.autoRetry.add(entry.baseRequestId);
      this.carried.push(entry);
    }
  }
  /**
   * Checks the credential's resolved account against the source's pin before
   * any service runs. The first post-upgrade run pins a migrated source. A
   * requested checkpoint reset runs only after the account check passes.
   */
  async assertAccount(resolved: ConnectorAccount | null): Promise<void> {
    if (this.blockedByCheckpoint) { this.stopped = true; throw new ConnectorWaitBudgetStop(); }
    const configured = this.identity.kind === 'google' ? (this.identity.config as GoogleSourceConfig).account : null;
    if (resolved === null) throw connectorAccountChanged(this.sourceId, this.identity.kind, this.identity.config, this.connectorState.account ?? configured ?? 'the pinned account', null);
    if (configured !== null && resolved.kind === 'google' && resolved.email !== configured) {
      throw connectorAccountChanged(this.sourceId, this.identity.kind, this.identity.config, this.connectorState.account ?? configured, resolved);
    }
    const pinned = this.connectorState.account;
    if (pinned && !sameConnectorAccount(pinned, resolved)) throw connectorAccountChanged(this.sourceId, this.identity.kind, this.identity.config, pinned, resolved);
    if (!pinned) {
      const migrated = this.connectorState.upgrade_recovery === 'resumed';
      this.connectorState = { ...this.connectorState, account: resolved, pinned_at: new Date().toISOString(), continuity_unverified: migrated };
      await this.writeState();
      if (migrated && this.connectorState.resumed_from) {
        process.stderr.write(`[connector] ${this.sourceId}: resumed from pre-upgrade checkpoint of ${this.connectorState.resumed_from}\n`
          + `[connector] content selection since then is unverified; to re-walk: gbrain sync --source ${this.sourceId} --reset-checkpoint\n`);
      }
    }
    if (this.resetRequested) await this.resetCheckpoint();
  }
  /** `--reset-checkpoint`: resolve pending writes, then start from an empty cursor. Existing pages stay; the pin is kept. */
  private async resetCheckpoint(): Promise<void> {
    this.resetRequested = false;
    await this.drainPending();
    if (this.pendingRows.size) {
      throw new OperationError('write_pending', 'Accepted connector writes are still pending, so the checkpoint was not reset.',
        `Let them finish, then repeat: gbrain sync --source ${this.sourceId} --reset-checkpoint`);
    }
    this.carried = []; this.autoRetry.clear(); this.failedPending = [];
    if (this.checkpoint.length) {
      // The empty cursor keeps a rising generation, so the next save can never replay an older committed checkpoint receipt.
      const next = [{ generation: Number((this.checkpoint[0] as { generation?: number }).generation ?? 0) + 1, state: null }];
      await this.submit('connector_v2_checkpoint', CHECKPOINT_SLUG, null, { checkpointAfter: next, receipts: [], fresh: false });
      this.checkpoint = next;
      this.receipts = [];
    }
    this.connectorState = { ...this.connectorState, upgrade_recovery: 'none', resumed_from: null };
    await this.writeState();
  }
  private async validate(engine: BrainEngine, slug: string): Promise<WorktreeBinding | null> {
    await this.assertLease(engine);
    await validateSyncAuthority(engine, this.authority, slug);
    const [source] = await engine.executeRaw<ConnectorSource>('SELECT incarnation,archived,local_path,config FROM sources WHERE id=$1', [this.sourceId]);
    if (!source || source.archived || source.incarnation !== this.source.incarnation || source.local_path !== this.source.local_path ||
        source.config.kind !== this.connector || connectorIdentity(this.connector, source.config, source.local_path).digest !== this.identity.digest) {
      throw opError('source_changed', 'The connector source changed during the sweep.',
        `The configuration, path or incarnation of ${this.sourceId} changed while this sweep ran; writes it already admitted keep their receipts. Inspect the source on the owner before running gbrain sync --source ${this.sourceId} again.`,
        { fix: ownerStatusFix(this.sourceId, 'Shows the current registration and every pending or blocked receipt of the source.') });
    }
    const binding = await getWorktreeBinding(engine, this.sourceId);
    if ((binding?.worktree_id ?? null) !== (this.binding?.worktree_id ?? null) ||
        String(binding?.owner_epoch) !== String(this.binding?.owner_epoch) ||
        connectorBindingRoot(this.sourceId, source, binding) !== this.canonicalRoot) {
      throw opError('source_changed', 'The connector ownership changed during the sweep.',
        `The owner binding or canonical root of ${this.sourceId} changed while this sweep ran; writes it already admitted keep their receipts. Inspect the owner before running gbrain sync --source ${this.sourceId} again.`,
        { fix: ownerStatusFix(this.sourceId, 'Shows the current owner, epoch and canonical root of the source.') });
    }
    return binding;
  }
  private async retryBlocker(engine: BrainEngine): Promise<WriteRequest | undefined> {
    const [row] = await engine.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r
      WHERE ((r.source_id=$1 OR r.worktree_id=$2::uuid) AND (r.state IN ('queued','running','recovering') OR r.recovery IS NOT NULL))
        OR EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.recovery IS NOT NULL
          AND (e.source_id=$1 OR e.worktree_id=$2::uuid)) ORDER BY r.sequence LIMIT 1`, [this.sourceId, this.binding?.worktree_id ?? null]);
    return row;
  }
  private async authorizeRetryReceipt(engine: BrainEngine, row: WriteRequest): Promise<void> {
    if (row.source_id !== this.sourceId || row.principal_kind !== this.authority.writer.principal.kind || row.principal_id !== this.authority.writer.principal.id) {
      throw opError('write_pending', 'Other accepted work must drain before connector retry approval.',
        `Request ${row.request_id} of another writer or source is still ahead of the connector retry for ${this.sourceId}; nothing was re-approved. `
          + `Inspect it with gbrain sources writer status --source ${row.source_id} --json and let it finish before the next run of the same connector sync.`,
        { fix: ownerStatusFix(row.source_id, 'Shows the accepted request that blocks the retry and whether it is still running or needs recovery.') });
    }
    await authorizeStoredRequest(engine, row);
  }
  private async refuseRetryBlocker(engine: BrainEngine): Promise<void> {
    const row = await this.retryBlocker(engine);
    if (!row) return;
    await this.authorizeRetryReceipt(engine, row);
    const error = opError(row.recovery || isTerminal(row) ? 'recovery_required' : 'write_pending',
      'Accepted work must finish before connector retry approval.',
      `Request ${row.request_id} for ${row.slug} in ${row.source_id} is ${row.state}${row.recovery ? ' and needs recovery' : ''}; nothing was re-approved. `
        + `Read its receipt with gbrain write-request -- ${row.request_id} and do not resubmit it; once it is final, run the same connector sync for ${this.sourceId} again.`,
      { fix: receiptFix(row.request_id, 'The receipt says whether the blocking write committed, failed or still needs recovery.') });
    error.writeRequest = receiptFor(row);
    error.writeError = row.recovery || isTerminal(row) ? 'recovery_required' : 'write_pending';
    throw error;
  }
  private async recover(slug: string): Promise<void> {
    const binding = await this.validate(this.engine, slug);
    if (!binding) return;
    const retained = () => this.engine.executeRaw<WriteRequest>(
      'SELECT * FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL ORDER BY sequence LIMIT 1', [binding.worktree_id]);
    let [row] = await retained();
    if (!row) return;
    startPersistenceConsumer(this.engine, loadConfig() ?? { engine: this.engine.kind });
    // The retained publication may need a slow commit; honor the operator's configured write wait.
    const deadline = performance.now() + configuredWriteWaitMs(AGENT_WRITE_WAIT_MS);
    while (performance.now() < deadline) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const progress = await Promise.race([
        (async () => {
          const current = await getWriteRequestById(this.engine, row.id);
          if (!current || current.recovery || !isTerminal(current)) return { row: current ?? row, drained: false };
          writeResponse(current);
          const [next] = await retained();
          return { row: next ?? current, drained: !next };
        })(),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (progress?.drained) return;
      if (progress) row = progress.row;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - performance.now()))));
    }
    if (!row.recovery) writeResponse(row);
    const error = new OperationError('recovery_required', 'A retained connector publication still requires recovery.',
      'Inspect the retained receipt and its blocked_reason before retrying this connector.');
    error.writeRequest = receiptFor(row);
    error.writeError = 'recovery_required';
    throw error;
  }
  state<T>(empty: T): T {
    if (this.resetRequested) throw opError('storage_error', 'A requested checkpoint reset runs after the connector account check, before the checkpoint is read.',
      `The ${this.connector} connector read its checkpoint before the account check that applies the reset, so nothing was reset or synced for ${this.sourceId}. `
        + 'This is a defect in gbrain, not a caller mistake: report it to the user along with the output of gbrain doctor --json.',
      { fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', why: 'Doctor output identifies the installed version and brain state for the bug report.', requires_exclusive: false } });
    return structuredClone((this.checkpoint[0] as { state?: T } | undefined)?.state ?? empty);
  }
  async page(slug: string) {
    slug = slugifyPath(`${slug}.md`);
    await this.recover(slug);
    const snapshot = await this.engine.readPageSnapshot(slug, { sourceId: this.sourceId });
    if (snapshot && this.binding) await prepareFileTarget(this.engine,
      { source_id: this.sourceId, worktree_id: this.binding.worktree_id, slug }, snapshot, serializePageToMarkdown(snapshot.page, snapshot.tags));
    return snapshot?.page ?? null;
  }
  async importMarkdown(sourcePath: string, content: string): Promise<{ slug: string; chunks: number; status: 'imported' | 'skipped'; created: boolean }> {
    const slug = slugifyPath(sourcePath);
    const done = await this.submit('connector_v2_import', slug, sourcePath, { content });
    if (!done.row) return { slug, chunks: 0, status: 'skipped', created: false };
    if (done.pending) return { slug, chunks: 0, status: 'imported', created: done.created };
    return { slug, chunks: Number(done.row.outcome?.chunks ?? 0), status: done.row.outcome?.noop ? 'skipped' : 'imported', created: done.row.outcome?.status === 'created' };
  }
  async delete(slug: string, sourcePath: string | null): Promise<boolean> {
    slug = slugifyPath(`${slug}.md`);
    const done = await this.submit('connector_v2_delete', slug, sourcePath, {});
    if (!done.row) return false;
    return done.pending || done.row.outcome?.noop !== true;
  }
  async patchGoogleReceipts(slug: string, receipts: GoogleReceipts, pageId: number): Promise<GoogleReceipts> {
    if (this.connector !== 'google') throw opError('invalid_params', 'Attachment repair requires a Google source.',
      `Source ${this.sourceId} is a ${this.connector} connector; Gmail attachment repair runs only on a Google source with Gmail. Pick one from gbrain sources list --json, then run gbrain google attachments backfill --source with its id.`,
      { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', why: 'Lists every source with its connector kind.', requires_exclusive: false } });
    const done = await this.submit('connector_v2_google_receipts', slug, null, { googleReceipts: receipts, googlePageId: pageId, noEmbed: true });
    return (done.row!.intent as ConnectorIntent).googleReceipts!;
  }
  /**
   * Saves the connector cursor once every page receipt of this run has
   * committed. With writes still pending the save is deferred: the cursor stays
   * at the last fully committed position and the pending set is recorded at
   * the end of the run. An unchanged cursor costs no admission; when that save
   * would have stamped freshness, the source is stamped directly under the lease.
   */
  async saveState(state: unknown, fresh = false, newestContentAt?: string): Promise<void> {
    await this.drainPending();
    // A targeted refresh must not move the cursor past a carried failure it did not revisit.
    const blocked = this.targeted && this.unreachedCarried().some(entry => entry.itemRef !== CHECKPOINT_SLUG);
    if (this.pendingRows.size || this.failedPending.length || blocked) { this.deferred = true; this.lastSaveCommitted = false; return; }
    if (this.checkpoint.length && digest((this.checkpoint[0] as { state?: unknown }).state ?? null) === digest(state ?? null)) {
      if (fresh) await this.stampFreshness(newestContentAt);
      this.receipts = [];
      this.lastSaveCommitted = true;
      return;
    }
    const next = [{ generation: Number((this.checkpoint[0] as { generation?: number } | undefined)?.generation ?? 0) + 1, state: structuredClone(state) }];
    await this.submit('connector_v2_checkpoint', CHECKPOINT_SLUG, null,
      { checkpointAfter: next, receipts: [...this.receipts], fresh, ...(newestContentAt ? { newestContentAt } : {}) });
    this.checkpoint = next;
    this.receipts = [];
    this.lastSaveCommitted = true;
  }
  /** Carried pending entries this run has not re-submitted, by request identity or by item. */
  private unreachedCarried(): ConnectorPendingEntry[] {
    return this.carried.filter(entry => !this.reseen.has(entry.baseRequestId) && !this.reseenItems.has(entry.itemRef));
  }
  /** E-D4: the freshness a skipped checkpoint save would have stamped, guarded by the lease and the source incarnation. */
  private async stampFreshness(newestContentAt?: string): Promise<void> {
    const attribution = await maintenanceAttribution(this.engine);
    await this.engine.transaction(async tx => {
      await this.assertLease(tx);
      await withCoordinatedWrite(tx, [this.sourceId], () => tx.executeRaw(
        'UPDATE sources SET last_sync_at=now(),newest_content_at=COALESCE($3::timestamptz,newest_content_at) WHERE id=$1 AND incarnation=$2::uuid',
        [this.sourceId, this.source.incarnation, newestContentAt ?? null]), attribution);
    });
  }
  /** The run's remaining wait allowance; the caller's own deadline arrives through the lease signal. */
  private remainingWait(): number {
    return Math.max(0, connectorWaitBudget.ms - WAIT_RESERVE_MS - this.waitCharged);
  }
  private async budgetedWait(row: WriteRequest, cap = ITEM_WAIT_MS): Promise<WriteRequest> {
    if (isTerminal(row)) return row;
    const remaining = this.remainingWait();
    const waitMs = remaining > 0 ? Math.min(cap, remaining + COMMIT_GRACE_MS) : 0;
    const started = performance.now();
    const done = await waitForWrite(this.engine, row, loadConfig() ?? { engine: this.engine.kind }, waitMs);
    const elapsed = performance.now() - started;
    // A write that commits inside the grace is free; a wait that ends without progress spends its whole allowance.
    this.waitCharged += isTerminal(done) ? Math.max(0, elapsed - COMMIT_GRACE_MS) : Math.max(elapsed, waitMs);
    return done;
  }
  /** Re-read outstanding receipts: committed ones drop out, failed ones join the pending set for the next run. */
  private async refreshPending(): Promise<void> {
    if (!this.pendingRows.size) return;
    const rows = await this.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[])', [[...this.pendingRows.keys()]]);
    const found = new Map(rows.map(row => [row.id, row]));
    for (const [id, pending] of this.pendingRows) {
      const row = found.get(id);
      if (!row || row.state === 'committed') { this.pendingRows.delete(id); continue; }
      if (isTerminal(row)) { this.pendingRows.delete(id); this.failedPending.push(pending.entry); continue; }
      pending.row = row;
    }
  }
  /** Waits, within the run's budget, for every outstanding receipt. */
  private async drainPending(): Promise<void> {
    await this.refreshPending();
    while (this.pendingRows.size && this.remainingWait() > 0) {
      const [oldest] = this.pendingRows.values();
      await this.budgetedWait(oldest.row, this.remainingWait() + COMMIT_GRACE_MS);
      await this.refreshPending();
    }
  }
  /**
   * One page never has two writes in flight from one sweep: a later write
   * would be prepared against the revision the earlier one replaces. Waits
   * (within the budget) for the page's outstanding write, else stops the sweep.
   */
  private async awaitPagePending(slug: string): Promise<void> {
    const outstanding = () => [...this.pendingRows.values()].find(pending => pending.entry.itemRef === slug);
    let pending = outstanding();
    while (pending) {
      if (this.remainingWait() <= 0) { this.stopped = true; throw new ConnectorWaitBudgetStop(pending.row); }
      await this.budgetedWait(pending.row);
      await this.refreshPending();
      pending = outstanding();
    }
  }
  /** Keeps outstanding writes below the principal's outstanding and intent-byte limits; stops the sweep when it cannot. */
  private async makeRoom(): Promise<void> {
    const full = () => this.pendingRows.size >= this.outstandingCap ||
      [...this.pendingRows.values()].reduce((sum, pending) => sum + pending.bytes, 0) >= this.intentByteCap;
    if (!full()) return;
    await this.refreshPending();
    while (full()) {
      const [oldest] = this.pendingRows.values();
      if (this.remainingWait() <= 0) { this.stopped = true; throw new ConnectorWaitBudgetStop(oldest.row); }
      await this.budgetedWait(oldest.row);
      await this.refreshPending();
    }
  }
  /** Records the run's pending set, counts and upgrade state; written only while the lease is held. */
  async finish(): Promise<void> {
    await this.refreshPending().catch(() => {});
    const now = new Date().toISOString();
    const outstanding = [...this.pendingRows.values()].map(pending => pending.entry);
    const complete = this.lastSaveCommitted && !outstanding.length && !this.failedPending.length && !this.stopped;
    // Only a complete --full sweep (which also reconciles deletions) proves that a failed item it never reached
    // was deleted upstream. Delta and targeted runs keep every unreached carried entry for its automatic retry.
    const unreached = this.unreachedCarried();
    const dropUnreached = complete && this.fullSweep && !this.targeted;
    const unresolved = dropUnreached ? [] : unreached;
    if (dropUnreached) this.counts.dropped_upstream += unreached.filter(entry => entry.itemRef !== CHECKPOINT_SLUG).length;
    const released = await this.releasableHeldEntries([...unresolved, ...this.failedPending]).catch(() => new Set<string>());
    const pending = [...new Map([...unresolved, ...this.failedPending, ...outstanding, ...(this.pendingCheckpoint ? [this.pendingCheckpoint] : [])]
      .filter(entry => !released.has(entry.requestId))
      .map(entry => [entry.requestId, entry])).values()];
    if (outstanding.length || this.failedPending.length || this.pendingCheckpoint || this.stopped) this.deferred = true;
    const recovery = this.connectorState.upgrade_recovery === 'rewalking_once' && complete ? 'none' : this.connectorState.upgrade_recovery;
    this.connectorState = { ...this.connectorState, pending, upgrade_recovery: recovery, last_run: {
      page_admissions: this.counts.page_admissions, skipped_unchanged: this.counts.skipped_unchanged, pending: pending.length,
      checkpoint_admissions: this.counts.checkpoint_admissions, stopped_on_wait_budget: this.stopped, dropped_upstream: this.counts.dropped_upstream, finished_at: now } };
    await this.writeState();
  }
  /**
   * Fix wave 4: marks connector items held by this run. Only their terminal,
   * recovery-free failed receipts leave the automatic retry set; a queued,
   * running or recovering receipt stays outstanding.
   */
  holdSlugs(slugs: Iterable<string>): void {
    for (const slug of slugs) this.heldSlugs.add(slugifyPath(`${slug}.md`));
  }
  private async releasableHeldEntries(entries: ConnectorPendingEntry[]): Promise<Set<string>> {
    const candidates = entries.filter(entry => entry.itemRef !== CHECKPOINT_SLUG && this.heldSlugs.has(entry.itemRef));
    if (!candidates.length) return new Set();
    const rows = await this.engine.executeRaw<{ request_id: string }>(`SELECT request_id::text AS request_id FROM persistence_requests
      WHERE request_id=ANY($1::uuid[]) AND source_id=$2 AND state IN ('failed','conflict','cancelled') AND recovery IS NULL`,
    [candidates.map(entry => entry.requestId), this.sourceId]);
    return new Set(rows.map(row => row.request_id));
  }
  /**
   * Fix wave 4 abort path: publishes one checkpoint whose state is the last
   * committed cursor state plus the updated `item_holds`, so the cursor never
   * moves past an uncommitted receipt. A stale publication is refused by the
   * `checkpointBefore` digest; any failure records nothing and returns false.
   * `extra` carries connector bookkeeping that is not a cursor (#5867/#5868
   * loop recovery state) and is published with the holds.
   */
  async publishHolds(empty: Record<string, unknown>, holds: unknown, extra: Record<string, unknown> = {}): Promise<boolean> {
    if (this.resetRequested || this.stopped) return false;
    const committed = (this.checkpoint[0] as { state?: Record<string, unknown> | null } | undefined)?.state ?? null;
    const state = { ...empty, ...(committed ?? {}), ...extra, item_holds: holds };
    if (digest({ ...(committed ?? {}), item_holds: committed?.item_holds ?? { version: 1, items: {} } }) === digest({ ...(committed ?? {}), ...extra, item_holds: holds })) return true;
    const next = [{ generation: Number((this.checkpoint[0] as { generation?: number } | undefined)?.generation ?? 0) + 1, state }];
    try {
      await this.submit('connector_v2_checkpoint', CHECKPOINT_SLUG, null, { checkpointAfter: next, receipts: [], fresh: false });
      this.checkpoint = next;
      return true;
    } catch {
      return false;
    }
  }
  /** #5673: keep the dispatch-gate stamp in the state this session writes back. */
  markSyncAttempted(): void {
    this.connectorState = { ...this.connectorState, first_attempt_at: this.connectorState.first_attempt_at ?? new Date().toISOString() };
  }
  /** One statement: the state row changes only while this run still holds the connector sync lease. */
  private async writeState(): Promise<void> {
    if (!this.lease) { await writeManagedConnectorState(this.engine, this.sourceId, this.source.incarnation, this.connectorState); return; }
    this.lease.signal.throwIfAborted();
    const { handle } = this.lease;
    const written = await writeManagedConnectorState(this.engine, this.sourceId, this.source.incarnation, this.connectorState,
      { id: handle.id, token: handle.acquisitionToken, acquiredAt: handle.acquiredAt });
    if (!written) throw new LockStolenError(handle.id);
  }
  /** The last run's counts, for the caller's result. */
  runCounts(): ConnectorRunCounts | null { return this.connectorState.last_run; }
  /**
   * #5470: screens an import or delete through the publication's own preparer
   * on an unadmitted request; the item skips admission only when the no-op
   * kernel finds nothing to publish and the preparer's validation still holds.
   */
  private async unchanged(kind: ConnectorIntentKind, slug: string, intent: ConnectorIntent, snapshot: PageSnapshot | null, sourcePath: string | null): Promise<boolean> {
    try {
      const row = screeningRequest({ source_id: this.sourceId, source_incarnation: this.source.incarnation, slug, page_id: snapshot?.page.id ?? null,
        worktree_id: this.binding?.worktree_id ?? null, authority: this.authority.writer, intent });
      const prepared = await prepareConnectorMutation(this.engine, row);
      if (kind === 'connector_v2_delete') {
        if (this.binding || prepared.noop !== true) return false;
      } else {
        const verdict = await inspectUnchanged(this.engine, { prepared, snapshot, sourcePath, databaseOnly: !this.binding });
        if (verdict.admitReason) return false;
      }
      await prepared.validate?.(this.engine);
      return true;
    } catch (error) {
      if (error instanceof LockStolenError) throw error;
      return false;
    }
  }
  private async submit(kind: ConnectorIntentKind, slug: string, sourcePath: string | null, extra: Partial<ConnectorIntent>):
    Promise<{ row: WriteRequest | null; pending: boolean; created: boolean }> {
    await this.awaitPagePending(slug);
    await this.recover(slug);
    const snapshot = await this.engine.readPageSnapshot(slug, { sourceId: this.sourceId, includeDeleted: true });
    if (kind === 'connector_v2_google_receipts') {
      if (!snapshot || snapshot.page.id !== extra.googlePageId) throw opError('page_identity_changed', 'The historical Gmail page was deleted or recreated.',
        `Page ${slug} in ${this.sourceId} was deleted or recreated after the attachment repair read it, so its receipts were not patched. Read the current page, then run gbrain google attachments backfill --source ${this.sourceId} again.`,
        { fix: { argv: ['gbrain', 'get', '--source', this.sourceId, '--', slug], consent: [], actor: 'agent', why: 'Shows whether the page exists now and which page id it carries.', requires_exclusive: false } });
      extra.googleReceipts = ownedGoogleReceipts(snapshot, (this.identity.config as GoogleSourceConfig).account, extra.googleReceipts!);
      sourcePath = snapshot!.page.source_path!;
    }
    const file = kind === 'connector_v2_checkpoint' ? undefined : await connectorFileTarget(this.engine,
      { source_id: this.sourceId, worktree_id: this.binding?.worktree_id ?? null, slug }, snapshot, extra.content ?? null, sourcePath, this.canonicalRoot);
    if (file && sourcePath && resolve(file.path) !== resolve(this.canonicalRoot!, sourcePath)) {
      throw opError('source_changed', 'The connector source path no longer names its canonical file.',
        `The recorded path of ${slug} no longer resolves to its canonical file under the root of ${this.sourceId}, so nothing was submitted. Inspect the root and binding before running gbrain sync --source ${this.sourceId} again.`,
        { fix: ownerStatusFix(this.sourceId, 'Shows the canonical root the connector file path must resolve under.') });
    }
    const intent: ConnectorIntent = { kind, connector: this.connector, sourceRoot: this.source.local_path,
      configHash: this.identity.digest, syncAuthority: this.authority, expected_revision: snapshot?.revision ?? null,
      sourcePath, noEmbed: this.noEmbed, noSchemaPack: this.noSchemaPack, checkpointKey: this.checkpointKey,
      checkpointBefore: kind === 'connector_v2_checkpoint' ? this.checkpoint : cursorOnly(this.checkpoint),
      ownerEpoch: this.binding ? String(this.binding.owner_epoch) : null, canonicalRoot: this.canonicalRoot,
      filePath: file?.path ?? null, fileBeforeHash: file?.expectedBeforeHash ?? null, ...extra };
    const callerIntent = { ...intent, syncAuthority: undefined, newestContentAt: undefined,
      ...(kind === 'connector_v2_checkpoint' ? { receipts: undefined } : {}) };
    const principal = this.authority.writer.principal;
    const baseRequestId = stableId({ principal, sourceId: this.sourceId, incarnation: this.source.incarnation, callerIntent });
    const page = kind === 'connector_v2_import' || kind === 'connector_v2_delete';
    this.reseen.add(baseRequestId);
    this.reseenItems.add(slug);
    const admission = (retry?: ConnectorRetry) => {
      const link = retry ? { retryBase: baseRequestId, retryOf: retry.retryOf, retryAttempt: retry.attempt } : {};
      return { principal, requestId: retry?.requestId ?? baseRequestId, operation: 'submit_job', sourceId: this.sourceId,
        sourceIncarnation: this.source.incarnation, slug, pageId: snapshot?.page.id ?? null, callerIntent: { ...callerIntent, ...link }, intent: { ...intent, ...link },
        authority: this.authority.writer, worktreeId: this.binding?.worktree_id, topologyGeneration: this.binding?.topology_generation };
    };
    const selected = async (engine: BrainEngine) => {
      const [pointer] = await engine.executeRaw<{ completed_keys: ConnectorRetry[] }>(
        "SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector-retry' AND fingerprint=$1", [baseRequestId]);
      const retry = pointer?.completed_keys[0];
      const input = admission(retry);
      const row = await getWriteRequest(engine, principal, input.requestId);
      if (row) {
        await authorizeStoredRequest(engine, row);
        assertReplayIntent(row, intentDigest(input));
      } else if (retry && !retry.pending) throw opError('storage_error', 'The approved connector retry receipt is unavailable.',
        `The retry approved for ${slug} in ${this.sourceId} points at request ${retry.requestId}, which no longer exists; nothing was admitted. Inspect the source's receipts, then re-approve held items with gbrain sources retry-held ${this.sourceId}.`,
        { fix: ownerStatusFix(this.sourceId, 'Shows the source\'s receipts and any retained recovery before a retry is approved again.') });
      return { retry, input, row };
    };
    const automatic = this.autoRetry.has(baseRequestId);
    const mayRetry = (row: WriteRequest | null) => (this.retryFailed || automatic) && row && ['failed', 'conflict'].includes(row.state) &&
      row.request_id === (this.retryApprovals.get(baseRequestId) ?? baseRequestId);
    const prior = await selected(this.engine);
    let row = prior.row;
    let admitted = false;
    if (mayRetry(row)) {
      const failedRow = row!;
      const lock = this.binding ? await acquireWorktree(this.binding, 1000, undefined, this.engine) : null;
      try {
        if (this.binding && !lock) {
          await this.refuseRetryBlocker(this.engine);
          throw opError('write_pending', 'The canonical owner is busy; retry approval has not changed.',
            `The owner of ${this.sourceId} is busy, so the failed write ${failedRow.request_id} for ${slug} was not re-approved and nothing new was admitted. Check the owner's queue; the next run of the same connector sync re-attempts it once the owner is free.`,
            { fix: ownerStatusFix(this.sourceId, 'Shows what the canonical owner is running and what is queued behind it.') });
        }
        row = await this.engine.transaction(async tx => {
          if (this.binding) await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [this.binding.worktree_id]);
          await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [this.sourceId]);
          await this.validate(tx, slug);
          await authorizeWrite(tx, this.authority.writer, 'submit_job', slug, true);
          const current = await selected(tx);
          if (!current.row) throw opError('storage_error', 'The failed connector receipt is unavailable.',
            `Failed request ${failedRow.request_id} for ${slug} in ${this.sourceId} disappeared before its retry was approved; nothing was admitted. Inspect the source's receipts before running the same connector sync again.`,
            { fix: ownerStatusFix(this.sourceId, 'Shows the source\'s current receipts and recovery state.') });
          await authorizeStoredRequest(tx, current.row, true);
          if (!mayRetry(current.row)) return current.row;
          await this.refuseRetryBlocker(tx);
          const [checkpoint] = await tx.executeRaw<{ completed_keys: unknown[] }>(
            "SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1 FOR UPDATE", [this.checkpointKey]);
          if (digest(checkpoint?.completed_keys ?? []) !== digest(this.checkpoint)) throw opError('revision_conflict', 'The connector cursor changed before retry approval.',
            `Another run moved the connector cursor of ${this.sourceId} while this one re-approved ${slug}; nothing was admitted. Run gbrain sync --source ${this.sourceId} to continue from the new cursor.`,
            { fix: connectorSyncFix(this.sourceId, 'A new run reads the current cursor and resolves the recorded pending set first.') });
          const attempt = (current.retry?.attempt ?? 0) + 1;
          const retry: ConnectorRetry = { checkpointKey: this.checkpointKey,
            principalId: principal.id, principalKind: principal.kind, baseRequestId, retryOf: current.row.request_id, attempt,
            requestId: stableId({ baseRequestId, retryOf: current.row.request_id, attempt }) };
          const accepted = await admitWriteInTransaction(tx, admission(retry));
          await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-connector-retry',$1,$2::text::jsonb)
            ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [baseRequestId, JSON.stringify([retry])]);
          admitted = true;
          return accepted;
        });
        this.retryApprovals.set(baseRequestId, row.request_id);
      } catch (error) {
        // An automatic retry waits behind other accepted work like any pending write.
        if (automatic && !this.retryFailed && error instanceof OperationError && error.code === 'write_pending') {
          this.failedPending.push({ itemRef: slug, requestId: failedRow.request_id, baseRequestId, admittedAt: new Date(failedRow.created_at).toISOString() });
          return { row: failedRow, pending: true, created: !snapshot };
        }
        if (error instanceof OperationError) throw error;
        throw new OperationError('storage_error', 'Connector retry approval could not be confirmed.',
          'Repeat the same connector sync options; an admitted replacement keeps its existing request identity.');
      } finally { await lock?.release(); }
    } else if (!row) {
      if (page && !prior.retry && await this.unchanged(kind, slug, intent, snapshot, sourcePath)) {
        this.counts.skipped_unchanged++;
        return { row: null, pending: false, created: false };
      }
      row = await this.engine.transaction(async tx => {
        await this.assertLease(tx);
        const accepted = await admitWriteInTransaction(tx, prior.input);
        // A `retry-held` approval is consumed by this admission under its new request identity.
        if (prior.retry?.pending) await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-connector-retry',$1,$2::text::jsonb)
          ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [baseRequestId, JSON.stringify([{ ...prior.retry, pending: undefined }])]);
        return accepted;
      });
      admitted = true;
    }
    if (admitted) {
      if (page) this.counts.page_admissions++;
      if (kind === 'connector_v2_checkpoint') this.counts.checkpoint_admissions++;
    }
    if (kind === 'connector_v2_google_receipts') {
      row = await waitForWrite(this.engine, row!, loadConfig() ?? { engine: this.engine.kind });
      writeResponse(row);
      this.receipts.push(row.id);
      return { row, pending: false, created: false };
    }
    row = await this.budgetedWait(row!);
    if (kind === 'connector_v2_checkpoint') {
      if (!isTerminal(row)) {
        this.pendingCheckpoint = { itemRef: CHECKPOINT_SLUG, requestId: row.request_id, baseRequestId, admittedAt: new Date(row.created_at).toISOString() };
        this.stopped = true;
        throw new ConnectorWaitBudgetStop(row);
      }
      writeResponse(row);
      return { row, pending: false, created: false };
    }
    if (isTerminal(row)) {
      writeResponse(row);
      this.receipts.push(row.id);
      if (row.outcome?.noop !== true) {
        if (kind === 'connector_v2_delete') this.counts.deleted++; else if (row.outcome?.status === 'created') this.counts.created++; else this.counts.updated++;
      }
      return { row, pending: false, created: row.outcome?.status === 'created' };
    }
    this.receipts.push(row.id);
    this.pendingRows.set(row.id, { row, bytes: Buffer.byteLength(JSON.stringify(intent)),
      entry: { itemRef: slug, requestId: row.request_id, baseRequestId, admittedAt: new Date(row.created_at).toISOString() } });
    if (!snapshot) this.counts.created++; else if (kind === 'connector_v2_delete') this.counts.deleted++; else this.counts.updated++;
    await this.makeRoom();
    return { row, pending: true, created: !snapshot };
  }
}

export async function prepareConnectorMutation(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const p = row.intent as ConnectorIntent | null;
  if (!p || !CONNECTOR_V2_KINDS.includes(p.kind) ||
      p.syncAuthority.writer.remote || p.syncAuthority.remoteJob) throw connectorPublicationRefusal('permission_denied', 'Unsupported connector authority.', row,
    'The request does not carry a local connector writer\'s authority; only the trusted local CLI publishes connector content.');
  if (!row.worktree_id && (row.authority.databaseOnlyReason !== 'connector_database' || p.syncAuthority.writer.databaseOnlyReason !== 'connector_database') ||
      row.worktree_id && (row.authority.databaseOnlyReason !== undefined || p.syncAuthority.writer.databaseOnlyReason !== undefined)) {
    throw connectorPublicationRefusal('permission_denied', 'Connector database-only authority does not match its binding.', row,
      `The request's database-only authority no longer matches whether ${row.source_id} has a worktree binding (the source was bound or unbound after admission).`);
  }
  const validate = async (tx: BrainEngine) => {
    await validateSyncAuthority(tx, p.syncAuthority, row.slug);
    const [source] = await tx.executeRaw<ConnectorSource>('SELECT incarnation,archived,local_path,config FROM sources WHERE id=$1', [row.source_id]);
    if (!source || source.archived || source.incarnation !== row.source_incarnation || source.config.kind !== p.connector ||
        connectorIdentity(p.connector, source.config, source.local_path).digest !== p.configHash || source.local_path !== p.sourceRoot) {
      throw connectorPublicationRefusal('source_changed', 'The connector configuration changed after admission.', row,
        `The connector configuration, path or incarnation of ${row.source_id} changed after this write was admitted.`);
    }
    const binding = await getWorktreeBinding(tx, row.source_id);
    if ((binding?.worktree_id ?? null) !== row.worktree_id || (binding ? String(binding.owner_epoch) : null) !== p.ownerEpoch) {
      throw connectorPublicationRefusal('source_changed', 'The connector ownership binding changed after admission.', row,
        `The owner binding of ${row.source_id} changed after this write was admitted.`);
    }
    if (connectorBindingRoot(row.source_id, source, binding) !== p.canonicalRoot) throw connectorPublicationRefusal('source_changed', 'The connector canonical root changed after admission.', row,
      `The canonical root of ${row.source_id} changed after this write was admitted.`);
    if (p.filePath !== null && (!p.canonicalRoot || !isWriteTargetContained(p.filePath, p.canonicalRoot) || persistenceFileHash(p.filePath) !== p.fileBeforeHash)) {
      throw connectorPublicationRefusal('source_changed', 'The connector canonical file changed after admission.', row,
        `The canonical file of ${row.slug} in ${row.source_id} changed on disk after this write was admitted.`);
    }
    if (p.kind !== 'connector_v2_checkpoint') {
      const [checkpoint] = await tx.executeRaw<{ completed_keys: unknown[] }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [p.checkpointKey]);
      if (digest(cursorOnly(checkpoint?.completed_keys)) !== digest(cursorOnly(p.checkpointBefore))) throw connectorPublicationRefusal('revision_conflict', 'The connector checkpoint changed before publication.', row,
        `Another run moved the connector cursor of ${row.source_id} before this write published.`);
    }
  };
  await validate(engine);
  if (p.kind === 'connector_v2_checkpoint') return { observedRevision: null, sourceExclusive: true, validate, apply: async tx => {
    const [current] = await tx.executeRaw<{ completed_keys: unknown[] }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1 FOR UPDATE", [p.checkpointKey]);
    if (digest(current?.completed_keys ?? []) !== digest(p.checkpointBefore)) throw opError('revision_conflict', 'The connector checkpoint changed during the sweep.',
      `Another run moved the connector cursor of ${row.source_id} during this sweep, so checkpoint request ${row.request_id} was refused and the cursor stayed where that run left it. Read the receipt; the next gbrain sync --source ${row.source_id} saves the cursor again.`,
      { fix: receiptFix(row.request_id, 'The receipt confirms the checkpoint save did not commit.') });
    const receipts = p.receipts ?? [];
    const committed = await tx.executeRaw<{ id: string }>("SELECT id FROM persistence_requests WHERE id=ANY($1::uuid[]) AND source_id=$2 AND source_incarnation=$3::uuid AND state='committed'", [receipts, row.source_id, row.source_incarnation]);
    if (committed.length !== new Set(receipts).size) throw opError('write_pending', 'A connector page receipt has not committed.',
      `A page write that checkpoint request ${row.request_id} depends on has not committed, so the cursor of ${row.source_id} did not advance. Read the receipt; the next gbrain sync --source ${row.source_id} waits for the pending page writes before it saves the cursor again.`,
      { fix: receiptFix(row.request_id, 'The receipt confirms the checkpoint save did not commit.') });
    await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-connector',$1,$2::text::jsonb)
      ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [p.checkpointKey, JSON.stringify(p.checkpointAfter)]);
    if (p.fresh) await tx.executeRaw('UPDATE sources SET last_sync_at=now(),newest_content_at=COALESCE($3::timestamptz,newest_content_at) WHERE id=$1 AND incarnation=$2::uuid',
      [row.source_id, row.source_incarnation, p.newestContentAt ?? null]);
    return { status: 'checkpointed', source_id: row.source_id };
  } };
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  if ((snapshot?.revision ?? null) !== p.expected_revision || (snapshot?.page.id ?? null) !== row.page_id ||
      snapshot?.page.source_path != null && snapshot.page.source_path !== p.sourcePath) {
    throw connectorPublicationRefusal('revision_conflict', 'The connector page changed after admission.', row,
      `Page ${row.slug} in ${row.source_id} changed after this connector write was admitted.`);
  }
  const deleteFile = p.kind === 'connector_v2_delete' ? await prepareFileTarget(engine, row, snapshot, null) : undefined;
  if (p.kind === 'connector_v2_delete') return { observedRevision: snapshot?.revision ?? null, sourceExclusive: true, validate,
    file: deleteFile, ...databaseOnlyPublication(row, deleteFile),
    noop: !snapshot || snapshot.page.deleted_at != null, apply: async tx => {
      if (snapshot && snapshot.page.deleted_at == null) {
        await tx.createVersion(row.slug, { sourceId: row.source_id });
        await tx.softDeletePage(row.slug, { sourceId: row.source_id });
      }
      return { status: 'soft_deleted', slug: row.slug, source_id: row.source_id, noop: !snapshot || snapshot.page.deleted_at != null };
    } };
  if (p.kind === 'connector_v2_google_receipts') {
    if (p.connector !== 'google' || !p.googleReceipts) throw connectorPublicationRefusal('invalid_params', 'Invalid Google attachment receipt mutation.', row,
      'The request is not an attachment-receipt patch for a Google source.');
    const [source] = await engine.executeRaw<ConnectorSource>('SELECT incarnation,archived,local_path,config FROM sources WHERE id=$1', [row.source_id]);
    const account = (connectorIdentity('google', source.config, source.local_path).config as GoogleSourceConfig).account;
    const prepared = await prepareGoogleReceiptPatch(engine, row, snapshot, account, p.googleReceipts);
    return { ...prepared, validate };
  }
  if (!p.sourcePath || typeof p.content !== 'string' || slugifyPath(p.sourcePath) !== row.slug ||
      p.sourcePath.split('/').some(part => !part || part === '.' || part === '..') || p.sourcePath.includes('\\')) {
    throw connectorPublicationRefusal('invalid_params', 'The connector import path is invalid.', row,
      `The recorded source path is empty, escapes the source, or does not map to ${row.slug}.`);
  }
  const activePack = p.noSchemaPack ? undefined : (await loadActivePackForEngine(engine, { remote: false, sourceId: row.source_id }).catch(() => null))?.manifest;
  const parsed = parseMarkdown(p.content, row.slug, { activePack });
  if (parsed.slug !== row.slug) throw connectorPublicationRefusal('invalid_params', 'The connector content changes its page identity.', row,
    `The provider content's frontmatter names a slug other than ${row.slug}.`);
  // #5567: carry materialized and database-only timeline rows forward into the connector render.
  const carried = await materializeTimeline(engine, parsed, row.slug, snapshot, 'preserving');
  // Facts and takes fences added on the brain (remember, loop extraction) are not part of the provider's render;
  // carry them over verbatim so a re-render does not expire those facts. A render that brings its own fence
  // (a provider body that contains one) owns it, and ambiguous stored fences are left to the existing path.
  const hasFence = (text: string | null | undefined) => [FACTS_FENCE_BEGIN, TAKES_FENCE_BEGIN].some(begin => (text ?? '').includes(begin));
  // Fix wave 4: a stored fence the render cannot carry verbatim (below the timeline sentinel, duplicated,
  // unbalanced or unparseable) is refused instead of silently expiring its rows on re-render.
  const storedFence = snapshot && !hasFence(parsed.compiled_truth) && (hasFence(snapshot.page.compiled_truth) || hasFence(snapshot.page.timeline));
  const hold = storedFence ? conceptPreservationHold(snapshot!.page) : null;
  if (hold) throw connectorFenceRefusal(row.source_id, row.slug, hold);
  const fenced = storedFence && hasFence(snapshot!.page.compiled_truth)
    ? preserveCanonicalFences(snapshot!.page, parsed.compiled_truth) : parsed.compiled_truth;
  const content = (carried.materialized || fenced !== parsed.compiled_truth) && snapshot
    ? serializePageToMarkdown({ ...snapshot.page, ...parsed, compiled_truth: fenced, timeline: carried.timeline, type: parsed.typeExplicit ? parsed.type : snapshot.page.type }, parsed.tags)
    : p.content;
  let prepared: PreparedContentImport | undefined;
  const result = await importFromContent(engine, row.slug, content, { sourceId: row.source_id, sourcePath: p.sourcePath,
    filename: basename(p.sourcePath).replace(/\.mdx?$/i, ''), noEmbed: true, allowEmptyOverwrite: true, activePack,
    prepareFrontmatter: page => {
      if (snapshot?.page.frontmatter.visibility === 'private') page.frontmatter.visibility = 'private';
    },
    prepare: async value => { prepared = value; return value.result; } });
  if (!prepared || prepared.slug !== row.slug) throw connectorPublicationRefusal('revision_conflict', result.error ?? 'A different page owns this connector content.', row,
    `Another page already owns this connector content's identity, so ${row.slug} was not written.`);
  const ready = prepared;
  if (ready.observedRevision !== (snapshot?.revision ?? null)) throw connectorPublicationRefusal('revision_conflict', 'The connector page changed during preparation.', row,
    `Page ${row.slug} in ${row.source_id} changed while this connector write was being prepared.`);
  const project = await prepareCanonicalProjections(engine, ready.parsedPage, row.slug, row.source_id, snapshot, 'preserving');
  const tags = [...new Set([...(snapshot?.tags ?? []), ...ready.parsedPage.tags])].sort();
  const page: Page = { ...(snapshot?.page ?? { id: 0, slug: row.slug, source_id: row.source_id, created_at: new Date(row.created_at), updated_at: new Date(row.created_at) }), ...ready.parsedPage };
  const target = await connectorFileTarget(engine, row, snapshot, serializePageToMarkdown(page, tags), p.sourcePath, p.canonicalRoot);
  // Google pages hold private mail: derived here from the stored connector, never submitted, so request ids are unchanged.
  const file = target && p.connector === 'google' ? { ...target, publishMode: 0o600 } : target;
  if (file && (file.path !== p.filePath || file.expectedBeforeHash !== p.fileBeforeHash)) throw connectorPublicationRefusal('source_changed', 'The connector canonical file changed during preparation.', row,
    `The canonical file of ${row.slug} in ${row.source_id} changed on disk while this connector write was being prepared.`);
  return { observedRevision: ready.observedRevision, sourceExclusive: true,
    validate: async tx => { await validate(tx); await ready.validate(tx); },
    file, ...databaseOnlyPublication(row, file), noop: ready.noop, deferEmbedding: p.noEmbed, apply: async tx => {
    await ready.apply(tx);
    if (!ready.noop) { await project(tx); await sealPageTextProjection(tx, row.slug, row.source_id); }
    return { status: ready.noop ? 'skipped' : snapshot ? 'updated' : 'created', slug: row.slug, source_id: row.source_id,
      chunks: result.chunks, noop: ready.noop, imported_file: true, connector_database: !row.worktree_id };
  } };
}

/**
 * A connector intent in the retired `managed_connector_*` format. The consumer
 * recovers any file publication already in progress before it prepares a
 * request, so this runs only for requests with nothing left to recover and
 * fails them terminally. A request admitted before the upgrade's cutoff was
 * written by this host's previous binary and is simply fetched again; one
 * admitted after it names the connector host that still needs upgrading.
 */
export async function prepareOutdatedConnectorMutation(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const cutoff = await readConnectorV2Cutoff(engine);
  const preUpgrade = cutoff !== null && new Date(row.created_at).getTime() < new Date(cutoff).getTime();
  const message = preUpgrade ? CONNECTOR_INTENT_OUTDATED_PRE_UPGRADE : CONNECTOR_INTENT_OUTDATED_OLD_HOST;
  const hint = receiptDeliveredHint({ error_code: 'connector_intent_outdated', error_message: message, source_id: row.source_id })!;
  throw opError('connector_intent_outdated', message, hint.suggestion, { docs: hint.docs, ...(hint.detail ? { detail: hint.detail } : {}),
    fix: preUpgrade ? connectorSyncFix(row.source_id, 'The item is fetched again under a new request ID; no host upgrade is needed.')
      : { argv: ['gbrain', 'upgrade'], consent: [], actor: 'user', requires_exclusive: false,
        why: `A host running an older gbrain admitted this connector write for ${row.source_id} in the retired format.`,
        user_message: `Please run the command shown on the host that runs connector jobs for ${row.source_id}, then sync it again.` } });
}

/** `connector_fence_below_timeline`: the item is counted toward a hold; the repair moves the fence above the sentinel. */
export function connectorFenceRefusal(sourceId: string, slug: string, hold: string): OperationError {
  const error = new OperationError('connector_fence_below_timeline',
    `The stored page ${slug} has a facts or takes fence the connector render cannot carry (${hold}); refusing instead of expiring its rows.`,
    connectorFenceHint(sourceId), docsAnchor('connector_fence_below_timeline'));
  error.detail = 'fence_not_carried';
  return error;
}

export function rethrowConnectorWriteError(error: unknown): void {
  if (error instanceof OperationError || error instanceof LockStolenError || error instanceof ConnectorWaitBudgetStop) throw error;
}
