import { realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts } from '../../commands/sync.ts';
import { loadConfig } from '../config.ts';
import { importFromContent } from '../import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { slugifyPath } from '../sync.ts';
import type { Page } from '../types.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { OperationError } from '../ops/contract.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { authorizeStoredRequest, authorizeWrite } from './authority.ts';
import { prepareCanonicalProjections } from './canonical-projections.ts';
import { digest, sha256 } from './digest.ts';
import { admitWriteInTransaction, assertReplayIntent, getWriteRequest, getWriteRequestById, intentDigest, receiptFor } from './journal.ts';
import { acquireWorktree, containsPath, getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { localHostId } from './identity.ts';
import { assertPersistenceAccepting, startPersistenceConsumer, waitForWrite, writeResponse } from './service.ts';
import { managedSyncAuthority, validateManagedSyncOptions, validateSyncAuthority, type SyncAuthority } from './sync-authority.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import { persistenceFileHash, type PreparedMutation } from './coordinator.ts';
import { isTerminal, type WriteRequest } from './model.ts';
import { prepareFileTarget } from './page-prepare.ts';
import { assertPhysicalRoot } from './physical-root.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { LockStolenError, syncLockId, withRefreshingLock, type DbLockHandle } from '../db-lock.ts';

type ConnectorKind = 'google' | 'github';
interface ConnectorLease { handle: DbLockHandle; signal: AbortSignal; }
interface ConnectorSource { incarnation: string; archived: boolean; local_path: string | null; config: Record<string, unknown>; }
interface ConnectorRetry {
  checkpointKey: string;
  principalId: string;
  principalKind: string;
  baseRequestId: string;
  requestId: string;
  retryOf: string;
  attempt: number;
}
interface ConnectorIntent extends Record<string, unknown> {
  kind: 'managed_connector_import' | 'managed_connector_delete' | 'managed_connector_checkpoint';
  connector: ConnectorKind;
  configHash: string;
  sourceRoot: string | null;
  syncAuthority: SyncAuthority;
  expected_revision: string | null;
  sourcePath: string | null;
  content?: string;
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

function connectorBindingRoot(sourceId: string, source: ConnectorSource, binding: WorktreeBinding | null): string | null {
  if (!binding) return null;
  if (binding.owner_host_id !== localHostId() || !binding.local_path || !binding.coordination_path) {
    throw new OperationError('owner_unavailable', 'The connector canonical owner is unavailable on this host.');
  }
  if (binding.source_id !== sourceId || binding.source_incarnation !== source.incarnation || !source.local_path) {
    throw new OperationError('source_changed', 'The connector source does not match its canonical binding.');
  }
  assertPhysicalRoot(binding.local_path, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path });
  try {
    const root = realpathSync(join(binding.local_path, binding.relative_path));
    const configured = source.config[source.config.kind === 'google' ? 'g_dir' : 'gh_dir'];
    const directory = typeof configured === 'string' && configured.length > 0 ? configured : source.local_path;
    if (!containsPath(binding.local_path, root) || !statSync(root).isDirectory() || realpathSync(source.local_path) !== root || realpathSync(directory) !== root) {
      throw new Error('root mismatch');
    }
    return root;
  } catch {
    throw new OperationError('source_changed', 'The connector directory no longer matches its canonical source root.');
  }
}

function stableId(value: unknown): string {
  const hash = digest(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function connectorFileTarget(engine: BrainEngine, row: Pick<WriteRequest, 'source_id' | 'worktree_id' | 'slug'>,
  snapshot: PageSnapshot | null, content: string | null, sourcePath: string | null, root: string | null): Promise<PreparedMutation['file']> {
  if (!row.worktree_id || snapshot || !sourcePath || !root) return prepareFileTarget(engine, row, snapshot, content);
  const path = resolve(root, sourcePath);
  if (!isWriteTargetContained(path, root)) throw new OperationError('source_changed', 'The canonical file target is outside its registered source.');
  const before = persistenceFileHash(path);
  if (before && content !== null && before !== sha256(content)) {
    throw new OperationError('source_changed', 'An unindexed file already occupies the canonical page path.', 'Import the file before replacing it.');
  }
  return { path, root, content, expectedBeforeHash: before };
}

export async function beginConnectorSync(engine: BrainEngine, sourceId: string, connector: ConnectorKind,
  suppliedConfig: unknown, opts: SyncOpts, lease?: ConnectorLease): Promise<ManagedConnectorSync | null> {
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (!brain?.enabled) return null;
  assertPersistenceAccepting(engine);
  validateManagedSyncOptions(opts);
  if (opts.dryRun || opts.skipFailed || opts.srcSubpath || opts.exclude?.length || opts.includeHidden?.length ||
      opts.includeGitignored || opts.workingTree || opts.strategy === 'code' || connector === 'google' && opts.githubItem) {
    throw new OperationError('invalid_params', 'Managed connector sync does not support dry runs, Git file filters, or --skip-failed.');
  }
  const caller = currentSubmissionAuthority();
  if (caller && caller.kind !== 'application') throw new OperationError('permission_denied', 'Connector sync requires a trusted local CLI writer; remote jobs cannot acquire connector credentials.');
  const [source] = await engine.executeRaw<ConnectorSource>('SELECT incarnation,archived,local_path,config FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The connector source is not active.');
  if (source.config.kind !== connector) throw new OperationError('writer_coordinator_required', 'Managed connector sync requires a registered connector source; legacy filesystem calls are unsupported.');
  const config = connector === 'google'
    ? (await import('../google/google-source.ts')).parseGoogleSourceConfig(source.config, source.local_path ?? '')
    : (await import('../github-source.ts')).parseGitHubSourceConfig(source.config, source.local_path ?? '');
  if (digest(config) !== digest(suppliedConfig) || opts.sourceId !== undefined && opts.sourceId !== sourceId) {
    throw new OperationError('source_changed', 'Connector options do not match the registered source.');
  }
  const authority = await managedSyncAuthority(engine, sourceId, source.incarnation, source.local_path ?? '');
  const binding = await getWorktreeBinding(engine, sourceId);
  const canonicalRoot = connectorBindingRoot(sourceId, source, binding);
  if (binding) await (await acquireWorktree(binding))?.release();
  else authority.writer.databaseOnlyReason = 'connector_database';
  const session = new ManagedConnectorSync(engine, sourceId, connector, source, authority, binding, canonicalRoot, opts.noEmbed === true, opts.noSchemaPack === true, opts.retryFailed === true, lease);
  await session.load();
  return session;
}

export async function withConnectorSync<T>(engine: BrainEngine, sourceId: string, connector: ConnectorKind,
  config: unknown, opts: SyncOpts, work: (session: ManagedConnectorSync | null, opts: SyncOpts) => Promise<T>): Promise<T> {
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (!brain?.enabled) return work(null, opts);
  opts.signal?.throwIfAborted();
  return withRefreshingLock(engine, syncLockId(sourceId), async (signal, handle) => {
    const combined = opts.signal ? AbortSignal.any([opts.signal, signal]) : signal;
    const options = { ...opts, signal: combined };
    const session = await beginConnectorSync(engine, sourceId, connector, config, options, { handle, signal: combined });
    if (!session) throw new OperationError('source_changed', 'The managed connector mode changed before the sweep.');
    const result = await work(session, options);
    await session.assertLease(engine);
    return result;
  });
}

export class ManagedConnectorSync {
  private checkpoint: unknown[] = [];
  private receipts: string[] = [];
  private retryApprovals = new Map<string, string>();
  readonly checkpointKey: string;
  constructor(private engine: BrainEngine, readonly sourceId: string, private connector: ConnectorKind,
    private source: ConnectorSource, private authority: SyncAuthority, private binding: WorktreeBinding | null,
    private canonicalRoot: string | null, private noEmbed: boolean, private noSchemaPack: boolean, private retryFailed = false,
    private lease?: ConnectorLease) {
    this.checkpointKey = digest({ sourceId, incarnation: source.incarnation, connector, config: source.config });
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
    const [row] = await this.engine.executeRaw<{ completed_keys: unknown[] }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [this.checkpointKey]);
    this.checkpoint = row?.completed_keys ?? [];
    if (this.retryFailed) {
      const pointers = await this.engine.executeRaw<{ completed_keys: ConnectorRetry[] }>(`SELECT completed_keys FROM op_checkpoints
        WHERE op='managed-connector-retry' AND completed_keys->0->>'checkpointKey'=$1
        AND completed_keys->0->>'principalId'=$2 AND completed_keys->0->>'principalKind'=$3`,
      [this.checkpointKey, this.authority.writer.principal.id, this.authority.writer.principal.kind]);
      this.retryApprovals = new Map(pointers.map(row => [row.completed_keys[0].baseRequestId, row.completed_keys[0].requestId]));
    }
  }
  private async validate(engine: BrainEngine, slug: string): Promise<WorktreeBinding | null> {
    await this.assertLease(engine);
    await validateSyncAuthority(engine, this.authority, slug);
    const [source] = await engine.executeRaw<ConnectorSource>('SELECT incarnation,archived,local_path,config FROM sources WHERE id=$1', [this.sourceId]);
    if (!source || source.archived || source.incarnation !== this.source.incarnation ||
        source.local_path !== this.source.local_path || digest(source.config) !== digest(this.source.config)) {
      throw new OperationError('source_changed', 'The connector source changed during the sweep.');
    }
    const binding = await getWorktreeBinding(engine, this.sourceId);
    if ((binding?.worktree_id ?? null) !== (this.binding?.worktree_id ?? null) ||
        String(binding?.owner_epoch) !== String(this.binding?.owner_epoch) ||
        connectorBindingRoot(this.sourceId, source, binding) !== this.canonicalRoot) {
      throw new OperationError('source_changed', 'The connector ownership changed during the sweep.');
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
      throw new OperationError('write_pending', 'Other accepted work must drain before connector retry approval.');
    }
    await authorizeStoredRequest(engine, row);
  }
  private async refuseRetryBlocker(engine: BrainEngine): Promise<void> {
    const row = await this.retryBlocker(engine);
    if (!row) return;
    await this.authorizeRetryReceipt(engine, row);
    const error = new OperationError(row.recovery || isTerminal(row) ? 'recovery_required' : 'write_pending',
      'Accepted work must finish before connector retry approval.');
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
    const deadline = performance.now() + 5000;
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
  state<T>(empty: T): T { return structuredClone((this.checkpoint[0] as { state?: T } | undefined)?.state ?? empty); }
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
    const row = await this.submit('managed_connector_import', slug, sourcePath, { content });
    return { slug, chunks: Number(row.outcome?.chunks ?? 0), status: row.outcome?.noop ? 'skipped' : 'imported', created: row.outcome?.status === 'created' };
  }
  async delete(slug: string, sourcePath: string | null): Promise<boolean> {
    slug = slugifyPath(`${slug}.md`);
    const row = await this.submit('managed_connector_delete', slug, sourcePath, {});
    return row.outcome?.noop !== true;
  }
  async saveState(state: unknown, fresh = false, newestContentAt?: string): Promise<void> {
    const next = [{ generation: Number((this.checkpoint[0] as { generation?: number } | undefined)?.generation ?? 0) + 1, state: structuredClone(state) }];
    await this.submit('managed_connector_checkpoint', '__managed_connector_checkpoint__', null,
      { checkpointAfter: next, receipts: [...this.receipts], fresh, ...(newestContentAt ? { newestContentAt } : {}) });
    this.checkpoint = next;
    this.receipts = [];
  }
  private async submit(kind: ConnectorIntent['kind'], slug: string, sourcePath: string | null, extra: Partial<ConnectorIntent>): Promise<WriteRequest> {
    await this.recover(slug);
    const snapshot = await this.engine.readPageSnapshot(slug, { sourceId: this.sourceId, includeDeleted: true });
    const file = kind === 'managed_connector_checkpoint' ? undefined : await connectorFileTarget(this.engine,
      { source_id: this.sourceId, worktree_id: this.binding?.worktree_id ?? null, slug }, snapshot, extra.content ?? null, sourcePath, this.canonicalRoot);
    if (file && sourcePath && resolve(file.path) !== resolve(this.canonicalRoot!, sourcePath)) {
      throw new OperationError('source_changed', 'The connector source path no longer names its canonical file.');
    }
    const intent: ConnectorIntent = { kind, connector: this.connector, sourceRoot: this.source.local_path,
      configHash: digest(this.source.config), syncAuthority: this.authority, expected_revision: snapshot?.revision ?? null,
      sourcePath, noEmbed: this.noEmbed, noSchemaPack: this.noSchemaPack, checkpointKey: this.checkpointKey, checkpointBefore: this.checkpoint,
      ownerEpoch: this.binding ? String(this.binding.owner_epoch) : null, canonicalRoot: this.canonicalRoot,
      filePath: file?.path ?? null, fileBeforeHash: file?.expectedBeforeHash ?? null, ...extra };
    const callerIntent = { ...intent, syncAuthority: undefined, newestContentAt: undefined,
      ...(kind === 'managed_connector_checkpoint' ? { receipts: undefined } : {}) };
    const principal = this.authority.writer.principal;
    const baseRequestId = stableId({ principal, sourceId: this.sourceId, incarnation: this.source.incarnation, callerIntent });
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
      } else if (retry) throw new OperationError('storage_error', 'The approved connector retry receipt is unavailable.');
      return { retry, input, row };
    };
    const mayRetry = (row: WriteRequest | null) => this.retryFailed && row && ['failed', 'conflict'].includes(row.state) &&
      row.request_id === (this.retryApprovals.get(baseRequestId) ?? baseRequestId);
    const prior = await selected(this.engine);
    let row = prior.row;
    if (mayRetry(row)) {
      const lock = this.binding ? await acquireWorktree(this.binding, 1000) : null;
      try {
        if (this.binding && !lock) {
          await this.refuseRetryBlocker(this.engine);
          throw new OperationError('write_pending', 'The canonical owner is busy; retry approval has not changed.');
        }
        row = await this.engine.transaction(async tx => {
          if (this.binding) await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [this.binding.worktree_id]);
          await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [this.sourceId]);
          await this.validate(tx, slug);
          await authorizeWrite(tx, this.authority.writer, 'submit_job', slug, true);
          const current = await selected(tx);
          if (!current.row) throw new OperationError('storage_error', 'The failed connector receipt is unavailable.');
          await authorizeStoredRequest(tx, current.row, true);
          if (!mayRetry(current.row)) return current.row;
          await this.refuseRetryBlocker(tx);
          const [checkpoint] = await tx.executeRaw<{ completed_keys: unknown[] }>(
            "SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1 FOR UPDATE", [this.checkpointKey]);
          if (digest(checkpoint?.completed_keys ?? []) !== digest(this.checkpoint)) throw new OperationError('revision_conflict', 'The connector cursor changed before retry approval.');
          const attempt = (current.retry?.attempt ?? 0) + 1;
          const retry: ConnectorRetry = { checkpointKey: this.checkpointKey,
            principalId: principal.id, principalKind: principal.kind, baseRequestId, retryOf: current.row.request_id, attempt,
            requestId: stableId({ baseRequestId, retryOf: current.row.request_id, attempt }) };
          const accepted = await admitWriteInTransaction(tx, admission(retry));
          await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-connector-retry',$1,$2::text::jsonb)
            ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [baseRequestId, JSON.stringify([retry])]);
          return accepted;
        });
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw new OperationError('storage_error', 'Connector retry approval could not be confirmed.',
          'Repeat the same connector sync options; an admitted replacement keeps its existing request identity.');
      } finally { await lock?.release(); }
    } else if (!row) {
      row = await this.engine.transaction(async tx => {
        await this.assertLease(tx);
        return admitWriteInTransaction(tx, prior.input);
      });
    }
    row = await waitForWrite(this.engine, row!, loadConfig() ?? { engine: this.engine.kind });
    writeResponse(row);
    if (kind !== 'managed_connector_checkpoint') this.receipts.push(row.id);
    return row;
  }
}

