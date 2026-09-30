import type { BrainEngine } from './engine.ts';
import { embed, getEmbeddingDimensions, getEmbeddingModel } from './ai/gateway.ts';
import { withAIInvocationGuard } from './ai/invocation-guard.ts';
import { BudgetTracker, loadPricingOverrides } from './budget/budget-tracker.ts';
import { assertEmbeddingEnabled, readFactsEmbeddingDim } from './embedding-dim-check.ts';
import type { GBrainConfig } from './config.ts';
import { redactConnectionInfo } from './audit/redact-connection-info.ts';
import { redactUrlsInText } from './url-redact.ts';
import { redactFindings } from './secret-scan.ts';
import { currentVerifiedLocalWriter } from './persistence/identity.ts';
import { submissionAuthority, authorizeWrite } from './persistence/authority.ts';
import type { OperationContext } from './ops/contract.ts';
import { OperationError } from './ops/contract.ts';
import { validateEmbedFactsOptions, type EmbedFactsOptions } from './embed-facts-options.ts';
import { AUDIT_ROW_SOURCES } from './facts/audit-sources.ts';
import { resolveMaxChunkTokens } from './embedding-input-limit.ts';
import { estimateTokens } from './chunkers/token-estimate.ts';
import { eligibleFactEmbedding, staleFactEmbedding } from './facts/embedding-identity.ts';

export interface EmbedFactsOpts extends EmbedFactsOptions {
  signal?: AbortSignal;
  assertOwned?: (tx: BrainEngine) => Promise<void>;
}

export interface EmbedFactsResult {
  source_id: string;
  dryRun: boolean;
  total_stale: number;
  would_embed: number;
  attempted: number;
  embedded: number;
  remaining: number;
  failures: number;
  failure_samples: string[];
  cost_usd: number;
  cost_estimated: boolean;
  stopped: 'preview' | 'complete' | 'limit' | 'aborted' | 'failed';
}

interface PendingFact {
  id: string;
  fact: string;
  version: string;
}

const eligible = `f.source_id = $1 AND ${eligibleFactEmbedding} AND ${staleFactEmbedding}`;

