import { withAIAttribution } from '../ai/invocation-guard.ts';
import { randomUUID } from 'node:crypto';
import { targetedWithdrawalEffect, upgradeWithdrawalEffect } from './effect-targets.ts';
import { existsSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import type { GBrainConfig } from '../config.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
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
import { EMBEDDING_ZERO_NORM, isEmbeddingZeroNormError, type EmbeddingZeroNormError } from '../ai/embedding-guard.ts';
import { isAIInvocationPolicyError, withAIInvocationPreflight } from '../ai/invocation-guard.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { acquireWorktree, getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { persistenceFileHash, transientDatabaseFailure } from './coordinator.ts';
import { sha256 } from './digest.ts';
import { prepareFileTarget } from './page-prepare.ts';
import { isSourceDbOnlySlug } from './source-storage.ts';
import { advanceEffectCursor, claimCoalescedGitEffects, claimPersistenceEffect, completeEffect, failEffect, parkEffect, renewPersistenceEffectClaim, requeueEffect, retryEffect, singleFileGitEffect } from './effect-journal.ts';
import { guardEffectSource, recoverEffectPublication, reserveEffectRecovery } from './effect-recovery.ts';
import { commitGitTargets, publishGitEffect, pushGitRoot } from './effect-git.ts';
import { isDurabilityHardenedAsync } from '../brain-repo-durability.ts';
import { dispatchFactsBackstopEffect } from './effect-facts.ts';
import { runLinksEffect } from './effect-links.ts';
import { PARK_AFTER_FAILURES, type EffectRecovery, type PersistenceEffect, type SkippedTarget } from './effect-model.ts';
import { SYNC_SKIP_FILES } from '../sync.ts';
import { recoveryStagingFile } from './staging.ts';
import { selectEffectRecoveries } from './effect-recovery-scan.ts';
import { nativeFileTarget } from './native-file-target.ts';
import { sourceMirrorReadOnly } from './mirror-read-only.ts';

const effectStatusFix = (effect: Pick<PersistenceEffect, 'source_id'>): Action => readFix(
  `Shows source ${effect.source_id}'s canonical owner with its blocking, retrying and parked effects, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', effect.source_id, '--json'] });
const embeddingsFix = (): Action => readFix('Reports whether this brain has a usable embedding provider, model and dimensions, read-only.',
  { argv: ['gbrain', 'doctor', '--only', 'embeddings', '--json'] });
const writerBusy = (effect: Pick<PersistenceEffect, 'source_id'>) => opError('writer_busy', 'The canonical worktree is busy.',
  `Another write holds source ${effect.source_id}'s canonical worktree. The committed write is unaffected and the effect worker tries this effect again shortly; nothing needs resubmitting.`,
  { fix: effectStatusFix(effect) });
const recoveryFirst = (effect: Pick<PersistenceEffect, 'source_id'>) => opError('recovery_required', 'Canonical publication recovery must finish first.',
  `An earlier publication in source ${effect.source_id}'s worktree is still being recovered, so this effect waits; the worker resumes it once recovery completes. Inspect the owner rather than resubmitting writes.`,
  { fix: effectStatusFix(effect) });
const gitTargetEscaped = (effect: Pick<PersistenceEffect, 'source_id'>) => opError('source_changed', 'The Git target escaped its registered source.',
  `The effect's file path resolves outside source ${effect.source_id}'s registered root (a symlink or a moved checkout), so nothing was committed for it. Inspect the owner; the user decides how to repair the checkout.`,
  { fix: effectStatusFix(effect) });

export interface EffectWorkerOptions {
  hostId: string;
  limit?: number;
  signal?: AbortSignal;
  /** Failure boundary injection; production never supplies this. */
  boundary?: (name: 'before_mirror_file' | 'after_mirror_file' | 'before_mirror_commit') => Promise<void>;
  embedding?: { signature: string; model: string; embed: typeof embedBatch };
}

export async function selectedEffectPage(engine: BrainEngine, effect: PersistenceEffect): Promise<PageSnapshot | null> {
  for (const slug of effect.data.retry_slugs ?? []) {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: effect.source_id, includeDeleted: true });
    if (snapshot?.sourceIncarnation !== effect.source_incarnation) continue;
    if (targetedWithdrawalEffect(effect) && effect.data.targets!.find(target => target.slug === slug)?.page_id !== snapshot.page.id) continue;
    return snapshot;
  }
  if (targetedWithdrawalEffect(effect)) {
    for (const target of effect.data.targets!) {
      if (effect.data.after_slug !== undefined && target.slug <= effect.data.after_slug) continue;
      const snapshot = await engine.readPageSnapshot(target.slug, { sourceId: effect.source_id, includeDeleted: true });
      if (snapshot?.page.id !== target.page_id || snapshot.sourceIncarnation !== effect.source_incarnation) continue;
      if (effect.kind === 'embedding' && (snapshot.page.deleted_at || snapshot.revision !== target.revision)) continue;
      return snapshot;
    }
    return null;
  }
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
  if (snapshot && (targetedWithdrawalEffect(effect) || effect.data.source_scan || effect.kind === 'withdrawal-mirror')) await advanceEffectCursor(engine, effect, snapshot.page.slug);
  else await completeEffect(engine, effect, outcome);
}