export async function prepareConnectorMutation(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const p = row.intent as ConnectorIntent | null;
  if (!p || !['managed_connector_import', 'managed_connector_delete', 'managed_connector_checkpoint'].includes(p.kind) ||
      p.syncAuthority.writer.remote || p.syncAuthority.remoteJob) throw new OperationError('permission_denied', 'Unsupported connector authority.');
  if (!row.worktree_id && (row.authority.databaseOnlyReason !== 'connector_database' || p.syncAuthority.writer.databaseOnlyReason !== 'connector_database') ||
      row.worktree_id && (row.authority.databaseOnlyReason !== undefined || p.syncAuthority.writer.databaseOnlyReason !== undefined)) {
    throw new OperationError('permission_denied', 'Connector database-only authority does not match its binding.');
  }
  const validate = async (tx: BrainEngine) => {
    await validateSyncAuthority(tx, p.syncAuthority, row.slug);
    const [source] = await tx.executeRaw<ConnectorSource>('SELECT incarnation,archived,local_path,config FROM sources WHERE id=$1', [row.source_id]);
    if (!source || source.archived || source.incarnation !== row.source_incarnation || source.config.kind !== p.connector ||
        digest(source.config) !== p.configHash || source.local_path !== p.sourceRoot) throw new OperationError('source_changed', 'The connector configuration changed after admission.');
    const binding = await getWorktreeBinding(tx, row.source_id);
    if ((binding?.worktree_id ?? null) !== row.worktree_id || (binding ? String(binding.owner_epoch) : null) !== p.ownerEpoch) {
      throw new OperationError('source_changed', 'The connector ownership binding changed after admission.');
    }
    if (connectorBindingRoot(row.source_id, source, binding) !== p.canonicalRoot) throw new OperationError('source_changed', 'The connector canonical root changed after admission.');
    if (p.filePath !== null && (!p.canonicalRoot || !isWriteTargetContained(p.filePath, p.canonicalRoot) || persistenceFileHash(p.filePath) !== p.fileBeforeHash)) {
      throw new OperationError('source_changed', 'The connector canonical file changed after admission.');
    }
    if (p.kind !== 'managed_connector_checkpoint') {
      const [checkpoint] = await tx.executeRaw<{ completed_keys: unknown[] }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1", [p.checkpointKey]);
      if (digest(checkpoint?.completed_keys ?? []) !== digest(p.checkpointBefore)) throw new OperationError('revision_conflict', 'The connector checkpoint changed before publication.');
    }
  };
  await validate(engine);
  if (p.kind === 'managed_connector_checkpoint') return { observedRevision: null, sourceExclusive: true, validate, apply: async tx => {
    const [current] = await tx.executeRaw<{ completed_keys: unknown[] }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1 FOR UPDATE", [p.checkpointKey]);
    if (digest(current?.completed_keys ?? []) !== digest(p.checkpointBefore)) throw new OperationError('revision_conflict', 'The connector checkpoint changed during the sweep.');
    const receipts = p.receipts ?? [];
    const committed = await tx.executeRaw<{ id: string }>("SELECT id FROM persistence_requests WHERE id=ANY($1::uuid[]) AND source_id=$2 AND source_incarnation=$3::uuid AND state='committed'", [receipts, row.source_id, row.source_incarnation]);
    if (committed.length !== new Set(receipts).size) throw new OperationError('write_pending', 'A connector page receipt has not committed.');
    await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-connector',$1,$2::text::jsonb)
      ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [p.checkpointKey, JSON.stringify(p.checkpointAfter)]);
    if (p.fresh) await tx.executeRaw('UPDATE sources SET last_sync_at=now(),newest_content_at=COALESCE($3::timestamptz,newest_content_at) WHERE id=$1 AND incarnation=$2::uuid',
      [row.source_id, row.source_incarnation, p.newestContentAt ?? null]);
    return { status: 'checkpointed', source_id: row.source_id };
  } };
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  if ((snapshot?.revision ?? null) !== p.expected_revision || (snapshot?.page.id ?? null) !== row.page_id ||
      snapshot?.page.source_path != null && snapshot.page.source_path !== p.sourcePath) {
    throw new OperationError('revision_conflict', 'The connector page changed after admission.');
  }
  if (p.kind === 'managed_connector_delete') return { observedRevision: snapshot?.revision ?? null, sourceExclusive: true, validate,
    file: await prepareFileTarget(engine, row, snapshot, null),
    noop: !snapshot || snapshot.page.deleted_at != null, apply: async tx => {
      if (snapshot && snapshot.page.deleted_at == null) {
        await tx.createVersion(row.slug, { sourceId: row.source_id });
        await tx.softDeletePage(row.slug, { sourceId: row.source_id });
      }
      return { status: 'soft_deleted', slug: row.slug, source_id: row.source_id, noop: !snapshot || snapshot.page.deleted_at != null };
    } };
  if (!p.sourcePath || typeof p.content !== 'string' || slugifyPath(p.sourcePath) !== row.slug ||
      p.sourcePath.split('/').some(part => !part || part === '.' || part === '..') || p.sourcePath.includes('\\')) {
    throw new OperationError('invalid_params', 'The connector import path is invalid.');
  }
  const activePack = p.noSchemaPack ? undefined : (await loadActivePackForEngine(engine, { remote: false, sourceId: row.source_id }).catch(() => null))?.manifest;
  if (parseMarkdown(p.content, row.slug, { activePack }).slug !== row.slug) throw new OperationError('invalid_params', 'The connector content changes its page identity.');
  let prepared: PreparedContentImport | undefined;
  const result = await importFromContent(engine, row.slug, p.content, { sourceId: row.source_id, sourcePath: p.sourcePath,
    filename: basename(p.sourcePath).replace(/\.mdx?$/i, ''), noEmbed: true, allowEmptyOverwrite: true, activePack,
    prepareFrontmatter: page => {
      if (snapshot?.page.frontmatter.visibility === 'private') page.frontmatter.visibility = 'private';
    },
    prepare: async value => { prepared = value; return value.result; } });
  if (!prepared || prepared.slug !== row.slug) throw new OperationError('revision_conflict', result.error ?? 'A different page owns this connector content.');
  const ready = prepared;
  if (ready.observedRevision !== (snapshot?.revision ?? null)) throw new OperationError('revision_conflict', 'The connector page changed during preparation.');
  const project = prepareCanonicalProjections(ready.parsedPage, row.slug, row.source_id);
  const tags = [...new Set([...(snapshot?.tags ?? []), ...ready.parsedPage.tags])].sort();
  const page: Page = { ...(snapshot?.page ?? { id: 0, slug: row.slug, source_id: row.source_id, created_at: new Date(row.created_at), updated_at: new Date(row.created_at) }), ...ready.parsedPage };
  const file = await connectorFileTarget(engine, row, snapshot, serializePageToMarkdown(page, tags), p.sourcePath, p.canonicalRoot);
  if (file && (file.path !== p.filePath || file.expectedBeforeHash !== p.fileBeforeHash)) throw new OperationError('source_changed', 'The connector canonical file changed during preparation.');
  return { observedRevision: ready.observedRevision, sourceExclusive: true, validate, file, noop: ready.noop, deferEmbedding: p.noEmbed, apply: async tx => {
    await ready.apply(tx);
    if (!ready.noop) { await project(tx); await sealPageTextProjection(tx, row.slug, row.source_id); }
    return { status: ready.noop ? 'skipped' : snapshot ? 'updated' : 'created', slug: row.slug, source_id: row.source_id,
      chunks: result.chunks, noop: ready.noop, imported_file: true, connector_database: !row.worktree_id };
  } };
}

export function rethrowConnectorWriteError(error: unknown): void {
  if (error instanceof OperationError || error instanceof LockStolenError) throw error;
}
