import type { BrainEngine } from '../engine.ts';
import { loadConfigWithEngine, type GBrainConfig } from '../config.ts';
import { MAX_RATE_LIMIT_RETRIES } from '../embed-retry.ts';
import { EmbeddingDisabledError, readContentChunksColumnDim } from '../embedding-dim-check.ts';
import { resolveWriteColumnFromConfigRows } from '../search/embedding-column.ts';
import { OperationError, opError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { authorizeStoredRequest, authorizeWrite, submissionAuthority } from './authority.ts';
import { existingLocalHostId } from './identity.ts';
import { guardEffectSource } from './effect-recovery.ts';
import { assertEmbeddingEffectEnabled, readEmbeddingEffectProjection, selectedEffectPage } from './effects.ts';
import { PARK_AFTER_FAILURES, type PersistenceEffect } from './effect-model.ts';
import type { WriteRequest } from './model.ts';
import { targetedWithdrawalEffect, upgradeWithdrawalEffect } from './effect-targets.ts';
import { declarePersistenceProtocol } from './protocol.ts';

const ownerStatusFix = (sourceId: string): Action => readFix(`Shows source ${sourceId}'s canonical owner with its blocking, retrying and parked effects, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
const previewFix = (sourceId: string, requestId: string): Action => readFix(
  `Previews request ${requestId}'s parked and failed effects in source ${sourceId} and what retry-effects would do, without queuing anything.`,
  { argv: ['gbrain', 'sources', 'writer', 'retry-effects', '--source', sourceId, '--request-id', requestId, '--dry-run', '--json'] });
const receiptFix = (requestId: string): Action => readFix(`Reads request ${requestId}'s receipt: its source, state and effect outcomes, read-only.`,
  { argv: ['gbrain', 'write-request', '--', requestId] });
const unregisteredHost = (sourceId: string, requestId: string) => opError('permission_denied', 'Retry requires the registered local CLI host.',
  `This machine has no registered gbrain host identity, so it cannot authorize another attempt for request ${requestId} in source ${sourceId}; nothing was queued. Run retry-effects on the brain host that owns ${sourceId}; the owner status names it.`,
  { fix: ownerStatusFix(sourceId) });

async function mountedEmbeddingSignature(engine: BrainEngine): Promise<string> {
  const rows = await engine.executeRaw<{ key: string; value: string }>(`SELECT key,value FROM config
    WHERE key IN ('embedding_model','embedding_dimensions','search_embedding_column','embedding_columns') ORDER BY key FOR SHARE`);
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
  let column;
  try {
    if (values.embedding_columns !== undefined) {
      const registry: unknown = JSON.parse(values.embedding_columns);
      if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('Invalid registry');
    }
    column = resolveWriteColumnFromConfigRows({ searchEmbeddingColumn: values.search_embedding_column,
      embeddingColumnsJson: values.embedding_columns });
  } catch {
    throw new OperationError('embedding_configuration', 'The selected brain has invalid active embedding-column provenance.',
      'Inspect and repair embedding configuration on the selected brain owner before retrying.');
  }
  const model = column.embeddingModel || values.embedding_model;
  const dimensions = column.embeddingModel ? column.dimensions
    : /^[1-9]\d*$/.test(values.embedding_dimensions ?? '') ? Number(values.embedding_dimensions) : null;
  if (!model || !/^[^\s:]+:[^\s]+$/.test(model) || !Number.isSafeInteger(dimensions) || !dimensions || column.name === 'embedding_image') {
    throw new OperationError('embedding_unconfigured', 'The selected brain has no verifiable text embedding model and dimensions.',
      'Inspect embedding provenance on the selected brain owner; the host model is never used for mounted retry.');
  }
  const physical = await readContentChunksColumnDim(engine, column.name);
  if (!physical.exists || physical.dims !== dimensions) {
    throw new OperationError('embedding_configuration', 'The selected brain embedding provenance does not match its active vector column.',
      'Finish the reviewed embedding migration on the selected brain owner before retrying.');
  }
  return `${model}:${dimensions}`;
}

/**
 * #5612: parked Git and withdrawal effects of one committed request. Returns
 * null when the request has none, so the caller falls through to embedding
 * retry. Each invocation authorizes exactly one more attempt per parked target.
 */
export async function retryParkedEffects(engine: BrainEngine, sourceId: string, requestId: string, dryRun: boolean): Promise<Record<string, unknown> | null> {
  const [request, ambiguous] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1 AND request_id=$2::uuid LIMIT 2', [sourceId, requestId]);
  if (!request || ambiguous) return null;
  const tracked = await engine.executeRaw<PersistenceEffect>(`SELECT * FROM persistence_effects WHERE request_id=$1::uuid
    AND kind IN ('git','withdrawal-mirror') AND (data ? 'parked' OR data ? 'retried') ORDER BY kind`, [request.id]);
  if (!tracked.length) return null;
  const hostId = existingLocalHostId();
  if (!hostId) throw unregisteredHost(sourceId, requestId);
  return engine.transaction(async tx => {
    await authorizeStoredRequest(tx, request, true);
    const authority = await submissionAuthority({ engine: tx, remote: false, sourceId } as OperationContext,
      request.operation, sourceId, request.source_incarnation, request.slug);
    await authorizeWrite(tx, authority, request.operation, request.slug, true);
    const effects = [];
    for (const selected of tracked) {
      await guardEffectSource(tx, selected, hostId);
      const [effect] = await tx.executeRaw<PersistenceEffect>('SELECT * FROM persistence_effects WHERE id=$1 FOR UPDATE', [selected.id]);
      const parked = effect.data.parked ?? [];
      const summary = { kind: effect.kind, parked_targets: parked.length, targets: parked.slice(0, 20), retried: effect.data.retried ?? 0 };
      if (effect.state !== 'failed' || effect.error_code !== 'targets_parked') {
        effects.push({ ...summary, state: effect.state, terminal: effect.state === 'committed', action: 'unchanged' });
        continue;
      }
      if (effect.execution_token !== null || effect.recovery) throw opError('write_claim_lost', 'A parked effect still has a claim or recovery record; inspect it before retrying.',
        `The ${effect.kind} effect of request ${requestId} in source ${sourceId} is still claimed by a worker or holds a recovery record, so nothing was queued. Inspect the owner's effects; once the worker releases it, preview it again with --dry-run.`,
        { fix: ownerStatusFix(sourceId) });
      if (dryRun) { effects.push({ ...summary, state: 'parked', terminal: true, action: 'would_retry' }); continue; }
      const { parked: _parked, retry_slugs: retrying = [], failing_target: _target, ...data } = effect.data;
      const scanning = targetedWithdrawalEffect(effect) || effect.data.source_scan === true;
      const slugs = scanning ? [...new Set([...retrying, ...parked.flatMap(entry => entry.slug ? [entry.slug] : [])])] : [];
      const [updated] = await tx.executeRaw<{ state: string }>(`UPDATE persistence_effects SET state='queued',data=$2::text::jsonb,error_code=NULL,
        next_attempt_at=now(),claim_expires_at=NULL,updated_at=now() WHERE id=$1 AND state='failed' AND error_code='targets_parked'
        AND execution_token IS NULL AND recovery IS NULL RETURNING state`,
      [effect.id, JSON.stringify({ ...data, ...(slugs.length ? { retry_slugs: slugs } : {}), target_failures: PARK_AFTER_FAILURES - 1,
        ...(!scanning && (effect.data.slug ?? effect.data.relative_path) ? { failing_target: effect.data.slug ?? effect.data.relative_path } : {}),
        retried: (effect.data.retried ?? 0) + 1 })]);
      if (!updated) throw opError('write_claim_lost', 'The parked effect changed during retry approval.',
        `The ${effect.kind} effect of request ${requestId} changed (claimed, retried or settled by the worker) while this approval ran, so the transaction rolled back and nothing was queued. Preview its current state before deciding again.`,
        { fix: previewFix(sourceId, requestId) });
      effects.push({ ...summary, state: 'queued', terminal: false, action: 'retry_queued' });
    }
    const queued = effects.some(effect => effect.action === 'retry_queued');
    return { request_id: request.request_id, source_id: sourceId, dry_run: dryRun, effects,
      next_action: dryRun ? 'Fix the recorded cause, then run the same command without --dry-run to authorize one more attempt per parked target.'
        : queued ? 'The resident owner makes one more attempt per parked target. Rerun this command with --dry-run to read the terminal state; a target that fails again parks again.'
          : 'No parked target remains for this request.' };
  });
}

/**
 * `retry-effects` dispatch: parked Git/withdrawal work that still needs action
 * wins; otherwise the embedding obligation is handled, with any settled parked
 * history reported alongside (or alone when the request has no retryable embedding).
 */
export async function retryRequestEffects(engine: BrainEngine, sourceId: string, requestId: string, dryRun: boolean, baseConfig?: GBrainConfig,
  policy: 'owner' | 'mounted_database' = 'owner'): Promise<Record<string, unknown>> {
  const parked = await retryParkedEffects(engine, sourceId, requestId, dryRun);
  if (parked && (parked.effects as Array<{ state: string }>).some(effect => effect.state !== 'committed')) return parked;
  try {
    const embedding = await retryEmbeddingEffect(engine, sourceId, requestId, dryRun, baseConfig, policy);
    return parked ? { ...embedding, parked_effects: parked.effects } : embedding;
  } catch (error) {
    if (parked && error instanceof OperationError && ['invalid_params', 'effect_not_failed'].includes(error.code)) return parked;
    throw error;
  }
}

export async function retryEmbeddingEffect(engine: BrainEngine, sourceId: string, requestId: string, dryRun: boolean, baseConfig?: GBrainConfig,
  policy: 'owner' | 'mounted_database' = 'owner'): Promise<Record<string, unknown>> {
  const requests = await engine.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r WHERE source_id=$1 AND request_id=$2::uuid
    AND EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='embedding') LIMIT 2`, [sourceId, requestId]);
  if (requests.length !== 1) throw opError('invalid_params', 'The source and request must identify exactly one embedding obligation.',
    `Request ${requestId} in source ${sourceId} has no single embedding effect and no parked Git or withdrawal effect, so nothing was queued. Check that the request_id is the one from the write receipt and that ${sourceId} is the source it was written to.`,
    { fix: receiptFix(requestId) });
  const request = requests[0];
  const hostId = existingLocalHostId();
  if (!hostId) throw unregisteredHost(sourceId, requestId);
  const config = await loadConfigWithEngine(engine, baseConfig);
  const configuredSignature = config?.embedding_model && config.embedding_dimensions
    ? `${config.embedding_model}:${config.embedding_dimensions}` : null;
  return engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    const [selected] = await tx.executeRaw<PersistenceEffect>("SELECT * FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [request.id]);
    if (!selected) throw opError('invalid_params', 'The embedding obligation is unavailable.',
      `The embedding effect of request ${requestId} in source ${sourceId} disappeared while retry-effects ran (it settled or was compacted), so nothing was queued. Preview the request again.`,
      { fix: previewFix(sourceId, requestId) });
    if (selected.data.source_scan && selected.data.version === undefined) {
      if (selected.worktree_id) await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [selected.worktree_id]);
      await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    }
    await guardEffectSource(tx, selected, hostId);
    await authorizeStoredRequest(tx, request, true);
    const authority = await submissionAuthority({ engine: tx, remote: false, sourceId } as OperationContext,
      request.operation, sourceId, request.source_incarnation, request.slug);
    await authorizeWrite(tx, authority, request.operation, request.slug, true);
    if (request.state !== 'committed') throw opError('write_pending', 'Only committed canonical requests have retryable embedding obligations.',
      `Request ${requestId} in source ${sourceId} is ${request.state}, not committed, so its embedding effect cannot be retried yet and nothing was queued. Read its receipt and wait until it is final; a request that ends failed or in conflict has no embedding to retry.`,
      { fix: receiptFix(requestId) });
    const [stored] = await tx.executeRaw<PersistenceEffect>('SELECT * FROM persistence_effects WHERE id=$1 FOR UPDATE', [selected.id]);
    if (!stored || stored.source_id !== sourceId || stored.source_incarnation !== request.source_incarnation || stored.recovery) {
      throw opError('source_changed', 'The effect source or recovery state changed.',
        `Source ${sourceId} was archived or replaced, or the embedding effect of request ${requestId} now holds a recovery record, so nothing was queued. Inspect the source's owner and its effects.`,
        { fix: ownerStatusFix(sourceId) });
    }
    const effect = await upgradeWithdrawalEffect(tx, stored, hostId, false);
    const snapshot = await selectedEffectPage(tx, effect);
    const scanning = targetedWithdrawalEffect(effect) || effect.data.source_scan === true;
    const scanComplete = scanning && !snapshot;
    if (!scanComplete && (!snapshot || !scanning &&
      (snapshot.page.deleted_at || snapshot.revision !== effect.revision || snapshot.page.id !== effect.data.page_id))) {
      throw opError('revision_conflict', 'The original embedding obligation is superseded; inspect the current page instead.',
        `Page ${request.slug} changed or was deleted after request ${requestId}, so its old embedding obligation is moot and nothing was queued; the newer write carries its own. Read the page as it is now; if its embeddings are missing, preview gbrain repair embedding-effects --source ${sourceId}.`,
        { fix: readFix(`Shows page ${request.slug} in source ${sourceId} as it is now, with its revision.`,
          { argv: ['gbrain', 'get', '--source', sourceId, '--', request.slug] }) });
    }
    if (snapshot) {
      await authorizeWrite(tx, request.authority, request.operation, snapshot.page.slug, true);
      await authorizeWrite(tx, authority, request.operation, snapshot.page.slug, true);
    }
    const receipt = { request_id: request.request_id, source_id: sourceId, kind: 'embedding', attempts: effect.attempts,
      retry_limit: MAX_RATE_LIMIT_RETRIES, dry_run: dryRun,
      ...(policy === 'mounted_database' ? { embedding_policy: { approval: 'selected_database_provenance', execution: 'owner_file_and_database' } } : {}) };
    if (effect.state !== 'failed') {
      if (effect.data.embedding_retry_base !== undefined || effect.state === 'committed') return { ...receipt, state: effect.state, action: 'unchanged',
        next_action: 'Inspect this same receipt; this command does not authorize another retry cycle.' };
      throw opError('effect_not_failed', 'Only a failed, non-running embedding effect can be explicitly retried.',
        `The embedding effect of request ${requestId} is ${effect.state}, so the worker still owns it and nothing was queued. Preview it again once it settles; a committed effect needs nothing.`,
        { fix: previewFix(sourceId, requestId) });
    }
    if (effect.execution_token !== null) throw opError('write_claim_lost', 'A failed effect still has an execution claim; inspect it before retrying.',
      `The failed embedding effect of request ${requestId} in source ${sourceId} is still claimed by a worker, so nothing was queued. Inspect the owner's effects; once the claim is released, preview it again with --dry-run.`,
      { fix: ownerStatusFix(sourceId) });
    const signature = policy === 'mounted_database' && !scanComplete ? await mountedEmbeddingSignature(tx) : configuredSignature;
    if (!signature && !scanComplete) return { ...receipt, state: 'failed', action: 'blocked', reason: 'embedding_unconfigured', next_action: 'Configure embeddings, then inspect this request again.' };
    const pending = scanComplete || snapshot?.page.deleted_at ? [] : (await readEmbeddingEffectProjection(tx, effect, snapshot!, hostId, signature!)).pending;
    const complete = scanComplete || pending.length === 0 && !scanning;
    if (!complete) {
      await tx.executeRaw("SELECT key FROM config WHERE key='embedding_disabled' FOR SHARE");
      try { await assertEmbeddingEffectEnabled(tx, config); }
      catch (error) {
        if (!(error instanceof EmbeddingDisabledError)) throw error;
        return { ...receipt, state: 'failed', action: 'blocked', reason: 'embedding_disabled',
          next_action: 'Embedding remains disabled; explicitly configure it before retrying.' };
      }
      if (effect.data.embedding_retry_base !== undefined) return { ...receipt, state: 'failed', action: 'blocked', reason: 'embedding_retry_exhausted',
        next_action: `The explicit retry allowance is already consumed. Inspect the provider, then preview one new bounded retry cycle with gbrain repair embedding-effects --source ${sourceId} and apply it with --apply.` };
    }
    if (dryRun) return { ...receipt, state: 'failed', action: complete ? 'would_reconcile' : 'would_retry',
      pending_chunks: pending.length, next_action: 'Run the same command without --dry-run to approve this bounded action.' };
    const [updated] = await tx.executeRaw<{ state: string }>(`UPDATE persistence_effects SET state=$4,
      data=CASE WHEN $4='queued' THEN $5::text::jsonb||jsonb_build_object('embedding_attempt_base',attempts,'embedding_retry_base',attempts) ELSE $5::text::jsonb END,
      error_code=NULL,claim_expires_at=NULL,next_attempt_at=now(),updated_at=now(),
      outcome=CASE WHEN $4='committed' THEN '{"embedding":"reconciled"}'::jsonb ELSE NULL END
      WHERE id=$1 AND state='failed' AND execution_token IS NULL AND recovery IS NULL AND attempts=$2 AND source_incarnation=$3::uuid RETURNING state`,
    [effect.id, effect.attempts, effect.source_incarnation, complete ? 'committed' : 'queued', JSON.stringify(effect.data)]);
    if (!updated) throw opError('write_claim_lost', 'The embedding obligation changed during retry approval.',
      `The embedding effect of request ${requestId} changed (claimed or settled by the worker) while this approval ran, so the transaction rolled back and nothing was queued. Preview its current state before deciding again.`,
      { fix: previewFix(sourceId, requestId) });
    return { ...receipt, state: updated.state, action: complete ? 'reconciled' : 'retry_queued', pending_chunks: pending.length,
      next_action: complete ? 'The existing vectors satisfy this obligation; no provider work was scheduled.' : 'The resident owner may spend up to five attempts only when its selected file configuration and the database policy permit embedding, under existing provider and job budgets. Repeating this command does not renew that allowance.' };
  });
}
