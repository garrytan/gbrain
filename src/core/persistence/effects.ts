import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import type { GBrainConfig } from '../config.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { OperationError } from '../ops/contract.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { materializePageSnapshot } from '../page-state/materialize.ts';
import { installPageEmbeddings, readProjectionSnapshot } from '../page-state/projections.ts';
import { currentEmbeddingSignature, embedBatch } from '../embedding.ts';
import { assertEmbeddingEnabled, EmbeddingDisabledError } from '../embedding-dim-check.ts';
import { validateEmbeddingCreds, EmbeddingCredentialError } from '../embed-preflight.ts';
import { wrapChunkTextsForStoredMode } from '../embedding-context.ts';
import { isEmbedRetriableError, MAX_RATE_LIMIT_RETRIES, rateLimitDelayMs, restampIfDemotedToTitleTier, transientBackoffMs } from '../embed-retry.ts';
import { AIConfigError, normalizeAIError } from '../ai/errors.ts';
import { isAIInvocationPolicyError, withAIInvocationPreflight } from '../ai/invocation-guard.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { acquireWorktree, getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { persistenceFileHash, transientDatabaseFailure } from './coordinator.ts';
import { sha256 } from './digest.ts';
import { prepareFileTarget } from './page-prepare.ts';
import { advanceEffectCursor, claimPersistenceEffect, completeEffect, failEffect, renewPersistenceEffectClaim, retryEffect } from './effect-journal.ts';
import { guardEffectSource, recoverEffectPublication, reserveEffectRecovery } from './effect-recovery.ts';
import { publishGitEffect } from './effect-git.ts';
import { dispatchFactsBackstopEffect } from './effect-facts.ts';
import type { EffectRecovery, PersistenceEffect } from './effect-model.ts';
import { recoveryStagingFile } from './staging.ts';
import { selectEffectRecoveries } from './effect-recovery-scan.ts';
import { nativeFileTarget } from './native-file-target.ts';

export interface EffectWorkerOptions {
  hostId: string;
  limit?: number;
  signal?: AbortSignal;
  /** Failure boundary injection; production never supplies this. */
  boundary?: (name: 'before_mirror_file' | 'after_mirror_file' | 'before_mirror_commit') => Promise<void>;
  embedding?: { signature: string; model: string; embed: typeof embedBatch };
}

export async function selectedEffectPage(engine: BrainEngine, effect: PersistenceEffect): Promise<PageSnapshot | null> {
  let slug = effect.data.slug;
  if (effect.data.source_scan || effect.kind === 'withdrawal-mirror') {
    const [row] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND ($2::text IS NULL OR slug>$2) ORDER BY slug LIMIT 1',
      [effect.source_id, effect.data.after_slug ?? null]);
    slug = row?.slug;
  }
  if (!slug) return null;
  return engine.readPageSnapshot(slug, { sourceId: effect.source_id, includeDeleted: true });
}

async function finishPage(engine: BrainEngine, effect: PersistenceEffect, snapshot: PageSnapshot | null, outcome: Record<string, unknown> = {}): Promise<void> {
  if (snapshot && (effect.data.source_scan || effect.kind === 'withdrawal-mirror')) await advanceEffectCursor(engine, effect, snapshot.page.slug);
  else await completeEffect(engine, effect, outcome);
}

/** Missing physical files never prevent the authoritative withdrawal from materializing. */
async function materializeAndAdvance(engine: BrainEngine, effect: PersistenceEffect, snapshot: PageSnapshot, hostId: string): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    await guardEffectSource(tx, effect, hostId);
    await tx.lockPageKeys([{ sourceId: effect.source_id, slug: snapshot.page.slug }]);
    const current = await tx.readPageSnapshot(snapshot.page.slug, { sourceId: effect.source_id, includeDeleted: true });
    if (current?.revision !== snapshot.revision || current.page.id !== snapshot.page.id) throw new OperationError('revision_conflict', 'The withdrawal page changed during preparation.');
    await materializePageSnapshot(tx, current);
    await finishPage(tx, effect, current);
  });
}