/** Missing physical files never prevent the authoritative withdrawal from materializing. */
async function materializeAndAdvance(engine: BrainEngine, effect: PersistenceEffect, snapshot: PageSnapshot, hostId: string,
  skipped?: SkippedTarget['reason']): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    await guardEffectSource(tx, effect, hostId);
    await tx.lockPageKeys([{ sourceId: effect.source_id, slug: snapshot.page.slug }]);
    const current = await tx.readPageSnapshot(snapshot.page.slug, { sourceId: effect.source_id, includeDeleted: true });
    if (current?.revision !== snapshot.revision || current.page.id !== snapshot.page.id) throw opError('revision_conflict', 'The withdrawal page changed during preparation.',
      `Page ${snapshot.page.slug} in source ${effect.source_id} changed while its withdrawal was materializing; the effect worker picks up the new revision on its next pass. Nothing needs resubmitting.`,
      { fix: effectStatusFix(effect) });
    await materializePageSnapshot(tx, current);
    if (skipped) await recordSkippedTarget(tx, effect, { slug: current.page.slug, reason: skipped });
    await finishPage(tx, effect, current);
  });
}

/** At most this many skipped scan targets are recorded on one effect. */
const SKIPPED_TARGET_LIMIT = 100;
/** An embedding claim renews this often while the provider works; the claim lease is 2 minutes. */
export const EFFECT_RENEWAL_INTERVAL_MS = 10_000;
let effectRenewalIntervalMs = EFFECT_RENEWAL_INTERVAL_MS;
/** Test seam: replace the embedding-claim renewal interval (null restores it); returns the restore function. */
export function __setEffectRenewalIntervalForTests(ms: number | null): () => void {
  const previous = effectRenewalIntervalMs;
  effectRenewalIntervalMs = ms ?? EFFECT_RENEWAL_INTERVAL_MS;
  return () => { effectRenewalIntervalMs = previous; };
}
/** The renewal interval in effect (production: EFFECT_RENEWAL_INTERVAL_MS). */
export function effectRenewalInterval(): number { return effectRenewalIntervalMs; }

async function recordSkippedTarget(engine: BrainEngine, effect: PersistenceEffect, target: SkippedTarget): Promise<void> {
  await engine.executeRaw(`UPDATE persistence_effects SET data=jsonb_set(data,'{skipped}',COALESCE(data->'skipped','[]'::jsonb)||$3::text::jsonb)
    WHERE id=$1 AND execution_token=$2::uuid AND jsonb_array_length(COALESCE(data->'skipped','[]'::jsonb))<$4`,
  [effect.id, effect.execution_token, JSON.stringify([target]), SKIPPED_TARGET_LIMIT]);
}

/**
 * #5396: sync never imports a metafile (RESOLVER.md carries the managed durability block by design),
 * so its legacy page and file diverge; a scan never publishes either one to the other.
 */
function isMetafilePage(snapshot: PageSnapshot): boolean {
  return !!snapshot.page.source_path && (SYNC_SKIP_FILES as readonly string[]).includes(basename(snapshot.page.source_path));
}

function isFileDatabaseDrift(error: unknown): boolean {
  return error instanceof OperationError && error.code === 'source_changed' && error.detail === 'file_database_drift';
}

/** The target a failing attempt was working on; unset means the failure is effect-wide. */
interface EffectAttempt { target?: string }

