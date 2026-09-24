import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import { setOwnerBudget } from '../minions/budget-tracker.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { safeChunksFilter, currentTextProjectionFilter } from '../search/safe-chunks.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { MEMORY_CUE_PROMPT_VERSION, MEMORY_CUE_SOURCE_LIMIT, type MemoryCueBuildOptions, type MemoryCueBuildReceipt } from './types.ts';
import { loadMemoryCueSettings, memoryCueColumn, cueSignature, unsupportedCueColumn, missingCueSchema } from './settings.ts';
import { provisionCueIndex, cueSnapshotSql, cueIndexExists } from './storage.ts';
import { cueGenerationModel } from './providers.ts';
import { formatCueEvidence } from './evidence.ts';
import { canonicalLookup } from '../model-pricing.ts';
import { lookupEmbeddingPrice } from '../embedding-pricing.ts';
import { maximumInvocationCents } from '../minions/delegated-spend.ts';
import { loadConfig } from '../config.ts';
import { assertEmbeddingEnabled } from '../embedding-dim-check.ts';
import { MAX_CUE_WINDOW_BYTES } from './windows.ts';

export interface CueBuildRow {
  id: string;
  owner_job_id: number | null;
  owner_identity: number;
  source_ids: string[];
  source_incarnations: Record<string, string>;
  signature: string;
  generation_model: string;
  prompt_version: string;
  page_limit: number;
  window_limit: number;
  include_bridge: boolean;
  status: string;
  reason: string | null;
  execution_token: string | null;
  lease_until: Date | string | null;
}

function bounds(opts: MemoryCueBuildOptions): Required<MemoryCueBuildOptions> {
  if (!Array.isArray(opts.sourceIds) || !opts.sourceIds.length || opts.sourceIds.length > MEMORY_CUE_SOURCE_LIMIT
    || opts.sourceIds.some(s => typeof s !== 'string' || !s || s.length > 200)) throw new Error('explicit_sources_required');
  const pageLimit = opts.pageLimit ?? 100;
  const windowLimit = opts.windowLimit ?? 8;
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 1000 || !Number.isInteger(windowLimit) || windowLimit < 1 || windowLimit > 8) throw new Error('invalid_build_limits');
  return { sourceIds: [...new Set(opts.sourceIds)], pageLimit, windowLimit, includeBridge: opts.includeBridge === true };
}

function trusted(opts: { trustedLocal: true }): void {
  if (opts.trustedLocal !== true || (currentSubmissionAuthority() && currentSubmissionAuthority()!.kind !== 'application')) throw new Error('trusted_local_required');
}

function eligiblePages(sourceIds: string[], params: unknown[]): string {
  return `${pageReadFilter('p', { sourceIds }, params, true)} AND ${safeChunksFilter('p')} AND ${currentTextProjectionFilter('p')}
    AND COALESCE(p.frontmatter->>'status','') NOT IN ('withdrawn','superseded')`;
}

export async function previewMemoryCueBuild(engine: BrainEngine, opts: MemoryCueBuildOptions) {
  const limits = bounds(opts);
  const settings = await loadMemoryCueSettings(engine);
  const column = await memoryCueColumn(engine);
  const generationModel = await cueGenerationModel(engine);
  const sources = await engine.executeRaw<{ id: string; incarnation: string }>('SELECT id,incarnation FROM sources WHERE id=ANY($1::text[]) AND NOT archived', [limits.sourceIds]);
  const params: unknown[] = [];
  const policy = eligiblePages(limits.sourceIds, params);
  params.push(limits.pageLimit);
  const pages = await engine.executeRaw<{ id: number }>(`SELECT p.id FROM pages p WHERE ${policy} ORDER BY p.id LIMIT $${params.length}`, params);
  const reason = !settings.generationEnabled ? 'generation_disabled' : loadConfig()?.embedding_disabled ? 'embedding_disabled' : limits.sourceIds.some(s => !settings.sourceIds.includes(s)) ? 'source_not_enrolled'
    : sources.length !== limits.sourceIds.length ? 'source_unavailable' : unsupportedCueColumn(column)
      ?? (!canonicalLookup(generationModel) || lookupEmbeddingPrice(column.embeddingModel).kind !== 'known' ? 'pricing_unknown' : undefined);
  const chatCents = maximumInvocationCents({ operation: 'memory-cues-preview', kind: 'chat', model: generationModel,
    maxInputTokens: formatCueEvidence('', limits.includeBridge).maximumInputTokenCeiling, maxOutputTokens: 1200 });
  const embeddingCents = maximumInvocationCents({ operation: 'memory-cues-preview', kind: 'embedding', model: column.embeddingModel,
    maxInputTokens: 4096, maxOutputTokens: 0 });
  const perWindow = chatCents === null || embeddingCents === null ? null : (Math.max(1, Math.ceil(chatCents)) + Math.max(1, Math.ceil(embeddingCents))) / 100;
  return { ...limits, eligiblePages: pages.length, signature: cueSignature(column), embeddingColumn: column, generationModel,
    ready: !reason, ...(reason ? { reason } : {}), sourceIncarnations: Object.fromEntries(sources.map(s => [s.id, s.incarnation])),
    costPreview: { maximumReservationUsdPerWindow: perWindow, maximumReservationUsdPerPass: perWindow === null ? null : perWindow * limits.windowLimit,
      maxWindowsPerPass: limits.windowLimit, assumptions: `Upper reservation bound, not measured cost: ${MAX_CUE_WINDOW_BYTES}-byte evidence with worst-case JSON escaping, 1200 output tokens, four 240-character cues; unknown calls retain their reservation. Retries consume the original cap.` } };
}