async function mirrorPage(engine: BrainEngine, effect: PersistenceEffect, binding: WorktreeBinding | null, opts: EffectWorkerOptions): Promise<void> {
  const snapshot = await selectedEffectPage(engine, effect);
  if (!snapshot) { await completeEffect(engine, effect); return; }
  if (snapshot.sourceIncarnation !== effect.source_incarnation) throw new OperationError('source_changed', 'The mirror source was replaced.');
  const content = serializePageToMarkdown(snapshot.page, snapshot.tags);
  const file = binding?.local_path ? await prepareFileTarget(engine, { ...effect, slug: snapshot.page.slug }, snapshot, content, opts.hostId, { allowMissing: true }) : undefined;
  if (!file || snapshot.page.deleted_at || !existsSync(file.path)) {
    // A withdrawal cannot resurrect a deleted or missing physical page.
    await materializeAndAdvance(engine, effect, snapshot, opts.hostId);
    return;
  }
  const after = Buffer.from(content);
  const record: EffectRecovery = { version: 1, kind: 'withdrawal-mirror', path: file.path, root: file.root,
    beforeHash: file.expectedBeforeHash ?? null, afterHash: sha256(after), after: after.toString('base64'),
    mode: statSync(file.path).mode & 0o7777, ownerEpoch: String(binding!.owner_epoch), pageId: snapshot.page.id,
    sourceIncarnation: snapshot.sourceIncarnation, slug: snapshot.page.slug, revision: snapshot.revision,
    staging: { publication: recoveryStagingFile(file.path, after) } };
  await reserveEffectRecovery(engine, effect, record, Buffer.byteLength(JSON.stringify(record)) * 2 + 4096, opts.hostId);
  await recoverEffectPublication(engine, effect, opts.hostId, opts);
}

async function gitPage(engine: BrainEngine, effect: PersistenceEffect, binding: WorktreeBinding | null, opts: EffectWorkerOptions): Promise<void> {
  if (!binding?.local_path) { await completeEffect(engine, effect, { git: 'skipped', reason: 'no_repo_configured' }); return; }
  const snapshot = await selectedEffectPage(engine, effect);
  let path: string;
  if (effect.data.source_scan) {
    if (!snapshot) { await completeEffect(engine, effect); return; }
    const file = await prepareFileTarget(engine, { ...effect, slug: snapshot.page.slug }, snapshot,
      snapshot.page.deleted_at ? null : serializePageToMarkdown(snapshot.page, snapshot.tags), opts.hostId, { allowMissing: true });
    if (!file) throw new OperationError('source_changed', 'The Git binding changed.');
    path = file.path;
    if (!existsSync(path)) { await materializeAndAdvance(engine, effect, snapshot, opts.hostId); return; }
    if (snapshot.page.deleted_at && existsSync(path)) { await finishPage(engine, effect, snapshot, { reason: 'deleted_page_file_present' }); return; }
  } else {
    if (!effect.data.relative_path) throw new OperationError('storage_error', 'The Git effect lost its target.');
    path = join(binding.local_path, effect.data.relative_path);
    if (!isWriteTargetContained(path, join(binding.local_path, binding.relative_path))) throw new OperationError('source_changed', 'The Git target escaped its registered source.');
    path = nativeFileTarget(binding.local_path, path, 'git_target_unsafe');
    if (persistenceFileHash(path) !== effect.data.expected_hash) { await completeEffect(engine, effect, { git: 'superseded' }); return; }
  }
  if (!isWriteTargetContained(path, join(binding.local_path, binding.relative_path))) throw new OperationError('source_changed', 'The Git target escaped its registered source.');
  const result = await publishGitEffect(binding.local_path, relative(binding.local_path, path).split(sep).join('/'), opts.signal);
  if (result.reason === 'durability_not_enabled') await completeEffect(engine, effect, result);
  else await finishPage(engine, effect, snapshot, result);
}

