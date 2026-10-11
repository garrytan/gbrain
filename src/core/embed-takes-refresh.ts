import type { BrainEngine } from './engine.ts';
import { getEmbeddingDimensions, getEmbeddingModel } from './ai/gateway.ts';
import { resolveRecipe } from './ai/model-resolver.ts';
import { withAIInvocationGuard } from './ai/invocation-guard.ts';
import { BudgetTracker, loadPricingOverrides } from './budget/budget-tracker.ts';
import { embedStaleTakes, readTakesEmbeddingDim } from './embed-takes.ts';
import type { EmbedTakesResult } from './embed-takes.ts';
import { embedBatchWithBackoff } from './embed-retry.ts';
import type { GBrainConfig } from './config.ts';
import { currentVerifiedLocalWriter } from './persistence/identity.ts';
import { submissionAuthority, authorizeWrite } from './persistence/authority.ts';
import type { OperationContext } from './ops/contract.ts';
import { opError } from './ops/contract.ts';
import { assertBrainEmbeddingEnabled, assertEmbeddingEnabled } from './embedding-dim-check.ts';
import { isValidSourceId } from './source-id.ts';

export interface EmbedTakesWithConsentOpts {
  sourceId: string;
  all?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  maxCostUsd?: number;
  budgetMs?: number;
  batchSize?: number;
  signal?: AbortSignal;
  assertOwned?: (tx: BrainEngine) => Promise<void>;
}

export interface EmbedTakesWithConsentResult {
  source_id: string;
  dryRun: boolean;
  total_stale: number;
  would_embed: number;
  takes: EmbedTakesResult;
  remaining: number;
  cost_usd: number;
  cost_estimated: boolean;
  stopped: 'preview' | 'complete' | 'aborted' | 'failed';
}

const invalid = (message: string): never => { throw opError('invalid_params', message, 'Preview the source-scoped takes refresh first; execution requires --yes and a finite --max-cost-usd cap.'); };

function validateOptions(value: unknown): EmbedTakesWithConsentOpts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Take refresh requires typed options');
  const options = value as Record<string, unknown>;
  const allowed = ['sourceId', 'all', 'dryRun', 'yes', 'maxCostUsd', 'budgetMs', 'batchSize', 'signal', 'assertOwned'];
  if (Object.keys(options).some(key => !allowed.includes(key))) return invalid('Take refresh received unsupported options');
  if (!isValidSourceId(options.sourceId)) return invalid('Take refresh requires an explicit valid sourceId');
  for (const key of ['all', 'dryRun', 'yes']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') return invalid(`${key} must be a boolean`);
  }
  for (const [key, max] of [['batchSize', 500], ['budgetMs', 3_600_000]] as const) {
    if (options[key] !== undefined && (typeof options[key] !== 'number' || !Number.isSafeInteger(options[key])
      || options[key] < 1 || options[key] > max)) return invalid(`${key} must be an integer from 1 to ${max}`);
  }
  if (options.maxCostUsd !== undefined && (typeof options.maxCostUsd !== 'number'
    || !Number.isFinite(options.maxCostUsd) || options.maxCostUsd < 0)) return invalid('maxCostUsd must be a finite non-negative number');
  if (options.yes === true && (typeof options.maxCostUsd !== 'number' || !Number.isFinite(options.maxCostUsd) || options.maxCostUsd < 0)) {
    return invalid('Take refresh execution requires --yes and a finite --max-cost-usd >= 0');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) return invalid('signal must be an AbortSignal');
  if (options.assertOwned !== undefined && typeof options.assertOwned !== 'function') return invalid('assertOwned must be a function');
  return options as unknown as EmbedTakesWithConsentOpts;
}

const sourceEligible = `t.active AND p.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM sources s WHERE s.id=p.source_id AND NOT s.archived)
  AND p.source_id=$1`;
const staleEligible = `${sourceEligible} AND (t.embedding IS NULL
  OR t.embedded_text_hash IS DISTINCT FROM md5(t.claim)
  OR t.embedding_model IS DISTINCT FROM $2
  OR vector_dims(t.embedding) <> $3)`;