export async function submitMemoryCueBuild(engine: BrainEngine, opts: MemoryCueBuildOptions & { trustedLocal: true; maxUsd: number }): Promise<MemoryCueBuildReceipt> {
  trusted(opts);
  if (!Number.isFinite(opts.maxUsd) || opts.maxUsd < 0.01 || opts.maxUsd > 10000) throw new Error('explicit_budget_required');
  const preview = await previewMemoryCueBuild(engine, opts);
  if (!preview.ready) throw new Error(preview.reason);
  await provisionCueIndex(engine, preview.embeddingColumn);
  const buildId = randomUUID();
  return engine.transaction(async tx => {
    const job = await new MinionQueue(tx).add('memory-cues-build', { buildId }, { max_attempts: 1, timeout_ms: 600000, lock_duration_ms: 120000, coalesce_params: false }, { allowProtectedSubmit: true });
    await setOwnerBudget(tx, job.id, Math.floor(opts.maxUsd * 100) / 100);
    await tx.executeRaw(`INSERT INTO memory_cue_builds(id,owner_job_id,owner_identity,source_ids,source_incarnations,signature,generation_model,prompt_version,max_usd,page_limit,window_limit,include_bridge)
      VALUES($1::uuid,$2,$2,$3::text[],$4::text::jsonb,$5,$6,$7,$8,$9,$10,$11)`,
    [buildId, job.id, preview.sourceIds, JSON.stringify(preview.sourceIncarnations), preview.signature, preview.generationModel, MEMORY_CUE_PROMPT_VERSION, opts.maxUsd, preview.pageLimit, preview.windowLimit, preview.includeBridge]);
    const pageParams: unknown[] = [buildId];
    const pagePolicy = eligiblePages(preview.sourceIds, pageParams);
    pageParams.push(preview.pageLimit);
    await tx.executeRaw(`INSERT INTO memory_cue_pages(build_id,page_id) SELECT $1::uuid,p.id FROM pages p WHERE ${pagePolicy}
      ORDER BY p.id LIMIT $${pageParams.length}`, pageParams);
    return { buildId, jobId: job.id, budgetOwnerJobId: job.id, status: 'queued' };
  });
}

export async function enqueueCueBuild(engine: BrainEngine, build: CueBuildRow): Promise<MemoryCueBuildReceipt> {
  const job = await new MinionQueue(engine).add('memory-cues-build', { buildId: build.id, pass: randomUUID() },
    { max_attempts: 1, timeout_ms: 600000, lock_duration_ms: 120000, coalesce_params: false }, { allowProtectedSubmit: true });
  await engine.executeRaw(`UPDATE minion_jobs SET budget_owner_job_id=$2,budget_root_owner_id=$2 WHERE id=$1`, [job.id, build.owner_identity]);
  return { buildId: build.id, jobId: job.id, budgetOwnerJobId: build.owner_identity, status: 'queued' };
}

export async function cancelMemoryCueBuild(engine: BrainEngine, opts: { buildId: string; trustedLocal: true }): Promise<void> {
  trusted(opts);
  await engine.executeRaw("UPDATE memory_cue_builds SET status='cancelled',reason='cancelled',execution_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1::uuid", [opts.buildId]);
}

export async function resumeMemoryCueBuild(engine: BrainEngine, opts: { buildId: string; trustedLocal: true }): Promise<MemoryCueBuildReceipt> {
  trusted(opts);
  return engine.transaction(async tx => {
    const [build] = await tx.executeRaw<CueBuildRow>('SELECT * FROM memory_cue_builds WHERE id=$1::uuid FOR UPDATE', [opts.buildId]);
    if (!build) throw new Error('build_missing');
    if (build.status === 'running' && build.lease_until && new Date(build.lease_until).getTime() > Date.now()) throw new Error('build_busy');
    await assertCueBuildAuthority(tx, build);
    await tx.executeRaw("UPDATE memory_cue_builds SET status='queued',reason=NULL WHERE id=$1::uuid", [opts.buildId]);
    return enqueueCueBuild(tx, build);
  });
}

