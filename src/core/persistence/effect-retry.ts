import type { BrainEngine } from '../engine.ts';
import { loadConfigWithEngine, type GBrainConfig } from '../config.ts';
import { MAX_RATE_LIMIT_RETRIES } from '../embed-retry.ts';
import { EmbeddingDisabledError, readContentChunksColumnDim } from '../embedding-dim-check.ts';
import { resolveWriteColumnFromConfigRows } from '../search/embedding-column.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { authorizeStoredRequest, authorizeWrite, submissionAuthority } from './authority.ts';
import { existingLocalHostId } from './identity.ts';
import { guardEffectSource } from './effect-recovery.ts';
import { assertEmbeddingEffectEnabled, readEmbeddingEffectProjection, selectedEffectPage } from './effects.ts';
import type { PersistenceEffect } from './effect-model.ts';
import type { WriteRequest } from './model.ts';

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

export async function retryEmbeddingEffect(engine: BrainEngine, sourceId: string, requestId: string, dryRun: boolean, baseConfig?: GBrainConfig,
  policy: 'owner' | 'mounted_database' = 'owner'): Promise<Record<string, unknown>> {
  const requests = await engine.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r WHERE source_id=$1 AND request_id=$2::uuid
    AND EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='embedding') LIMIT 2`, [sourceId, requestId]);
  if (requests.length !== 1) throw new OperationError('invalid_params', 'The source and request must identify exactly one embedding obligation.');
  const request = requests[0];
  const hostId = existingLocalHostId();
  if (!hostId) throw new OperationError('permission_denied', 'Retry requires the registered local CLI host.');
  const config = await loadConfigWithEngine(engine, baseConfig);
  const configuredSignature = config?.embedding_model && config.embedding_dimensions
    ? `${config.embedding_model}:${config.embedding_dimensions}` : null;
  return engine.transaction(async tx => {
    const [selected] = await tx.executeRaw<PersistenceEffect>("SELECT * FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [request.id]);
    if (!selected) throw new OperationError('invalid_params', 'The embedding obligation is unavailable.');
    await guardEffectSource(tx, selected, hostId);
    await authorizeStoredRequest(tx, request, true);
    const authority = await submissionAuthority({ engine: tx, remote: false, sourceId } as OperationContext,
      request.operation, sourceId, request.source_incarnation, request.slug);
    await authorizeWrite(tx, authority, request.operation, request.slug, true);
    if (request.state !== 'committed') throw new OperationError('write_pending', 'Only committed canonical requests have retryable embedding obligations.');
    const [effect] = await tx.executeRaw<PersistenceEffect>('SELECT * FROM persistence_effects WHERE id=$1 FOR UPDATE', [selected.id]);
    if (!effect || effect.source_id !== sourceId || effect.source_incarnation !== request.source_incarnation || effect.recovery) {
      throw new OperationError('source_changed', 'The effect source or recovery state changed.');
    }
    const snapshot = await selectedEffectPage(tx, effect);
    const scanComplete = effect.data.source_scan === true && !snapshot;
    if (!scanComplete && (!snapshot || snapshot.page.deleted_at || !effect.data.source_scan &&
      (snapshot.revision !== effect.revision || snapshot.page.id !== effect.data.page_id))) {
      throw new OperationError('revision_conflict', 'The original embedding obligation is superseded; inspect the current page instead.');
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
      throw new OperationError('effect_not_failed', 'Only a failed, non-running embedding effect can be explicitly retried.');
    }
    if (effect.execution_token !== null) throw new OperationError('write_claim_lost', 'A failed effect still has an execution claim; inspect it before retrying.');
    const signature = policy === 'mounted_database' && !scanComplete ? await mountedEmbeddingSignature(tx) : configuredSignature;
    if (!signature && !scanComplete) return { ...receipt, state: 'failed', action: 'blocked', reason: 'embedding_unconfigured', next_action: 'Configure embeddings, then inspect this request again.' };
    const pending = scanComplete ? [] : (await readEmbeddingEffectProjection(tx, effect, snapshot!, hostId, signature!)).pending;
    const complete = scanComplete || pending.length === 0 && !effect.data.source_scan;
    if (!complete) {
      await tx.executeRaw("SELECT key FROM config WHERE key='embedding_disabled' FOR SHARE");
      try { await assertEmbeddingEffectEnabled(tx, config); }
      catch (error) {
        if (!(error instanceof EmbeddingDisabledError)) throw error;
        return { ...receipt, state: 'failed', action: 'blocked', reason: 'embedding_disabled',
          next_action: 'Embedding remains disabled; explicitly configure it before retrying.' };
      }
      if (effect.data.embedding_retry_base !== undefined) return { ...receipt, state: 'failed', action: 'blocked', reason: 'embedding_retry_exhausted',
        next_action: 'The explicit retry allowance is already consumed. Inspect the provider and use a separately approved scoped repair.' };
    }
    if (dryRun) return { ...receipt, state: 'failed', action: complete ? 'would_reconcile' : 'would_retry',
      pending_chunks: pending.length, next_action: 'Run the same command without --dry-run to approve this bounded action.' };
    const [updated] = await tx.executeRaw<{ state: string }>(`UPDATE persistence_effects SET state=$4,
      data=CASE WHEN $4='queued' THEN data||jsonb_build_object('embedding_attempt_base',attempts,'embedding_retry_base',attempts) ELSE data END,
      error_code=NULL,claim_expires_at=NULL,next_attempt_at=now(),updated_at=now(),
      outcome=CASE WHEN $4='committed' THEN '{"embedding":"reconciled"}'::jsonb ELSE NULL END
      WHERE id=$1 AND state='failed' AND execution_token IS NULL AND recovery IS NULL AND attempts=$2 AND source_incarnation=$3::uuid RETURNING state`,
    [effect.id, effect.attempts, effect.source_incarnation, complete ? 'committed' : 'queued']);
    if (!updated) throw new OperationError('write_claim_lost', 'The embedding obligation changed during retry approval.');
    return { ...receipt, state: updated.state, action: complete ? 'reconciled' : 'retry_queued', pending_chunks: pending.length,
      next_action: complete ? 'The existing vectors satisfy this obligation; no provider work was scheduled.' : 'The resident owner may spend up to five attempts only when its selected file configuration and the database policy permit embedding, under existing provider and job budgets. Repeating this command does not renew that allowance.' };
  });
}