export async function embedTakesWithConsent(
  engine: BrainEngine,
  options: EmbedTakesWithConsentOpts,
  selectedConfig: GBrainConfig | null = null,
): Promise<EmbedTakesWithConsentResult> {
  const opts = validateOptions(options);
  const dryRun = opts.dryRun === true || opts.yes !== true;
  opts.signal?.throwIfAborted();

  const verified = currentVerifiedLocalWriter();
  if (verified && (verified.remote || verified.principal.kind !== 'local_cli' || verified.grant.slugPrefixes !== null
    || !verified.grant.sourceIds.includes('*') && !verified.grant.sourceIds.includes(opts.sourceId))) {
    throw opError('permission_denied', 'Take refresh requires a trusted source-wide CLI grant',
      `The registered CLI writer cannot refresh every take in source ${opts.sourceId}; widen the grant only after the operator approves it.`);
  }
  const [source] = await engine.executeRaw<{ incarnation: string }>(
    'SELECT incarnation::text FROM sources WHERE id=$1 AND archived=false', [opts.sourceId]);
  if (!source) throw new Error('Take refresh requires an active registered source');
  const authority = verified ? await submissionAuthority({ engine, remote: false, sourceId: opts.sourceId } as OperationContext,
    'submit_job', opts.sourceId, source.incarnation, '__take_embeddings__') : undefined;
  const authorize = async (target: BrainEngine, lock = false) => {
    if (!authority) return;
    await authorizeWrite(target, authority, 'submit_job', '__take_embeddings__', lock);
    const [grant] = await target.executeRaw<{ unrestricted_slugs: boolean }>(
      `SELECT grant_ceiling->'slugPrefixes' = 'null'::jsonb AS unrestricted_slugs
       FROM persistence_local_writers WHERE id=$1::uuid`, [authority.principal.id]);
    if (grant?.unrestricted_slugs !== true) throw opError('permission_denied', 'Take refresh requires a current source-wide CLI grant',
      `The CLI writer grant for source ${opts.sourceId} has slug prefixes and cannot refresh every take.`);
  };
  await authorize(engine);

  const model = getEmbeddingModel();
  const resolvedModel = resolveRecipe(model);
  const invocationModel = `${resolvedModel.recipe.id}:${resolvedModel.parsed.modelId}`;
  const dims = getEmbeddingDimensions();
  const dbModel = await engine.getConfig('embedding_model');
  const dbDims = await engine.getConfig('embedding_dimensions');
  const assertConfig = async (target: BrainEngine) => {
    assertEmbeddingEnabled(selectedConfig);
    const disabled = await target.getConfig('embedding_disabled');
    if (disabled !== null && disabled !== 'true' && disabled !== 'false') throw new Error('Selected brain embedding_disabled must be true or false');
    assertEmbeddingEnabled({ engine: target.kind, ...selectedConfig, embedding_disabled: disabled === 'true' });
    if (getEmbeddingModel() !== model || getEmbeddingDimensions() !== dims
      || await target.getConfig('embedding_model') !== model || await target.getConfig('embedding_dimensions') !== String(dims)
      || dbModel !== model || dbDims !== String(dims)
      || selectedConfig?.embedding_model !== undefined && selectedConfig.embedding_model !== model
      || selectedConfig?.embedding_dimensions !== undefined && selectedConfig.embedding_dimensions !== dims) {
      throw new Error('Embedding configuration differs from the database; finish the reviewed model migration first');
    }
  };
  await assertBrainEmbeddingEnabled(engine, selectedConfig);
  await assertConfig(engine);
  if (await readTakesEmbeddingDim(engine) !== dims) throw new Error('Takes embedding dimensions differ from the configured model; inspect migrate embeddings --status first');

  const lastPredicate = opts.all === true ? sourceEligible : staleEligible;
  const censusParams = opts.all === true ? [opts.sourceId] : [opts.sourceId, model, dims];
  const [census] = await engine.executeRaw<{ count: string; last_id: string }>(
    `SELECT count(*)::text AS count, COALESCE(max(t.id),0)::text AS last_id
       FROM takes t JOIN pages p ON p.id=t.page_id WHERE ${lastPredicate}`,
    censusParams);
  const lastId = census?.last_id ?? '0';
  const total = Number(census?.count ?? 0);
  if (dryRun) return {
    source_id: opts.sourceId, dryRun, total_stale: total, would_embed: total,
    takes: { total_stale: total, embedded: 0, would_embed: total, discarded: 0, failures: 0, failure_samples: [], dryRun: true },
    remaining: total, cost_usd: 0, cost_estimated: false, stopped: 'preview',
  };
  if (total === 0) return {
    source_id: opts.sourceId, dryRun, total_stale: 0, would_embed: 0,
    takes: { total_stale: 0, embedded: 0, would_embed: 0, discarded: 0, failures: 0, failure_samples: [], dryRun: false },
    remaining: 0, cost_usd: 0, cost_estimated: false, stopped: 'complete',
  };

  const signal = AbortSignal.any([AbortSignal.timeout(opts.budgetMs ?? 60_000), ...(opts.signal ? [opts.signal] : [])]);
  const tracker = new BudgetTracker({ label: 'embed.takes.refresh', maxCostUsd: opts.maxCostUsd,
    maxRuntimeMs: opts.budgetMs ?? 60_000, pricingOverrides: await loadPricingOverrides(engine) });
  const assertSource = async (target: BrainEngine, lock = false) => {
    const rows = await target.executeRaw(`SELECT id FROM sources WHERE id=$1 AND incarnation=$2::uuid AND NOT archived${lock ? ' FOR SHARE' : ''}`,
      [opts.sourceId, source.incarnation]);
    if (!rows.length) throw new Error('Source identity changed during take refresh; rerun the scoped preview');
  };

  if (opts.all && total > 0) {
    signal.throwIfAborted();
    await engine.transaction(async tx => {
      signal.throwIfAborted();
      await opts.assertOwned?.(tx);
      await assertSource(tx, true);
      await authorize(tx, true);
      await tx.executeRaw("SELECT key FROM config WHERE key IN ('embedding_model','embedding_dimensions','embedding_disabled') ORDER BY key FOR SHARE");
      await assertConfig(tx);
      const pages = await tx.executeRaw<{ id: string }>(
        `SELECT p.id::text FROM pages p
          WHERE p.source_id=$1 AND p.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM takes t WHERE t.page_id=p.id AND t.active AND t.id<=$2::bigint)
          ORDER BY p.id FOR UPDATE OF p`, [opts.sourceId, lastId]);
      const pageIds = pages.map(row => row.id);
      if (!pageIds.length) return;
      const takes = await tx.executeRaw<{ id: string }>(
        `SELECT t.id::text FROM takes t JOIN pages p ON p.id=t.page_id
          WHERE t.active AND t.id<=$2::bigint AND p.id=ANY($1::bigint[]) AND p.source_id=$3
            AND p.deleted_at IS NULL AND EXISTS (SELECT 1 FROM sources s WHERE s.id=p.source_id AND NOT s.archived)
          ORDER BY t.id FOR UPDATE OF t`, [pageIds, lastId, opts.sourceId]);
      const ids = takes.map(row => row.id);
      if (ids.length) await tx.executeRaw(
        'UPDATE takes SET embedding=NULL,embedded_at=NULL,embedding_model=NULL,embedded_text_hash=NULL WHERE id=ANY($1::bigint[])', [ids]);
      signal.throwIfAborted();
    });
  }

  let costEstimated = false;
  const assertOwned = async (target: BrainEngine, lock = false) => {
    await opts.assertOwned?.(target);
    await assertSource(target, lock);
    await authorize(target, lock);
    if (lock) await target.executeRaw("SELECT key FROM config WHERE key IN ('embedding_model','embedding_dimensions','embedding_disabled') ORDER BY key FOR SHARE");
    await assertConfig(target);
  };
  const takes = await withAIInvocationGuard(async call => {
    signal.throwIfAborted();
    if (call.kind !== 'embedding') throw new Error('Take refresh permits embedding calls only');
    if (call.model !== invocationModel) throw new Error('Embedding gateway model changed during take refresh; rerun the scoped preview');
    if (!Number.isSafeInteger(call.maxInputTokens) || call.maxInputTokens! < 0) throw new Error('Embedding request has no safe input-token ceiling');
    await assertOwned(engine);
    const reservation = tracker.reserve({ modelId: call.model, kind: 'embed', estimatedInputTokens: call.maxInputTokens!, maxOutputTokens: 0 });
    return { settle: async usage => {
      if (!usage) costEstimated = true;
      tracker.record({ modelId: call.model, reservation, kind: 'embed',
        inputTokens: usage?.inputTokens ?? call.maxInputTokens!, outputTokens: 0, estimated: !usage });
    } };
  }, () => embedStaleTakes(engine, {
    sourceId: opts.sourceId, batchSize: opts.batchSize, signal, assertOwned: target => assertOwned(target, true),
    embedFn: (texts, embedOpts) => embedBatchWithBackoff(texts, embedOpts),
  }), { inherit: true });
  const costUsd = tracker.totalSpent;
  const remainingRows = await engine.executeRaw<{ count: string }>(
    `SELECT count(*)::text AS count FROM takes t JOIN pages p ON p.id=t.page_id WHERE ${staleEligible} AND t.id<=$4::bigint`,
    [opts.sourceId, model, dims, lastId]);
  const remaining = Number(remainingRows[0]?.count ?? 0);
  const stopped = signal.aborted ? 'aborted' : takes.failures > 0 || remaining > 0 ? 'failed' : 'complete';
  return { source_id: opts.sourceId, dryRun, total_stale: total, would_embed: 0, takes, remaining,
    cost_usd: costUsd, cost_estimated: costEstimated, stopped };
}
