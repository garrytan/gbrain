import type { BrainEngine } from './engine.ts';
import { embed, getEmbeddingDimensions, getEmbeddingModel } from './ai/gateway.ts';
import { withAIInvocationGuard } from './ai/invocation-guard.ts';
import { BudgetExhausted, BudgetTracker, loadPricingOverrides } from './budget/budget-tracker.ts';
import { assertEmbeddingEnabled, readFactsEmbeddingDim } from './embedding-dim-check.ts';
import type { GBrainConfig } from './config.ts';
import { redactConnectionInfo } from './audit/redact-connection-info.ts';
import { redactUrlsInText } from './url-redact.ts';
import { redactFindings } from './secret-scan.ts';
import { currentVerifiedLocalWriter } from './persistence/identity.ts';
import { submissionAuthority, authorizeWrite } from './persistence/authority.ts';
import type { OperationContext } from './ops/contract.ts';
import { OperationError, opError } from './ops/contract.ts';
import { readFix } from './ops/op-fix.ts';
import { validateEmbedFactsOptions, type EmbedFactsOptions } from './embed-facts-options.ts';
import { AUDIT_ROW_SOURCES } from './facts/audit-sources.ts';
import { resolveMaxChunkTokens } from './embedding-input-limit.ts';
import { estimateTokens } from './chunkers/token-estimate.ts';
import { eligibleFactEmbedding, staleFactEmbedding, readOversizedStaleFacts, oversizedFactLine, OVERSIZED_FACT_FIX } from './facts/embedding-identity.ts';

export interface EmbedFactsOpts extends EmbedFactsOptions {
  /** Trusted in-process opt-in only; CLI and owner-proxy wire options retain refusal. */
  oversizedStrategy?: 'refuse' | 'bounded-prefix';
  signal?: AbortSignal;
  assertOwned?: (tx: BrainEngine) => Promise<void>;
  /** Internal full migration: drain the finite census under the migration's lease and signal, with no wall-clock budget. */
  migrationDrain?: { signal: AbortSignal; assertOwned: (tx: BrainEngine) => Promise<void> };
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
  stopped: 'preview' | 'complete' | 'limit' | 'time_budget' | 'aborted' | 'failed';
  /** #7211: stale facts over the embedding input limit; skipped, never sent or truncated, and not counted in `remaining`. */
  refused_oversized: number;
  refused_samples: string[];
  refused_fix?: string;
}

interface PendingFact {
  id: string;
  fact: string;
  version: string;
}

const eligible = `f.source_id = $1 AND ${eligibleFactEmbedding} AND ${staleFactEmbedding}`;

/** #7211: the stderr line a fact run prints when it skipped facts over the embedding input limit. */
export function refusedFactsLine(result: Pick<EmbedFactsResult, 'refused_oversized' | 'refused_samples' | 'refused_fix'>): string | null {
  if (!result.refused_oversized) return null;
  return `[embed] ${result.refused_oversized} fact(s) are longer than the embedding input limit and were skipped, not truncated (first: ${result.refused_samples[0]}). ${result.refused_fix}`;
}