async function mirrorPage(engine: BrainEngine, effect: PersistenceEffect, binding: WorktreeBinding | null, opts: EffectWorkerOptions, attempt: EffectAttempt): Promise<void> {
  const snapshot = await selectedEffectPage(engine, effect);
  if (!snapshot) { await completeEffect(engine, effect); return; }
  attempt.target = snapshot.page.slug;
  if (snapshot.sourceIncarnation !== effect.source_incarnation) throw opError('source_changed', 'The mirror source was replaced.',
    `Source ${effect.source_id} was replaced after this withdrawal mirror was queued, so the effect ends without writing; the new source has its own effects. Check the owner if files still look stale.`,
    { fix: effectStatusFix(effect) });
  if (isMetafilePage(snapshot)) { await materializeAndAdvance(engine, effect, snapshot, opts.hostId, 'metafile'); return; }
  const content = serializePageToMarkdown(snapshot.page, snapshot.tags);
  let file: Awaited<ReturnType<typeof prepareFileTarget>>;
  try {
    file = binding?.local_path ? await prepareFileTarget(engine, { ...effect, slug: snapshot.page.slug }, snapshot, content, opts.hostId, { allowMissing: true }) : undefined;
  } catch (error) {
    if (!isFileDatabaseDrift(error)) throw error;
    await materializeAndAdvance(engine, effect, snapshot, opts.hostId, 'file_database_drift');
    return;
  }
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

/**
 * Validate a single-file Git effect's recorded target. Returns the target's
 * path relative to the worktree root, or null after completing an effect
 * that has nothing to commit (superseded bytes or db_only content).
 */
async function singleFileGitTarget(engine: BrainEngine, effect: PersistenceEffect, binding: WorktreeBinding & { local_path: string },
  attempt: EffectAttempt): Promise<string | null> {
  if (!effect.data.relative_path) throw opError('storage_error', 'The Git effect lost its target.',
    `The Git effect queued by request ${effect.request_id} in source ${effect.source_id} has no recorded file path, so nothing was committed to Git; the page write itself is committed. Inspect the owner's effects before resubmitting anything.`,
    { fix: effectStatusFix(effect) });
  attempt.target = effect.data.slug ?? effect.data.relative_path;
  const sourceRoot = join(binding.local_path, binding.relative_path);
  let path = join(binding.local_path, effect.data.relative_path);
  if (!isWriteTargetContained(path, sourceRoot)) throw gitTargetEscaped(effect);
  path = nativeFileTarget(binding.local_path, path, 'git_target_unsafe');
  if (persistenceFileHash(path) !== effect.data.expected_hash) { await completeEffect(engine, effect, { git: 'superseded' }); return null; }
  if (!isWriteTargetContained(path, sourceRoot)) throw gitTargetEscaped(effect);
  // Declared db_only content stays out of Git. Its gitignored local cache file
  // is invisible to `git status`, so publishing it would be refused as unsafe.
  // An invalid gbrain.yml (logged by the loader) publishes as before.
  if (effect.data.slug && isSourceDbOnlySlug(sourceRoot, effect.data.slug, 'not_db_only')) {
    await completeEffect(engine, effect, { git: 'skipped', reason: 'db_only' });
    return null;
  }
  return relative(binding.local_path, path).split(sep).join('/');
}

async function gitPage(engine: BrainEngine, effect: PersistenceEffect, binding: WorktreeBinding | null, opts: EffectWorkerOptions,
  attempt: EffectAttempt, hardened: boolean | undefined): Promise<void> {
  if (!binding?.local_path) { await completeEffect(engine, effect, { git: 'skipped', reason: 'no_repo_configured' }); return; }
  // #5409: a read-only mirror's checkout is never committed to; its publications wrote no file.
  if (await sourceMirrorReadOnly(engine, effect.source_id)) { await completeEffect(engine, effect, { git: 'skipped', reason: 'mirror_read_only' }); return; }
  const root = binding.local_path;
  if (!targetedWithdrawalEffect(effect) && !effect.data.source_scan) {
    const target = await singleFileGitTarget(engine, effect, { ...binding, local_path: root }, attempt);
    if (target !== null) await completeEffect(engine, effect, await publishGitEffect(root, target, opts.signal, hardened));
    return;
  }
  // Only a page walk reads snapshots; a single-file effect completes by its recorded hash.
  const snapshot = await selectedEffectPage(engine, effect);
  if (!snapshot) { await completeEffect(engine, effect); return; }
  attempt.target = snapshot.page.slug;
  const skip = async (reason: SkippedTarget['reason']) => engine.transaction(async tx => {
    await recordSkippedTarget(tx, effect, { slug: snapshot.page.slug, reason });
    await finishPage(tx, effect, snapshot);
  });
  if (isMetafilePage(snapshot)) { await skip('metafile'); return; }
  let file: Awaited<ReturnType<typeof prepareFileTarget>>;
  try {
    file = await prepareFileTarget(engine, { ...effect, slug: snapshot.page.slug }, snapshot,
      snapshot.page.deleted_at ? null : serializePageToMarkdown(snapshot.page, snapshot.tags), opts.hostId, { allowMissing: true });
  } catch (error) {
    if (!isFileDatabaseDrift(error)) throw error;
    await skip('file_database_drift');
    return;
  }
  if (!file) throw opError('source_changed', 'The Git binding changed.',
    `Source ${effect.source_id} lost or changed its canonical checkout while this Git effect ran, so page ${snapshot.page.slug} was not committed. Check the owner; the effect resumes once the binding is active again.`,
    { fix: effectStatusFix(effect) });
  const path = file.path;
  if (!existsSync(path)) { await materializeAndAdvance(engine, effect, snapshot, opts.hostId); return; }
  if (snapshot.page.deleted_at && existsSync(path)) { await finishPage(engine, effect, snapshot, { reason: 'deleted_page_file_present' }); return; }
  if (!isWriteTargetContained(path, join(root, binding.relative_path))) throw gitTargetEscaped(effect);
  if (isSourceDbOnlySlug(join(root, binding.relative_path), snapshot.page.slug, 'not_db_only')) {
    await finishPage(engine, effect, snapshot, { git: 'skipped', reason: 'db_only' });
    return;
  }
  const result = await publishGitEffect(root, relative(root, path).split(sep).join('/'), opts.signal, hardened);
  if (result.reason === 'durability_not_enabled') await completeEffect(engine, effect, result);
  else await finishPage(engine, effect, snapshot, result);
}

export async function readEmbeddingEffectProjection(engine: BrainEngine, effect: PersistenceEffect, snapshot: PageSnapshot,
  hostId: string, signature: string, model?: string) {
  return engine.transaction(async tx => {
    await guardEffectSource(tx, effect, hostId);
    const prepared = await readProjectionSnapshot(tx, snapshot.page.slug, effect.source_id);
    if (!prepared || prepared.snapshot.revision !== snapshot.revision || prepared.snapshot.page.id !== snapshot.page.id) {
      throw opError('projection_pending', 'The current text projection is not ready.',
        `Page ${snapshot.page.slug} in source ${effect.source_id} has no current text chunks for revision ${snapshot.revision} yet; the effect worker embeds it once the projection lands. Nothing needs resubmitting.`,
        { fix: effectStatusFix(effect) });
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
  if (!targetedWithdrawalEffect(effect) && !effect.data.source_scan && (snapshot.revision !== effect.revision || snapshot.page.id !== effect.data.page_id)) {
    await completeEffect(engine, effect, { embedding: 'superseded', reason: 'revision_changed' }); return;
  }
  const signature = opts.embedding?.signature ?? currentEmbeddingSignature();
  if (!signature) throw opError('embedding_unconfigured', 'Configure an embedding provider before explicitly retrying.',
    `Page ${snapshot.page.slug} in source ${effect.source_id} was saved but cannot be embedded: this brain has no embedding provider. Pages and keyword search keep working; check embedding readiness and ask the user before configuring a paid provider.`,
    { fix: embeddingsFix() });
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
      if (!live) lease.abort(opError('write_claim_lost', 'The embedding claim changed.',
        `Another worker took over the embedding of ${snapshot.page.slug} in source ${effect.source_id}; this attempt stops without installing vectors and the owning claim finishes it.`,
        { fix: effectStatusFix(effect) }));
    }).catch(error => { lease.abort(embeddingStorageFailure(error)); });
    const interval = setInterval(() => {
      if (!renewing && !signal.aborted) renewing = renew().finally(() => { renewing = undefined; });
    }, effectRenewalIntervalMs);
    interval.unref?.();
    let vectors: (Float32Array | null)[];
    // #4616: a degenerate vector refuses only its own chunk; the usable vectors still install.
    let refused: EmbeddingZeroNormError | undefined;
    try {
      await renew();
      signal.throwIfAborted();
      vectors = await withAIInvocationPreflight(async () => {
        signal.throwIfAborted();
        await renew();
        signal.throwIfAborted();
        await assertEmbeddingEffectEnabled(engine, config);
      }, () => (opts.embedding?.embed ?? embedBatch)(wrapChunkTextsForStoredMode(prepared.snapshot.page, pending), { abortSignal: signal, maxRetries: 0 }));
    } catch (error) {
      if (!isEmbeddingZeroNormError(error) || error.vectors.length !== pending.length) throw error;
      refused = error;
      vectors = error.vectors;
    } finally {
      clearInterval(interval);
      await renewing;
    }
    signal.throwIfAborted();
    if (vectors.length !== pending.length || pending.some((_, index) => !vectors[index]?.length && !refused?.failures.some(f => f.index === index))) {
      throw opError('embedding_unavailable', 'The provider returned an incomplete embedding batch.',
        `No vectors were installed for ${snapshot.page.slug} in source ${effect.source_id}; the effect worker tries again with backoff up to its attempt limit. If it keeps failing, check the embedding provider.`,
        { fix: embeddingsFix() });
    }
    const installed = await engine.transaction(async tx => {
      await guardEffectSource(tx, effect, opts.hostId);
      const [claim] = await tx.executeRaw<PersistenceEffect>('SELECT state,execution_token FROM persistence_effects WHERE id=$1 FOR UPDATE', [effect.id]);
      if (claim?.state !== 'running' || claim.execution_token !== effect.execution_token) throw opError('write_claim_lost', 'The embedding claim changed.',
        `Another worker took over the embedding of ${snapshot.page.slug} in source ${effect.source_id}; this attempt installed nothing and the owning claim finishes it.`,
        { fix: effectStatusFix(effect) });
      await tx.executeRaw("SELECT key FROM config WHERE key='embedding_disabled' FOR SHARE");
      await assertEmbeddingEffectEnabled(tx, config);
      signal.throwIfAborted();
      // A partially refused page keeps its signature unstamped so `gbrain embed --stale` finds the refused chunks.
      const installed = await installPageEmbeddings(tx, prepared, pending.map((chunk, i) => ({ chunk_index: chunk.chunk_index,
        chunk_text: chunk.chunk_text, chunk_source: chunk.chunk_source, embedding: vectors[i] ?? undefined, model: opts.embedding?.model })),
      refused ? undefined : signature);
      if (installed && refused) {
        // A refused chunk keeps no vector from an earlier convention, and the page reads as not fully embedded.
        const ids = refused.failures.map(f => pending[f.index]?.id).filter((id): id is number => id !== undefined);
        await tx.executeRaw(`UPDATE content_chunks SET ${quoteIdentifier(prepared.embeddingColumn.name)}=NULL,embedded_at=NULL,
          embedded_text_hash=NULL,embedding_input_hash=NULL WHERE page_id=$1 AND id=ANY($2::int[])`, [prepared.snapshot.page.id, ids]);
        await tx.executeRaw('UPDATE pages SET embedding_signature=NULL WHERE id=$1', [prepared.snapshot.page.id]);
      }
      if (installed && !refused) await restampIfDemotedToTitleTier(tx, prepared.snapshot.page, snapshot.page.slug, effect.source_id);
      signal.throwIfAborted();
      if (installed && !refused) await finishPage(tx, effect, snapshot);
      return installed;
    });
    if (installed && refused) {
      // Terminal, never retried: the same input would return the same vector. A scan moves on to its next
      // page; the page keeps no signature, so `gbrain embed --stale` finds it.
      if (targetedWithdrawalEffect(effect) || effect.data.source_scan) await finishPage(engine, effect, snapshot);
      else await failEffect(engine, effect, EMBEDDING_ZERO_NORM);
      return;
    }
    if (!installed) {
      if (targetedWithdrawalEffect(effect) || effect.data.source_scan) throw opError('revision_conflict', 'The page changed while embedding.',
        `Page ${snapshot.page.slug} in source ${effect.source_id} changed while its vectors were computed, so none were installed; the scan embeds the new revision on its next pass.`,
        { fix: effectStatusFix(effect) });
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
    throw opError('embedding_configuration', 'Selected brain embedding_disabled must be true or false.',
      `The brain's embedding_disabled setting is neither true nor false, so embedding is paused. Read it, then have the user set it to true or false with gbrain config set embedding_disabled.`,
      { fix: readFix('Shows the stored embedding_disabled value and the plane it comes from, read-only.', { argv: ['gbrain', 'config', 'get', 'embedding_disabled'] }) });
  }
  assertEmbeddingEnabled({ engine: engine.kind, ...config, embedding_disabled: disabled === 'true' });
}

function embeddingStorageFailure(error: unknown): unknown {
  return transientDatabaseFailure(error)
    ? opError('embedding_storage_unavailable', 'Embedding policy or claim storage is temporarily unavailable.',
      'The database did not answer an embedding policy or claim read; no vectors were installed and the effect worker tries again with backoff. If it persists, check database health.',
      { fix: readFix('Checks the brain database connection and schema health, read-only.', { argv: ['gbrain', 'doctor', '--json'] }) }) : error;
}

async function recordFailure(engine: BrainEngine, effect: PersistenceEffect, error: unknown, signal?: AbortSignal, target?: string): Promise<void> {
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
  if (CONTENTION_CODES.includes(code)) { await retryEffect(engine, effect, code, 250); return; }
  if (!['git', 'withdrawal-mirror'].includes(effect.kind) || DEPENDENCY_CODES.includes(code) || signal?.aborted || transientDatabaseFailure(error)) {
    await retryEffect(engine, effect, code, 30_000); return;
  }
  const [current] = await engine.executeRaw<{ recovering: boolean }>('SELECT recovery IS NOT NULL AS recovering FROM persistence_effects WHERE id=$1', [effect.id]);
  if (current?.recovering) { await retryEffect(engine, effect, code, 30_000); return; }
  // A retried parked target has exactly one authorized attempt; otherwise the
  // counter only accumulates while the same target keeps failing.
  const prior = target !== undefined && effect.data.retry_slugs?.includes(target) ? PARK_AFTER_FAILURES - 1
    : effect.data.failing_target === target ? effect.data.target_failures ?? 0 : 0;
  const failures = prior + 1;
  if (failures < PARK_AFTER_FAILURES) {
    await requeueEffect(engine, effect, { ...effect.data, target_failures: failures, ...(target === undefined ? {} : { failing_target: target }) }, code, 30_000);
    return;
  }
  await parkEffectTarget(engine, effect, code, target);
}

/** Waits that say nothing about the target never count toward parking. */
const CONTENTION_CODES = ['projection_pending', 'revision_conflict', 'writer_busy', 'writer_pool_capacity', 'git_index_locked'];
const DEPENDENCY_CODES = ['recovery_required', 'owner_unavailable', 'write_claim_lost', 'queue_capacity'];

/**
 * A scan sets its failing target aside and moves on; a single-target effect,
 * or a failure outside any target, parks the whole effect. Parked work stays
 * retained until `gbrain sources writer retry-effects` authorizes another attempt.
 */
async function parkEffectTarget(engine: BrainEngine, effect: PersistenceEffect, code: string, target: string | undefined): Promise<void> {
  const { target_failures: _failures, failing_target: _target, retry_slugs: retrying = [], ...data } = effect.data;
  const scanning = target !== undefined && (targetedWithdrawalEffect(effect) || effect.data.source_scan === true);
  const parked = [...(effect.data.parked ?? []), { ...(target ?? effect.data.slug ? { slug: target ?? effect.data.slug } : {}), error_code: code }];
  if (!scanning) { await parkEffect(engine, effect, { ...data, ...(retrying.length ? { retry_slugs: retrying } : {}), parked }); return; }
  const remaining = retrying.filter(slug => slug !== target);
  await requeueEffect(engine, effect, { ...data, parked, ...(retrying.includes(target) ? {} : { after_slug: target }),
    ...(remaining.length ? { retry_slugs: remaining, target_failures: PARK_AFTER_FAILURES - 1 } : {}) }, code, 0);
}

/** #5530: at most this many single-file Git effects share one commit. */
const GIT_GROUP_SIZE = 100;
/** A short Git group yields to queued publications at most this many claims, GIT_YIELD_MS apart. */
const GIT_YIELD_ATTEMPTS = 20;
const GIT_YIELD_MS = 250;

/**
 * Bounded, idempotent work. Recovery obtains kernel exclusion before a DB claim.
 * Resolves with the number of effects attempted, so a caller can keep draining.
 */
export async function runPersistenceEffects(engine: BrainEngine, config: GBrainConfig, opts: EffectWorkerOptions): Promise<number> {
  const limit = Math.max(1, Math.min(opts.limit ?? 2, 20));
  const recoveries = await selectEffectRecoveries(engine, opts.hostId, limit);
  let attempted = 0;
  for (const recovery of recoveries) {
    if (opts.signal?.aborted) return attempted;
    const binding = await getWorktreeBinding(engine, recovery.source_id, opts.hostId);
    if (!binding) continue;
    const lock = await acquireWorktree(binding, 0, undefined, engine);
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
  const run = async (claimed: PersistenceEffect, binding: WorktreeBinding | null, hardened?: boolean) => {
    let effect = claimed;
    const attempt: EffectAttempt = {};
    let lock: Awaited<ReturnType<typeof acquireWorktree>> = null;
    // A single-file git effect in a repository without the durability hook
    // runs no git command and only records its outcome: acquiring the lock
    // still proves the owned root, but it is not held while recording.
    const recordOnly = effect.kind === 'git' && hardened === false && !targetedWithdrawalEffect(effect) && !effect.data.source_scan;
    try {
      if (effect.worktree_id && !['embedding', 'facts-backstop', 'links'].includes(effect.kind)) {
        if (!binding) throw opError('owner_unavailable', 'The canonical effect owner is unavailable.',
          `This host does not hold source ${effect.source_id}'s canonical worktree, so its ${effect.kind} effect waits for the owner. Check which host owns the source; the effect runs there.`,
          { fix: effectStatusFix(effect) });
        lock = await acquireWorktree(binding, 0, undefined, engine);
        if (!lock) throw writerBusy(effect);
        if (recordOnly) { await lock.release(); lock = null; }
      }
      await engine.transaction(async tx => {
        await guardEffectSource(tx, effect, opts.hostId);
        if (effect.worktree_id) {
          const blocked = await tx.executeRaw('SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1', [effect.worktree_id]);
          if (blocked.length) throw recoveryFirst(effect);
        }
      });
      effect = await upgradeWithdrawalEffect(engine, effect, opts.hostId);
      if (effect.kind === 'withdrawal-mirror') await mirrorPage(engine, effect, binding, opts, attempt);
      else if (effect.kind === 'git') await gitPage(engine, effect, binding, opts, attempt, hardened);
      else await withAIAttribution({ request_id: effect.request_id, effect: effect.kind }, () => effect.kind === 'facts-backstop'
        ? dispatchFactsBackstopEffect(engine, effect, opts.hostId)
        : effect.kind === 'links' ? runLinksEffect(engine, effect, opts.hostId)
          : embedPage(engine, config, effect, opts));
    } catch (error) { await recordFailure(engine, effect, error, opts.signal, attempt.target); }
    finally { await lock?.release(); }
  };
  // A git effect first needs its durability probe (git child processes, one
  // probe per root per run). The probe runs while the rest of the batch
  // proceeds; git effects then run in claim order, never holding a worktree
  // lock while they wait for it.
  //
  // #5530: a claimed single-file git effect brings up to 99 more ready
  // single-file git effects of its worktree. Under the worktree lock each path
  // is validated as before, the group makes one `commit --only`, and every
  // root pushes once at the end of the pass. A path failure fails only its
  // effect; a push failure leaves the whole group retryable (the next pass
  // finds nothing to commit and pushes once). Nothing holds a lock or a
  // database connection while waiting.
  const probes = new Map<string, Promise<boolean>>();
  const deferred: { effects: PersistenceEffect[]; binding: WorktreeBinding; hardened: Promise<boolean> }[] = [];
  const unpushed = new Map<string, { binding: WorktreeBinding; items: { effect: PersistenceEffect; git: string; target?: string }[] }>();
  const commitGroup = async (effects: PersistenceEffect[], binding: WorktreeBinding & { local_path: string }) => {
    // A short group yields to publications still queued for its worktree, so a
    // serial producer (the grandfather step) publishes ahead and its Git work
    // arrives as one group. Each yield is a claim, so attempts bound the delay.
    if (effects.length < GIT_GROUP_SIZE && effects.every(effect => effect.attempts <= GIT_YIELD_ATTEMPTS)) {
      const [pending] = await engine.executeRaw<{ pending: boolean }>(`SELECT EXISTS(SELECT 1 FROM persistence_requests
        WHERE worktree_id=$1::uuid AND state IN ('queued','running')) AS pending`, [effects[0]!.worktree_id]);
      if (pending?.pending) {
        for (const effect of effects) await retryEffect(engine, effect, 'publication_pending', GIT_YIELD_MS);
        return;
      }
    }
    let lock: Awaited<ReturnType<typeof acquireWorktree>> = null;
    try {
      lock = await acquireWorktree(binding, 0, undefined, engine);
      if (!lock) throw writerBusy(effects[0]!);
    } catch (error) {
      for (const effect of effects) await recordFailure(engine, effect, error, opts.signal);
      return;
    }
    const targets: { effect: PersistenceEffect; path: string; attempt: EffectAttempt }[] = [];
    try {
      for (const effect of effects) {
        const attempt: EffectAttempt = {};
        try {
          // Sources sharing a worktree have their own relative roots: validate each path against its own binding.
          const own = await engine.transaction(async tx => {
            const guarded = await guardEffectSource(tx, effect, opts.hostId);
            const blocked = await tx.executeRaw('SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1', [effect.worktree_id]);
            if (blocked.length) throw recoveryFirst(effect);
            return guarded;
          });
          if (!own?.local_path || own.local_path !== binding.local_path) throw opError('source_changed', 'The effect canonical binding changed.',
            `Source ${effect.source_id}'s canonical checkout no longer matches the worktree this Git group is committing, so its file was left out. Check the owner; the effect resumes under the current binding.`,
            { fix: effectStatusFix(effect) });
          const path = await singleFileGitTarget(engine, effect, { ...own, local_path: own.local_path }, attempt);
          if (path !== null) targets.push({ effect, path, attempt });
        } catch (error) { await recordFailure(engine, effect, error, opts.signal, attempt.target); }
      }
      const outcomes = targets.length ? await commitGitTargets(binding.local_path, targets.map(t => t.path), opts.signal) : new Map();
      const pending = unpushed.get(binding.local_path) ?? { binding, items: [] };
      for (const { effect, path, attempt } of targets) {
        const outcome = outcomes.get(path)!;
        if (outcome instanceof OperationError) await recordFailure(engine, effect, outcome, opts.signal, attempt.target);
        else if (outcome.reason === 'target_absent') await completeEffect(engine, effect, outcome);
        else pending.items.push({ effect, git: outcome.git, target: attempt.target });
      }
      if (pending.items.length) unpushed.set(binding.local_path, pending);
    } catch (error) {
      for (const { effect, attempt } of targets) await recordFailure(engine, effect, error, opts.signal, attempt.target);
    } finally { await lock.release(); }
  };
  // A deferred effect that requeues itself (a page walk advancing its cursor,
  // or work unblocked by an earlier effect) is claimable again after the flush.
  for (;;) {
    while (attempted < limit && !opts.signal?.aborted) {
      const effect = await claimPersistenceEffect(engine, opts.hostId);
      if (!effect) break;
      attempted++;
      let binding: WorktreeBinding | null = null;
      try {
        if (effect.worktree_id && !['embedding', 'facts-backstop', 'links'].includes(effect.kind)) binding = await getWorktreeBinding(engine, effect.source_id, opts.hostId);
      } catch (error) { await recordFailure(engine, effect, error, opts.signal); continue; }
      if (effect.kind === 'git' && binding?.local_path) {
        const root = binding.local_path;
        if (!probes.has(root)) probes.set(root, isDurabilityHardenedAsync(root));
        const group = singleFileGitEffect(effect) && effect.worktree_id
          ? [effect, ...await claimCoalescedGitEffects(engine, opts.hostId, effect.worktree_id, GIT_GROUP_SIZE - 1)] : [effect];
        deferred.push({ effects: group, binding, hardened: probes.get(root)! });
      } else await run(effect, binding);
    }
    if (!deferred.length) break;
    for (const { effects, binding, hardened } of deferred.splice(0)) {
      const durable = await hardened;
      if (durable && singleFileGitEffect(effects[0]!)) await commitGroup(effects, { ...binding, local_path: binding.local_path! });
      // Coalesced siblings run with their own source's binding (sources can share a worktree).
      else for (const effect of effects) {
        let own: WorktreeBinding | null;
        try { own = effect === effects[0] ? binding : await getWorktreeBinding(engine, effect.source_id, opts.hostId); }
        catch (error) { await recordFailure(engine, effect, error, opts.signal); continue; }
        await run(effect, own, durable);
      }
    }
  }
  for (const [root, { binding, items }] of unpushed) {
    let pushed: Awaited<ReturnType<typeof pushGitRoot>> | undefined;
    let failure: unknown;
    let lock: Awaited<ReturnType<typeof acquireWorktree>> = null;
    try {
      lock = await acquireWorktree(binding, 0, undefined, engine);
      if (!lock) throw writerBusy(items[0]!.effect);
      pushed = await pushGitRoot(root, opts.signal);
    } catch (error) { failure = error; } finally { await lock?.release(); }
    for (const { effect, git, target } of items) {
      try {
        if (!pushed) throw failure;
        await completeEffect(engine, effect, { git, ...pushed });
      } catch (error) { await recordFailure(engine, effect, error, opts.signal, target); }
    }
  }
  return attempted;
}