export async function assertCueBuildAuthority(engine: BrainEngine, build: CueBuildRow, token?: string): Promise<void> {
  assertEmbeddingEnabled(loadConfig());
  await engine.executeRaw("SELECT key FROM config WHERE key LIKE 'memory.cues.%' OR key IN ('embedding_model','embedding_dimensions','embedding_columns','search_embedding_column','chat_model') ORDER BY key FOR SHARE");
  const settings = await loadMemoryCueSettings(engine);
  if (!settings.generationEnabled || build.source_ids.some(s => !settings.sourceIds.includes(s))) throw new Error('consent_revoked');
  if (build.signature !== cueSignature(await memoryCueColumn(engine)) || build.generation_model !== await cueGenerationModel(engine)
    || build.prompt_version !== MEMORY_CUE_PROMPT_VERSION) throw new Error('model_changed');
  const sources = await engine.executeRaw<{ id: string; incarnation: string }>('SELECT id,incarnation FROM sources WHERE id=ANY($1::text[]) AND NOT archived FOR SHARE', [build.source_ids]);
  if (sources.length !== build.source_ids.length || sources.some(s => build.source_incarnations[s.id] !== s.incarnation)) throw new Error('source_changed');
  const [owner] = await engine.executeRaw<{ budget_remaining_cents: number; status: string }>('SELECT budget_remaining_cents,status FROM minion_jobs WHERE id=$1 AND budget_root_owner_id=$1', [build.owner_identity]);
  if (!build.owner_job_id || !owner || owner.budget_remaining_cents === null) throw new Error('budget_owner_missing');
  if (token) {
    const [current] = await engine.executeRaw('SELECT id FROM memory_cue_builds WHERE id=$1::uuid AND execution_token=$2::uuid AND status=\'running\' AND lease_until>now()', [build.id, token]);
    if (!current || owner.status === 'cancelled') throw new Error('cancelled');
  }
}

export async function getMemoryCueStatus(engine: BrainEngine, opts: { sourceIds?: string[]; buildId?: string } = {}) {
  const settings = await loadMemoryCueSettings(engine);
  const column = await memoryCueColumn(engine);
  const signature = cueSignature(column);
  const generationModel = await cueGenerationModel(engine);
  const sourceIds = opts.sourceIds ?? settings.sourceIds;
  try {
    const builds = await engine.executeRaw<{ build_id: string; budget_owner_job_id: number; status: string; reason: string | null; max_usd: number; remaining_cents: number | null }>(`SELECT b.id AS build_id,b.owner_identity AS budget_owner_job_id,b.status,b.reason,b.max_usd,j.budget_remaining_cents AS remaining_cents
      FROM memory_cue_builds b LEFT JOIN minion_jobs j ON j.id=b.owner_job_id WHERE b.source_ids <@ $1::text[] AND ($2::uuid IS NULL OR b.id=$2::uuid) ORDER BY b.created_at DESC LIMIT 100`, [sourceIds, opts.buildId ?? null]);
    const coverageParams: unknown[] = [sourceIds, signature, MEMORY_CUE_PROMPT_VERSION, opts.buildId ?? null, generationModel];
    const currentPages = eligiblePages(sourceIds, coverageParams);
    const coverage = await engine.executeRaw<{ status: string; count: number }>(`SELECT CASE WHEN NOT (${currentPages})
      OR w.source_incarnation IS DISTINCT FROM (SELECT incarnation FROM sources WHERE id=p.source_id)
      OR w.revision IS DISTINCT FROM p.knowledge_revision OR w.snapshot IS DISTINCT FROM ${cueSnapshotSql}
      OR w.signature<>$2 OR w.prompt_version<>$3 OR w.generation_model<>$5 THEN 'stale' ELSE w.status END AS status,count(*)::int AS count
      FROM memory_cue_windows w JOIN pages p ON p.id=w.page_id WHERE p.source_id=ANY($1::text[]) AND ($4::uuid IS NULL OR w.build_id=$4::uuid) GROUP BY 1`, coverageParams);
    const pending = await engine.executeRaw<{ count: number; failed: number }>(`SELECT COALESCE(sum(GREATEST(cp.total_windows-cp.cursor,1)),0)::int AS count,
      count(*) FILTER (WHERE cp.reason IS NOT NULL)::int AS failed FROM memory_cue_pages cp JOIN pages p ON p.id=cp.page_id
      WHERE p.source_id=ANY($1::text[]) AND cp.status<>'complete' AND ($2::uuid IS NULL OR cp.build_id=$2::uuid)`, [sourceIds, opts.buildId ?? null]);
    if (pending[0]?.failed) coverage.push({ status: 'failed', count: pending[0].failed });
    return { settings, signature, generationModel, supported: !unsupportedCueColumn(column), indexReady: await cueIndexExists(engine, signature), reason: unsupportedCueColumn(column), builds, coverage, windowsPending: pending[0]?.count ?? 0 };
  } catch (error) {
    if (missingCueSchema(error)) return { settings, signature, generationModel, supported: false, indexReady: false, reason: 'schema_missing', builds: [], coverage: [], windowsPending: 0 };
    throw error;
  }
}