export async function readEmbeddingEffectProjection(engine: BrainEngine, effect: PersistenceEffect, snapshot: PageSnapshot,
  hostId: string, signature: string, model?: string) {
  return engine.transaction(async tx => {
    await guardEffectSource(tx, effect, hostId);
    const prepared = await readProjectionSnapshot(tx, snapshot.page.slug, effect.source_id);
    if (!prepared || prepared.snapshot.revision !== snapshot.revision || prepared.snapshot.page.id !== snapshot.page.id) {
      throw new OperationError('projection_pending', 'The current text projection is not ready.');
    }
    const column = prepared.embeddingColumn;
    const completion = await tx.executeRaw<{ id: number; complete: boolean }>(`SELECT cc.id,
      p.embedding_signature=$2 AND cc.${quoteIdentifier(column.name)} IS NOT NULL AND cc.embedded_at IS NOT NULL
        AND cc.embedded_text_hash=md5(cc.chunk_text) AND cc.model IS NOT DISTINCT FROM $3 AS complete
      FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.id=$1`,
    [snapshot.page.id, signature, model ?? (column.name === 'embedding' ? signature.slice(0, signature.lastIndexOf(':')) : column.embeddingModel)]);
    const complete = new Set(completion.filter(chunk => chunk.complete === true).map(chunk => chunk.id));
    const pending = prepared.chunks.filter(chunk => !complete.has(chunk.id));
    return { prepared, pending: pending.length && prepared.snapshot.page.contextual_retrieval_mode === 'per_chunk_synopsis' ? prepared.chunks : pending };
  });
}

async function embedPage(engine: BrainEngine, config: GBrainConfig, effect: PersistenceEffect, opts: EffectWorkerOptions): Promise<void> {
  const snapshot = await selectedEffectPage(engine, effect);
  if (!snapshot || snapshot.page.deleted_at) { await finishPage(engine, effect, snapshot); return; }
  if (!effect.data.source_scan && (snapshot.revision !== effect.revision || snapshot.page.id !== effect.data.page_id)) {
    await completeEffect(engine, effect, { embedding: 'superseded', reason: 'revision_changed' }); return;
  }
  const signature = opts.embedding?.signature ?? currentEmbeddingSignature();
  if (!signature) throw new OperationError('embedding_unconfigured', 'Configure an embedding provider before explicitly retrying.');
  const { prepared, pending } = await readEmbeddingEffectProjection(engine, effect, snapshot, opts.hostId, signature, opts.embedding?.model);
  if (pending.length) {
    await assertEmbeddingEffectEnabled(engine, config);
    if (effect.attempts - (effect.data.embedding_retry_base ?? effect.data.embedding_attempt_base ?? 0) > MAX_RATE_LIMIT_RETRIES) {
      await failEffect(engine, effect, 'embedding_attempts_exhausted'); return;
    }
    if (!opts.embedding) validateEmbeddingCreds();
    opts.signal?.throwIfAborted();
    const lease = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, lease.signal]) : lease.signal;
    let renewing: Promise<void> | undefined;
    const renew = () => renewPersistenceEffectClaim({ executeRaw: engine.executeRawDirect.bind(engine) }, effect).then(live => {
      if (!live) lease.abort(new OperationError('write_claim_lost', 'The embedding claim changed.'));
    }).catch(error => { lease.abort(embeddingStorageFailure(error)); });
    const interval = setInterval(() => {
      if (!renewing && !signal.aborted) renewing = renew().finally(() => { renewing = undefined; });
    }, 10_000);
    interval.unref?.();
    let vectors: Float32Array[];
    try {
      await renew();
      signal.throwIfAborted();
      vectors = await withAIInvocationPreflight(async () => {
        signal.throwIfAborted();
        await renew();
        signal.throwIfAborted();
        await assertEmbeddingEffectEnabled(engine, config);
      }, () => (opts.embedding?.embed ?? embedBatch)(wrapChunkTextsForStoredMode(prepared.snapshot.page, pending), { abortSignal: signal, maxRetries: 0 }));
    } finally {
      clearInterval(interval);
      await renewing;
    }
    signal.throwIfAborted();
    if (vectors.length !== pending.length || pending.some((_, index) => !vectors[index]?.length)) {
      throw new OperationError('embedding_unavailable', 'The provider returned an incomplete embedding batch.');
    }
    const installed = await engine.transaction(async tx => {
      await guardEffectSource(tx, effect, opts.hostId);
      const [claim] = await tx.executeRaw<PersistenceEffect>('SELECT state,execution_token FROM persistence_effects WHERE id=$1 FOR UPDATE', [effect.id]);
      if (claim?.state !== 'running' || claim.execution_token !== effect.execution_token) throw new OperationError('write_claim_lost', 'The embedding claim changed.');
      await tx.executeRaw("SELECT key FROM config WHERE key='embedding_disabled' FOR SHARE");
      await assertEmbeddingEffectEnabled(tx, config);
      signal.throwIfAborted();
      const installed = await installPageEmbeddings(tx, prepared, pending.map((chunk, i) => ({ chunk_index: chunk.chunk_index,
        chunk_text: chunk.chunk_text, chunk_source: chunk.chunk_source, embedding: vectors[i], model: opts.embedding?.model })), signature);
      if (installed) await restampIfDemotedToTitleTier(tx, prepared.snapshot.page, snapshot.page.slug, effect.source_id);
      signal.throwIfAborted();
      if (installed) await finishPage(tx, effect, snapshot);
      return installed;
    });
    if (!installed) {
      if (effect.data.source_scan) throw new OperationError('revision_conflict', 'The page changed while embedding.');
      await completeEffect(engine, effect, { embedding: 'superseded', reason: 'revision_changed' }); return;
    }
    return;
  }
  await finishPage(engine, effect, snapshot);
}