export async function embedStaleFacts(engine: BrainEngine, opts: EmbedFactsOpts, selectedConfig: GBrainConfig | null = null): Promise<EmbedFactsResult> {
  const { signal: externalSignal, assertOwned, ...wireOptions } = opts;
  opts = { ...validateEmbedFactsOptions(wireOptions), signal: externalSignal, assertOwned };
  const maxFacts = opts.maxFacts ?? 100;
  const batchSize = opts.batchSize ?? 100;
  const budgetMs = opts.budgetMs ?? 60_000;
  const dryRun = opts.dryRun === true || opts.yes !== true;
  const verified = currentVerifiedLocalWriter();
  if (verified && (verified.remote || verified.principal.kind !== 'local_cli' || verified.grant.slugPrefixes !== null
    || !verified.grant.sourceIds.includes('*') && !verified.grant.sourceIds.includes(opts.sourceId))) {
    throw new OperationError('permission_denied', 'Fact backfill requires a trusted source-wide CLI grant');
  }
  const [source] = await engine.executeRaw<{ incarnation: string }>(
    'SELECT incarnation::text FROM sources WHERE id=$1 AND archived=false', [opts.sourceId]);
  if (!source) throw new Error('Fact backfill requires an active registered source');
  const authority = verified ? await submissionAuthority({ engine, remote: false, sourceId: opts.sourceId } as OperationContext,
    'submit_job', opts.sourceId, source.incarnation, '__fact_embeddings__') : undefined;
  const authorize = async (target: BrainEngine, lock = false) => {
    if (!authority) return;
    await authorizeWrite(target, authority, 'submit_job', '__fact_embeddings__', lock);
    const [row] = await target.executeRaw<{ unrestricted_slugs: boolean }>(
      `SELECT grant_ceiling->'slugPrefixes' = 'null'::jsonb AS unrestricted_slugs
       FROM persistence_local_writers WHERE id=$1::uuid`, [authority.principal.id]);
    if (row?.unrestricted_slugs !== true) throw new OperationError('permission_denied', 'Fact backfill requires a current source-wide CLI grant');
  };
  await authorize(engine);
  const model = getEmbeddingModel();
  const dims = getEmbeddingDimensions();
  const params = [opts.sourceId, [...AUDIT_ROW_SOURCES], model, dims];
  const census = async () => {
    const [row] = await engine.executeRaw<{ count: string; last_id: string }>(
      `SELECT count(*)::text AS count, COALESCE(max(f.id),0)::text AS last_id FROM facts f WHERE ${eligible}`, params);
    return { count: Number(row.count), lastId: row.last_id };
  };
  const initial = await census();
  const result: EmbedFactsResult = {
    source_id: opts.sourceId, dryRun, total_stale: initial.count,
    would_embed: dryRun ? Math.min(initial.count, maxFacts) : 0,
    attempted: 0, embedded: 0, remaining: initial.count, failures: 0,
    failure_samples: [], cost_usd: 0, cost_estimated: false, stopped: dryRun ? 'preview' : 'complete',
  };
  if (dryRun) return result;
  const assertEnabled = async (target: BrainEngine) => {
    assertEmbeddingEnabled(selectedConfig);
    const disabled = await target.getConfig('embedding_disabled');
    if (disabled !== null && disabled !== 'true' && disabled !== 'false') {
      throw new Error('Selected brain embedding_disabled must be true or false');
    }
    assertEmbeddingEnabled({ embedding_disabled: disabled === 'true' });
  };
  await assertEnabled(engine);
  const shape = await readFactsEmbeddingDim(engine);
  if (!shape.exists || shape.dims !== dims || !shape.columnType) {
    throw new Error('Facts embedding dimensions differ from the configured model; inspect migrate embeddings --status first');
  }
  const dbModel = await engine.getConfig('embedding_model');
  const dbDims = await engine.getConfig('embedding_dimensions');
  if (dbModel !== model || !dbDims || Number(dbDims) !== dims
    || selectedConfig?.embedding_model !== undefined && selectedConfig.embedding_model !== model
    || selectedConfig?.embedding_dimensions !== undefined && selectedConfig.embedding_dimensions !== dims) {
    throw new Error('Embedding configuration differs from the database; finish the reviewed model migration first');
  }
  const tracker = new BudgetTracker({
    label: 'embed.facts', maxCostUsd: opts.maxCostUsd, maxRuntimeMs: budgetMs,
    pricingOverrides: await loadPricingOverrides(engine),
  });
  const signal = AbortSignal.any([AbortSignal.timeout(budgetMs), ...(opts.signal ? [opts.signal] : [])]);
  const maxTokens = resolveMaxChunkTokens();
  let afterId = '0';
  while (result.attempted < maxFacts) {
    if (signal.aborted) { result.stopped = 'aborted'; result.failures++; break; }
    const batch = await engine.executeRaw<PendingFact>(
      `SELECT f.id::text, f.fact, f.xmin::text AS version FROM facts f
       WHERE ${eligible} AND f.id > $5::bigint AND f.id <= $6::bigint
       ORDER BY f.id LIMIT $7`, [...params, afterId, initial.lastId, Math.min(batchSize, maxFacts - result.attempted)]);
    if (!batch.length) break;
    result.attempted += batch.length;
    try {
      if (batch.some(row => estimateTokens(row.fact) > maxTokens)) {
        throw new Error('A fact exceeds the embedding input limit; no batch was sent');
      }
      signal.throwIfAborted();
      const inputCeiling = batch.reduce((sum, row) => sum + Math.max(1, Buffer.byteLength(row.fact, 'utf8')), 0);
      const vectors = await withAIInvocationGuard(async call => {
        signal.throwIfAborted();
        if (call.kind !== 'embedding') throw new Error('Fact backfill permits embedding calls only');
        await assertEnabled(engine);
        await authorize(engine);
        const currentSource = await engine.executeRaw('SELECT id FROM sources WHERE id=$1 AND incarnation=$2::uuid AND archived=false',
          [opts.sourceId, source.incarnation]);
        if (!currentSource.length) throw new Error('Source identity changed during fact backfill; rerun the scoped preview');
        if (await engine.getConfig('embedding_model') !== dbModel || await engine.getConfig('embedding_dimensions') !== dbDims) {
          throw new Error('Embedding model changed during fact backfill; rerun the scoped preview');
        }
        tracker.reserve({ modelId: call.model, kind: 'embed', estimatedInputTokens: inputCeiling, maxOutputTokens: 0 });
        return { settle: async usage => {
          if (!usage) result.cost_estimated = true;
          tracker.record({ modelId: call.model, kind: 'embed', inputTokens: usage?.inputTokens ?? inputCeiling, outputTokens: 0 });
        } };
      }, () => embed(batch.map(row => row.fact), {
        abortSignal: signal, embeddingModel: model, dimensions: dims, inputType: 'document',
      }), { inherit: true });
      signal.throwIfAborted();
      if (vectors.length !== batch.length || vectors.some(vector =>
        vector.length !== dims || !vector.every(Number.isFinite))) {
        throw new Error('Embedding provider returned an incomplete or invalid fact batch');
      }
      const installed = await engine.transaction(async tx => {
        await opts.assertOwned?.(tx);
        const current = await tx.executeRaw('SELECT id FROM sources WHERE id=$1 AND incarnation=$2::uuid AND archived=false FOR SHARE',
          [opts.sourceId, source.incarnation]);
        if (!current.length) throw new Error('Source identity changed during fact backfill; rerun the scoped preview');
        await authorize(tx, true);
        await tx.executeRaw("SELECT key FROM config WHERE key IN ('embedding_model','embedding_dimensions','embedding_disabled') ORDER BY key FOR SHARE");
        await assertEnabled(tx);
        if (await tx.getConfig('embedding_model') !== dbModel || await tx.getConfig('embedding_dimensions') !== dbDims) {
          throw new Error('Embedding model changed during fact backfill; rerun the scoped preview');
        }
        let count = 0;
        for (let i = 0; i < batch.length; i++) {
          signal.throwIfAborted();
          const rows = await tx.executeRaw(
            `UPDATE facts f SET embedding=$7::${shape.columnType}, embedded_at=now(),
             embedding_model=$3,embedded_text_hash=md5(f.fact)
             WHERE ${eligible} AND f.id=$5::bigint AND f.xmin::text=$6 RETURNING f.id::text`,
            [...params, batch[i].id, batch[i].version, `[${Array.from(vectors[i]).join(',')}]`]);
          count += rows.length;
        }
        signal.throwIfAborted();
        return count;
      });
      result.embedded += installed;
      if (installed !== batch.length) {
        result.failures += batch.length - installed;
        result.failure_samples.push('Fact state changed during embedding; changed rows were not overwritten. Rerun the scoped preview.');
        result.stopped = 'failed';
        break;
      }
      afterId = batch[batch.length - 1].id;
    } catch (error) {
      result.failures += batch.length;
      result.failure_samples.push(redactUrlsInText(redactConnectionInfo(
        redactFindings(error instanceof Error ? error.message : String(error), { highEntropy: true }).text,
      )).replace(/\s+/g, ' ').slice(0, 500));
      result.stopped = signal.aborted ? 'aborted' : 'failed';
      break;
    }
  }
  result.cost_usd = tracker.totalSpent;
  result.remaining = (await census()).count;
  if (result.stopped === 'complete' && result.remaining > 0) result.stopped = 'limit';
  return result;
}