export async function embedStaleFacts(engine: BrainEngine, opts: EmbedFactsOpts, selectedConfig: GBrainConfig | null = null): Promise<EmbedFactsResult> {
  const { signal: externalSignal, assertOwned, migrationDrain, oversizedStrategy = 'refuse', ...wireOptions } = opts;
  if (oversizedStrategy !== 'refuse' && oversizedStrategy !== 'bounded-prefix') {
    throw new Error('Unsupported oversized fact strategy');
  }
  opts = { ...validateEmbedFactsOptions(wireOptions), signal: migrationDrain?.signal ?? externalSignal,
    assertOwned: migrationDrain?.assertOwned ?? assertOwned };
  const batchSize = opts.batchSize ?? 100;
  const budgetMs = migrationDrain ? undefined : opts.budgetMs ?? 60_000;
  const dryRun = opts.dryRun === true || opts.yes !== true;
  const verified = currentVerifiedLocalWriter();
  if (verified && (verified.remote || verified.principal.kind !== 'local_cli' || verified.grant.slugPrefixes !== null
    || !verified.grant.sourceIds.includes('*') && !verified.grant.sourceIds.includes(opts.sourceId))) {
    throw opError('permission_denied', 'Fact backfill requires a trusted source-wide CLI grant',
      `The registered CLI writer cannot repair every fact of source ${opts.sourceId}: fact repair needs the local CLI lane with no slug prefixes and a grant covering that source. Show the grant to the user; widening it (gbrain auth local-writer register cli --replace) is their decision.`,
      { fix: readFix('Shows the local writer registrations and their grants, read-only.', { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'] }) });
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
    if (row?.unrestricted_slugs !== true) throw opError('permission_denied', 'Fact backfill requires a current source-wide CLI grant',
      `The current CLI writer registration has slug prefixes, so it cannot repair every fact of source ${opts.sourceId}. Show the grant to the user; replacing it with an unprefixed grant is their decision.`,
      { fix: readFix('Shows the local writer registrations and their grants, read-only.', { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'] }) });
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
  const maxFacts = migrationDrain ? initial.count : opts.maxFacts ?? 100;
  const maxTokens = resolveMaxChunkTokens();
  const refused = async () => {
    if (oversizedStrategy === 'bounded-prefix') return 0;
    const rows = await readOversizedStaleFacts(engine, { sourceId: opts.sourceId, model, dims, maxTokens });
    result.refused_oversized = rows.length;
    result.refused_samples = rows.slice(0, 5).map(row => oversizedFactLine(row, maxTokens));
    if (rows.length) result.refused_fix = OVERSIZED_FACT_FIX;
    else delete result.refused_fix;
    return rows.length;
  };
  const result: EmbedFactsResult = {
    source_id: opts.sourceId, dryRun, total_stale: initial.count, would_embed: 0,
    attempted: 0, embedded: 0, remaining: initial.count, failures: 0,
    failure_samples: [], cost_usd: 0, cost_estimated: false, stopped: dryRun ? 'preview' : 'complete',
    refused_oversized: 0, refused_samples: [],
  };
  if (dryRun) {
    result.remaining = initial.count - await refused();
    result.would_embed = Math.min(result.remaining, maxFacts);
    return result;
  }
  const assertEnabled = async (target: BrainEngine) => {
    assertEmbeddingEnabled(selectedConfig);
    const disabled = await target.getConfig('embedding_disabled');
    if (disabled !== null && disabled !== 'true' && disabled !== 'false') {
      throw new Error('Selected brain embedding_disabled must be true or false');
    }
    assertEmbeddingEnabled({ engine: target.kind, ...selectedConfig, embedding_disabled: disabled === 'true' });
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
  const budgetTimer = budgetMs === undefined ? null : AbortSignal.timeout(budgetMs);
  const signal = AbortSignal.any([...(budgetTimer ? [budgetTimer] : []), ...(opts.signal ? [opts.signal] : [])]);
  const budgetStop = (error?: unknown) => opts.signal?.aborted !== true
    && (budgetTimer?.aborted === true || error instanceof BudgetExhausted && error.reason === 'runtime');
  let afterId = '0';
  while (result.attempted < maxFacts) {
    if (budgetStop()) { result.stopped = 'time_budget'; break; }
    if (signal.aborted) { result.stopped = 'aborted'; result.failures++; break; }
    const batch = await engine.executeRaw<PendingFact>(
      `SELECT f.id::text, f.fact, f.xmin::text AS version FROM facts f
       WHERE ${eligible} AND f.id > $5::bigint AND f.id <= $6::bigint
       ORDER BY f.id LIMIT $7`, [...params, afterId, initial.lastId, Math.min(batchSize, maxFacts - result.attempted)]);
    if (!batch.length) break;
    const lastId = batch[batch.length - 1].id;
    const fitting = batch.filter(row => oversizedStrategy === 'bounded-prefix' || estimateTokens(row.fact) <= maxTokens);
    // The retrieval input is separate from canonical text and its CAS/hash identity.
    // A UTF-8 byte bound is conservative for token estimation, including astral text.
    const inputs = fitting.map(row => {
      if (estimateTokens(row.fact) <= maxTokens) return row.fact;
      let prefix = '';
      let bytes = 0;
      for (const point of row.fact) {
        const size = Buffer.byteLength(point, 'utf8');
        if (bytes + size > maxTokens) break;
        prefix += point;
        bytes += size;
      }
      return prefix;
    });
    if (!fitting.length) { afterId = lastId; continue; }
    result.attempted += fitting.length;
    try {
      signal.throwIfAborted();
      const inputCeiling = inputs.reduce((sum, input) => sum + Math.max(1, Buffer.byteLength(input, 'utf8')), 0);
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
        const reservation = tracker.reserve({ modelId: call.model, kind: 'embed', estimatedInputTokens: inputCeiling, maxOutputTokens: 0 });
        return { settle: async usage => {
          if (!usage) result.cost_estimated = true;
          tracker.record({ modelId: call.model, reservation, kind: 'embed', inputTokens: usage?.inputTokens ?? inputCeiling, outputTokens: 0 });
        } };
      }, () => embed(inputs, {
        abortSignal: signal, embeddingModel: model, dimensions: dims, inputType: 'document',
      }), { inherit: true });
      signal.throwIfAborted();
      if (vectors.length !== fitting.length || vectors.some(vector =>
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
        const partialIds: string[] = [];
        for (let i = 0; i < fitting.length; i++) {
          signal.throwIfAborted();
          const rows = await tx.executeRaw(
            `UPDATE facts f SET embedding=$7::${shape.columnType}, embedded_at=now(),
             embedding_model=$3,embedded_text_hash=md5(f.fact)
             WHERE ${eligible} AND f.id=$5::bigint AND f.xmin::text=$6 RETURNING f.id::text`,
            [...params, fitting[i].id, fitting[i].version, `[${Array.from(vectors[i]).join(',')}]`]);
          count += rows.length;
          if (rows.length && inputs[i] !== fitting[i].fact) partialIds.push(fitting[i].id);
        }
        signal.throwIfAborted();
        return { count, partialIds };
      });
      for (const id of installed.partialIds) {
        console.error(`[embed] fact ${id} (source ${opts.sourceId}): partial retrieval representation (bounded-prefix); full stored text retained.`);
      }
      result.embedded += installed.count;
      if (installed.count !== fitting.length) {
        result.failures += fitting.length - installed.count;
        result.failure_samples.push('Fact state changed during embedding; changed rows were not overwritten. Rerun the scoped preview.');
        result.stopped = 'failed';
        break;
      }
      afterId = lastId;
    } catch (error) {
      if (budgetStop(error)) { result.stopped = 'time_budget'; break; }
      result.failures += fitting.length;
      result.failure_samples.push(redactUrlsInText(redactConnectionInfo(
        redactFindings(error instanceof Error ? error.message : String(error), { highEntropy: true }).text,
      )).replace(/\s+/g, ' ').slice(0, 500));
      result.stopped = signal.aborted ? 'aborted' : 'failed';
      break;
    }
  }
  result.cost_usd = tracker.totalSpent;
  result.remaining = (await census()).count - await refused();
  if (result.stopped === 'complete' && result.remaining > 0) result.stopped = 'limit';
  return result;
}