export async function assertEmbeddingEffectEnabled(engine: BrainEngine, config: GBrainConfig | null): Promise<void> {
  assertEmbeddingEnabled(config);
  const disabled = await engine.getConfig('embedding_disabled').catch(error => { throw embeddingStorageFailure(error); });
  if (disabled !== null && disabled !== 'true' && disabled !== 'false') {
    throw new OperationError('embedding_configuration', 'Selected brain embedding_disabled must be true or false.');
  }
  assertEmbeddingEnabled({ embedding_disabled: disabled === 'true' });
}

function embeddingStorageFailure(error: unknown): unknown {
  return transientDatabaseFailure(error)
    ? new OperationError('embedding_storage_unavailable', 'Embedding policy or claim storage is temporarily unavailable.') : error;
}

async function recordFailure(engine: BrainEngine, effect: PersistenceEffect, error: unknown, signal?: AbortSignal): Promise<void> {
  const code = error instanceof OperationError ? error.code : 'effect_unavailable';
  // Source replacement is final only without recovery. Unknown physical bytes
  // retain their record and continue to block this root for explicit repair.
  if (code === 'source_changed' && !effect.recovery) {
    const [current] = await engine.executeRaw<{ recovering: boolean }>('SELECT recovery IS NOT NULL AS recovering FROM persistence_effects WHERE id=$1', [effect.id]);
    const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [effect.source_id]);
    if (!current?.recovering && (!source || source.archived || source.incarnation !== effect.source_incarnation)) { await failEffect(engine, effect, code); return; }
  }
  if (effect.kind === 'embedding') {
    if (error instanceof EmbeddingDisabledError || error instanceof EmbeddingCredentialError || code === 'embedding_unconfigured') {
      await completeEffect(engine, effect, { embedding: 'skipped', reason: error instanceof EmbeddingDisabledError ? 'embedding_disabled' : 'embedding_unconfigured' }); return;
    }
    if (code === 'embedding_configuration') {
      await failEffect(engine, effect, 'embedding_configuration'); return;
    }
    if ((code !== 'embedding_storage_unavailable' && isAIInvocationPolicyError(error)) || (error as { tag?: string } | null)?.tag === 'BUDGET_EXHAUSTED') {
      await failEffect(engine, effect, 'embedding_budget_refused'); return;
    }
    if (!signal?.aborted && normalizeAIError(error) instanceof AIConfigError) {
      await failEffect(engine, effect, 'embedding_configuration'); return;
    }
    const attempt = effect.attempts - (effect.data.embedding_retry_base ?? effect.data.embedding_attempt_base ?? 0);
    if (attempt >= MAX_RATE_LIMIT_RETRIES) {
      await failEffect(engine, effect, 'embedding_attempts_exhausted'); return;
    }
    const reason = signal?.aborted ? 'embedding_aborted' : code;
    const delay = isEmbedRetriableError(error) ? rateLimitDelayMs(error instanceof Error ? error.message : '', attempt - 1)
      : transientBackoffMs(attempt - 1);
    await retryEffect(engine, effect, reason, delay); return;
  }
  await retryEffect(engine, effect, code, ['projection_pending', 'revision_conflict', 'writer_busy', 'writer_pool_capacity'].includes(code) ? 250 : 30_000);
}

/** Bounded, idempotent work. Recovery obtains kernel exclusion before a DB claim. */
export async function runPersistenceEffects(engine: BrainEngine, config: GBrainConfig, opts: EffectWorkerOptions): Promise<void> {
  const limit = Math.max(1, Math.min(opts.limit ?? 2, 20));
  const recoveries = await selectEffectRecoveries(engine, opts.hostId, limit);
  let attempted = 0;
  for (const recovery of recoveries) {
    if (opts.signal?.aborted) return;
    const binding = await getWorktreeBinding(engine, recovery.source_id, opts.hostId);
    if (!binding) continue;
    const lock = await acquireWorktree(binding);
    if (!lock) continue;
    let claimed: PersistenceEffect | undefined;
    try {
      // Any old process holding this native lock has exited. No lease timeout
      // can provide that proof and no second process can steal this claim now.
      [claimed] = await engine.executeRaw<PersistenceEffect>(`UPDATE persistence_effects SET state='running',execution_token=$2::uuid,
        claim_expires_at=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() WHERE id=$1 AND recovery IS NOT NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING *`, [recovery.id, randomUUID()]);
      if (claimed) { attempted++; await recoverEffectPublication(engine, claimed, opts.hostId, opts); }
    } catch (error) { if (claimed) await recordFailure(engine, claimed, error); }
    finally { await lock.release(); }
  }
  while (attempted++ < limit && !opts.signal?.aborted) {
    const effect = await claimPersistenceEffect(engine, opts.hostId);
    if (!effect) return;
    let lock: Awaited<ReturnType<typeof acquireWorktree>> = null;
    try {
      const binding = effect.worktree_id ? await getWorktreeBinding(engine, effect.source_id, opts.hostId) : null;
      if (effect.worktree_id && !['embedding', 'facts-backstop'].includes(effect.kind)) {
        if (!binding) throw new OperationError('owner_unavailable', 'The canonical effect owner is unavailable.');
        lock = await acquireWorktree(binding);
        if (!lock) throw new OperationError('writer_busy', 'The canonical worktree is busy.');
      }
      await engine.transaction(async tx => {
        await guardEffectSource(tx, effect, opts.hostId);
        if (effect.worktree_id) {
          const blocked = await tx.executeRaw('SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1', [effect.worktree_id]);
          if (blocked.length) throw new OperationError('recovery_required', 'Canonical publication recovery must finish first.');
        }
      });
      if (effect.kind === 'withdrawal-mirror') await mirrorPage(engine, effect, binding, opts);
      else if (effect.kind === 'git') await gitPage(engine, effect, binding, opts);
      else if (effect.kind === 'facts-backstop') await dispatchFactsBackstopEffect(engine, effect, opts.hostId);
      else await embedPage(engine, config, effect, opts);
    } catch (error) { await recordFailure(engine, effect, error, opts.signal); }
    finally { await lock?.release(); }
  }
}
