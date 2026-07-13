// admin-console.ts — Facade entry point for the admin dashboard backend.
//
// This file re-exports the natural-language task module and retains the
// Dashboard / knowledge-base browsing and configuration helpers.
//
// New feature modules should be placed under ./<module-name>/ and re-exported
// here so that serve-http.ts imports remain stable.

import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { join } from 'path';
import { isSensitiveConfigKey, redactConfigValue } from './config.ts';
import { loadAllSources, isSourceFederated } from '../core/sources-load.ts';
import { resolveMainSourceId } from '../core/source-resolver.ts';
import { ALL_PHASES } from '../core/cycle.ts';
import { listRuns } from './natural-lang/index.ts';

async function getSupervisorStatus(): Promise<{
  running: boolean;
  supervisor_pid: number | null;
  pid_file: string;
  mode: 'supervisor' | 'direct-worker' | 'none';
}> {
  const [{ DEFAULT_PID_FILE }, { existsSync, readFileSync }] = await Promise.all([
    import('../core/minions/supervisor.ts'),
    import('fs'),
  ]);
  let supervisorPid: number | null = null;
  let running = false;
  if (existsSync(DEFAULT_PID_FILE)) {
    try {
      const line = readFileSync(DEFAULT_PID_FILE, 'utf8').trim().split('\n')[0];
      const parsed = parseInt(line ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        supervisorPid = parsed;
        try {
          process.kill(parsed, 0);
          running = true;
        } catch {
          running = false;
        }
      }
    } catch {
      supervisorPid = null;
      running = false;
    }
  }
  if (running) return { running, supervisor_pid: supervisorPid, pid_file: DEFAULT_PID_FILE, mode: 'supervisor' };

  const directPidFile = join(process.cwd(), '.gbrain', 'admin-worker.pid');
  if (existsSync(directPidFile)) {
    try {
      const line = readFileSync(directPidFile, 'utf8').trim().split('\n')[0];
      const parsed = parseInt(line ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        supervisorPid = parsed;
        try {
          process.kill(parsed, 0);
          return { running: true, supervisor_pid: supervisorPid, pid_file: directPidFile, mode: 'direct-worker' };
        } catch {
          // stale direct worker pid file; report stopped below.
        }
      }
    } catch {
      // unreadable direct worker pid file; report stopped below.
    }
  }
  return { running: false, supervisor_pid: supervisorPid, pid_file: directPidFile, mode: 'none' };
}

// ---------------------------------------------------------------------------
// Facade: re-export natural-language task module
// ---------------------------------------------------------------------------

export * from './natural-lang/index.ts';

// ---------------------------------------------------------------------------
// Dashboard / knowledge-base browsing
// ---------------------------------------------------------------------------

function redactedConfig(config: GBrainConfig | null): Record<string, unknown> {
  if (!config) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      out[key] = redactConfigValue(key, value);
    } else if (isSensitiveConfigKey(key)) {
      out[key] = '***';
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function getAdminBrainOverview(engine: BrainEngine, config: GBrainConfig | null, version: string) {
  const [stats, sources, mainSourceId] = await Promise.all([
    engine.getStats(),
    loadAllSources(engine, { includeArchived: true }),
    resolveMainSourceId(engine),
  ]);

  const sourceRows = await Promise.all(sources.map(async (source) => {
    const [count] = await engine.executeRaw<{ page_count: number }>(
      `SELECT COUNT(*)::int AS page_count FROM pages WHERE source_id = $1`,
      [source.id],
    );
    const [archive] = await engine.executeRaw<{ archived_at: string | null; archive_expires_at: string | null }>(
      `SELECT archived_at::text, archive_expires_at::text FROM sources WHERE id = $1`,
      [source.id],
    );
    return {
      id: source.id,
      name: source.name,
      local_path: source.local_path,
      federated: isSourceFederated(source.config),
      page_count: count?.page_count ?? 0,
      last_sync_at: source.last_sync_at ? new Date(source.last_sync_at).toISOString() : null,
      archived: source.archived === true,
      archived_at: archive?.archived_at ?? null,
      archive_expires_at: archive?.archive_expires_at ?? null,
    };
  }));

  const [recentWrite] = await engine.executeRaw<{ updated_at: string | null }>(
    `SELECT MAX(updated_at)::text AS updated_at FROM pages`,
  );
  const [pendingEmbed] = await engine.executeRaw<{ pending: number }>(
    `SELECT COUNT(*)::int AS pending
       FROM content_chunks
      WHERE embedding IS NULL`,
  );

  const embedded = stats.embedded_count ?? 0;
  const chunks = stats.chunk_count ?? 0;
  const coverage = chunks > 0 ? Math.round((embedded / chunks) * 1000) / 10 : 100;
  const providerStatus = getProviderStatus(config);

  return {
    version,
    engine: config?.engine ?? 'unknown',
    schema_pack: config?.schema_pack ?? 'gbrain-base',
    chat_model: config?.chat_model ?? null,
    embedding_model: config?.embedding_model ?? null,
    embedding_dimensions: config?.embedding_dimensions ?? null,
    expansion_model: config?.expansion_model ?? null,
    stats,
    embedding_coverage: coverage,
    pending_embeddings: pendingEmbed?.pending ?? Math.max(0, chunks - embedded),
    recent_write_at: recentWrite?.updated_at ?? null,
    sources: sourceRows,
    main_source_id: mainSourceId,
    federated_source_count: sourceRows.filter(s => s.federated).length,
    provider_status: providerStatus,
    llm_enabled: providerStatus.chat.enabled,
    config: redactedConfig(config),
  };
}

export async function listAdminBrainPages(
  engine: BrainEngine,
  query: { source?: string; type?: string; view?: string; q?: string; embedded?: string; page?: string; limit?: string },
) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const requestedLimit = Number.parseInt(query.limit ?? '10', 10) || 10;
  const limit = [10, 20, 40].includes(requestedLimit) ? requestedLimit : 10;
  const offset = (page - 1) * limit;
  const isTrash = query.view === 'trash';
  const filters: string[] = [isTrash ? 'p.deleted_at IS NOT NULL' : 'p.deleted_at IS NULL'];
  const params: (string | number)[] = [];

  if (query.source && query.source !== 'all') {
    params.push(query.source);
    filters.push(`p.source_id = $${params.length}`);
  }
  if (query.type && query.type !== 'all') {
    params.push(query.type);
    filters.push(`p.type = $${params.length}`);
  }
  const viewTypes: Record<string, string[]> = {
    materials: ['material', 'reference', 'source', 'conversation', 'meeting', 'note', 'cover'],
    structured: ['atom', 'fact', 'concept'],
    insights: ['take', 'original', 'originals', 'reflection', 'pattern'],
  };
  const selectedViewTypes = query.view ? viewTypes[query.view] : undefined;
  if (selectedViewTypes) {
    const placeholders = selectedViewTypes.map(value => {
      params.push(value);
      return `$${params.length}`;
    });
    filters.push(`p.type IN (${placeholders.join(', ')})`);
  }
  if (query.q) {
    params.push(`%${query.q}%`);
    filters.push(`(p.slug ILIKE $${params.length} OR p.title ILIKE $${params.length})`);
  }
  if (query.embedded === 'yes') {
    filters.push(`COALESCE(cc.embedded_chunks, 0) = COALESCE(cc.chunk_count, 0) AND COALESCE(cc.chunk_count, 0) > 0`);
  } else if (query.embedded === 'no') {
    filters.push(`COALESCE(cc.embedded_chunks, 0) < COALESCE(cc.chunk_count, 0)`);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const baseSql = `
    FROM pages p
    LEFT JOIN (
      SELECT page_id,
             COUNT(*)::int AS chunk_count,
             COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded_chunks
        FROM content_chunks
       GROUP BY page_id
    ) cc ON cc.page_id = p.id
    ${where}
  `;

  const rows = await engine.executeRaw<{
    id: number;
    slug: string;
    title: string | null;
    source_id: string;
    type: string;
    updated_at: string;
    deleted_at: string | null;
    chunk_count: number;
    embedded_chunks: number;
    tag_count: number;
    frontmatter: unknown;
    preview: string;
  }>(
    `SELECT p.id, p.slug, p.title, p.source_id, p.type, p.updated_at::text AS updated_at,
            p.deleted_at::text AS deleted_at,
            COALESCE(cc.chunk_count, 0)::int AS chunk_count,
            COALESCE(cc.embedded_chunks, 0)::int AS embedded_chunks,
            (SELECT COUNT(*)::int FROM tags t WHERE t.page_id = p.id) AS tag_count,
            p.frontmatter,
            LEFT(p.compiled_truth, 8000) AS preview
       ${baseSql}
      ORDER BY ${isTrash ? 'p.deleted_at' : 'p.updated_at'} DESC, p.slug
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const [count] = await engine.executeRaw<{ total: number }>(
    `SELECT COUNT(*)::int AS total ${baseSql}`,
    params,
  );

  return {
    rows,
    total: count?.total ?? 0,
    page,
    limit,
    pages: Math.max(1, Math.ceil((count?.total ?? 0) / limit)),
  };
}

export async function getAdminBrainPageDetail(engine: BrainEngine, sourceId: string, slug: string, includeDeleted = false) {
  const rows = await engine.executeRaw<{
    id: number;
    slug: string;
    title: string;
    source_id: string;
    source_name: string | null;
    source_path: string | null;
    type: string;
    page_kind: string;
    compiled_truth: string;
    timeline: string;
    frontmatter: unknown;
    source_kind: string | null;
    source_uri: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT p.id, p.slug, p.title, p.source_id, s.name AS source_name, s.local_path AS source_path,
            p.type, p.page_kind, p.compiled_truth, p.timeline, p.frontmatter,
            p.source_kind, p.source_uri, p.created_at::text AS created_at, p.updated_at::text AS updated_at
       FROM pages p
       JOIN sources s ON s.id = p.source_id
      WHERE p.source_id = $1 AND p.slug = $2 ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
      LIMIT 1`,
    [sourceId, slug],
  );
  const page = rows[0];
  if (!page) return null;
  const takes = await engine.executeRaw<{
    row_num: number;
    claim: string;
    kind: string;
    holder: string;
    weight: number;
    source: string | null;
  }>(
    `SELECT row_num::int AS row_num, claim, kind, holder, weight, source
       FROM takes
      WHERE page_id = $1 AND active = TRUE
      ORDER BY row_num ASC`,
    [page.id],
  );
  return { ...page, takes };
}

export async function getAdminBrainPageChunks(engine: BrainEngine, sourceId: string, slug: string, includeDeleted = false) {
  const rows = await engine.executeRaw<{
    id: number;
    chunk_index: number;
    chunk_text: string;
    chunk_source: string;
    token_count: number | null;
    embedded: boolean;
  }>(
    `SELECT c.id,
            c.chunk_index::int AS chunk_index,
            c.chunk_text,
            c.chunk_source,
            c.token_count::int AS token_count,
            (c.embedding IS NOT NULL) AS embedded
       FROM pages p
       JOIN content_chunks c ON c.page_id = p.id
      WHERE p.source_id = $1
        AND p.slug = $2
        ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
      ORDER BY c.chunk_index ASC`,
    [sourceId, slug],
  );

  return { rows };
}

// ---------------------------------------------------------------------------
// Dream workbench aggregate
// ---------------------------------------------------------------------------

async function optionalRows<T>(
  engine: BrainEngine,
  sql: string,
  params: Array<string | number | boolean | null> = [],
): Promise<T[]> {
  try {
    return await engine.executeRaw<T>(sql, params);
  } catch {
    return [];
  }
}

async function optionalOne<T>(
  engine: BrainEngine,
  sql: string,
  params: Array<string | number | boolean | null> = [],
): Promise<T | null> {
  const rows = await optionalRows<T>(engine, sql, params);
  return rows[0] ?? null;
}

export async function getAdminDreamOverview(engine: BrainEngine, config: GBrainConfig | null, version: string) {
  const [overview, healthResult] = await Promise.allSettled([
    getAdminBrainOverview(engine, config, version),
    engine.getHealth(),
  ]);
  const overviewValue = overview.status === 'fulfilled' ? overview.value : null;
  const health = healthResult.status === 'fulfilled' ? healthResult.value : null;

  const [
    locks,
    proposalStatus,
    takeSummary,
    gradeSummary,
    latestCalibration,
    calibrationHistory,
    embeddingBySource,
    topWeightedPages,
    knowledgeTypes,
    ingestSummary,
    lifecycleSummary,
    recentJobs,
    jobStatus,
    subagentStatus,
    stalledQueue,
    supervisorStatus,
    qualityRuns,
    contradictionRuns,
  ] = await Promise.all([
    optionalRows(engine, `
      SELECT id,
             holder_pid::int AS holder_pid,
             holder_host,
             acquired_at::text AS acquired_at,
             ttl_expires_at::text AS ttl_expires_at,
             last_refreshed_at::text AS last_refreshed_at,
             (ttl_expires_at > now()) AS active
        FROM gbrain_cycle_locks
       ORDER BY ttl_expires_at DESC
       LIMIT 5
    `),
    optionalRows(engine, `
      SELECT status, COUNT(*)::int AS count
        FROM take_proposals
       GROUP BY status
       ORDER BY status
    `),
    optionalOne(engine, `
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE active)::int AS active,
             COUNT(*) FILTER (WHERE active AND resolved_at IS NOT NULL)::int AS resolved,
             COUNT(*) FILTER (WHERE active AND resolved_at IS NULL)::int AS unresolved,
             COUNT(*) FILTER (WHERE active AND embedding IS NOT NULL)::int AS embedded,
             COALESCE(AVG(weight) FILTER (WHERE active), 0)::float AS avg_weight,
             COALESCE(MAX(weight) FILTER (WHERE active), 0)::float AS max_weight
        FROM takes
    `),
    optionalOne(engine, `
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE applied)::int AS applied,
             COALESCE(AVG(confidence), 0)::float AS avg_confidence,
             MAX(graded_at)::text AS latest_graded_at
        FROM take_grade_cache
    `),
    optionalOne(engine, `
      SELECT source_id,
             holder,
             generated_at::text AS generated_at,
             total_resolved::int AS total_resolved,
             brier,
             accuracy,
             partial_rate,
             grade_completion,
             active_bias_tags,
             voice_gate_passed,
             voice_gate_attempts::int AS voice_gate_attempts,
             model_id
        FROM calibration_profiles
       ORDER BY generated_at DESC
       LIMIT 1
    `),
    optionalRows(engine, `
      SELECT id::int AS id,
             source_id,
             holder,
             generated_at::text AS generated_at,
             total_resolved::int AS total_resolved,
             brier,
             accuracy,
             grade_completion
        FROM calibration_profiles
       ORDER BY generated_at DESC
       LIMIT 8
    `),
    optionalRows(engine, `
      SELECT p.source_id,
             COUNT(c.id)::int AS chunks,
             COUNT(c.id) FILTER (WHERE c.embedding IS NOT NULL)::int AS embedded,
             COUNT(c.id) FILTER (WHERE c.embedding IS NULL)::int AS pending
        FROM pages p
        LEFT JOIN content_chunks c ON c.page_id = p.id
       WHERE p.deleted_at IS NULL
       GROUP BY p.source_id
       ORDER BY pending DESC, chunks DESC
       LIMIT 20
    `),
    optionalRows(engine, `
      SELECT source_id,
             slug,
             title,
             type,
             emotional_weight,
             updated_at::text AS updated_at
        FROM pages
       WHERE deleted_at IS NULL
       ORDER BY emotional_weight DESC, updated_at DESC
       LIMIT 12
    `),
    optionalRows(engine, `
      SELECT type, COUNT(*)::int AS count
        FROM pages
       WHERE deleted_at IS NULL
       GROUP BY type
       ORDER BY count DESC
       LIMIT 24
    `),
    optionalOne(engine, `
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h,
             MAX(created_at)::text AS latest_at
        FROM ingest_log
    `),
    optionalOne(engine, `
      SELECT COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS soft_deleted_pages,
             COUNT(*) FILTER (WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '72 hours')::int AS purge_ready_pages,
             (SELECT COUNT(*)::int FROM sources WHERE archived = true) AS archived_sources,
             (SELECT COUNT(*)::int FROM links l LEFT JOIN pages p ON p.id = l.to_page_id WHERE p.id IS NULL) AS dead_links
        FROM pages
    `),
    optionalRows(engine, `
      SELECT id::int AS id,
             name,
             queue,
             status,
             attempts_made::int AS attempts_made,
             max_attempts::int AS max_attempts,
             created_at::text AS created_at,
             updated_at::text AS updated_at,
             error_text
        FROM minion_jobs
       WHERE name IN ('subagent','autopilot-cycle','embed-backfill','sync','extract','project-health','risk-detect','report-gen')
          OR name LIKE '%dream%'
          OR name LIKE '%project%'
          OR name LIKE '%risk%'
       ORDER BY updated_at DESC
       LIMIT 20
    `),
    optionalRows(engine, `
      SELECT status, COUNT(*)::int AS count
        FROM minion_jobs
       GROUP BY status
       ORDER BY status
    `),
    optionalRows(engine, `
      SELECT status, COUNT(*)::int AS count
        FROM minion_jobs
       WHERE name = 'subagent'
       GROUP BY status
       ORDER BY status
    `),
    optionalOne(engine, `
      SELECT COUNT(*) FILTER (WHERE status = 'active' AND lock_until < now())::int AS stalled_active,
             COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting,
             COUNT(*) FILTER (WHERE status = 'active')::int AS active
        FROM minion_jobs
       WHERE name = 'subagent'
    `),
    getSupervisorStatus().catch(() => ({ running: false, supervisor_pid: null, pid_file: '' })),
    optionalRows(engine, `
      SELECT id::int AS id,
             verdict,
             overall_score,
             cost_usd,
             created_at::text AS created_at
        FROM eval_takes_quality_runs
       ORDER BY created_at DESC
       LIMIT 6
    `),
    optionalRows(engine, `
      SELECT run_id,
             ran_at::text AS ran_at,
             queries_evaluated::int AS queries_evaluated,
             queries_with_contradiction::int AS queries_with_contradiction,
             total_contradictions_flagged::int AS total_contradictions_flagged,
             judge_errors_total::int AS judge_errors_total
        FROM eval_contradictions_runs
       ORDER BY ran_at DESC
       LIMIT 6
    `),
  ]);

  const runs = listRuns()
    .filter(row => row.kind.startsWith('dream_') || row.kind === 'embed_stale' || row.kind === 'sync_all' || row.kind === 'doctor_check')
    .slice(0, 20);

  return {
    phase_catalog: ALL_PHASES,
    overview: overviewValue,
    health,
    locks,
    runs,
    proposals: proposalStatus,
    takes: takeSummary,
    grades: gradeSummary,
    calibration: {
      latest: latestCalibration,
      history: calibrationHistory,
    },
    embeddings: {
      by_source: embeddingBySource,
      coverage: overviewValue?.embedding_coverage ?? health?.embed_coverage ?? null,
      pending: overviewValue?.pending_embeddings ?? health?.missing_embeddings ?? null,
    },
    weights: {
      top_pages: topWeightedPages,
    },
    knowledge: {
      types: knowledgeTypes,
      ingest: ingestSummary,
    },
    lifecycle: lifecycleSummary,
    jobs: {
      recent: recentJobs,
      status: jobStatus,
      subagent_status: subagentStatus,
      subagent_queue: stalledQueue,
    },
    supervisor: supervisorStatus,
    quality: {
      takes_quality_runs: qualityRuns,
      contradiction_runs: contradictionRuns,
    },
  };
}

// ---------------------------------------------------------------------------
// Provider status (used by getAdminBrainOverview; also re-exported via natural-lang)
// ---------------------------------------------------------------------------

function getProviderStatus(config: GBrainConfig | null) {
  const chatModel = config?.chat_model ?? null;
  const provider = chatModel?.split(':')[0] ?? null;
  const providers = {
    mimo: !!config?.mimo_api_key,
    zhipu: !!config?.zhipu_api_key,
    deepseek: !!config?.deepseek_api_key,
    openai: !!config?.openai_api_key,
    anthropic: !!config?.anthropic_api_key,
    zeroentropy: !!config?.zeroentropy_api_key,
  };
  const providerKeyMap: Record<string, keyof typeof providers> = {
    mimo: 'mimo',
    zhipu: 'zhipu',
    deepseek: 'deepseek',
    openai: 'openai',
    anthropic: 'anthropic',
    zeroentropyai: 'zeroentropy',
  };
  const required = provider ? providerKeyMap[provider] : null;
  const hasRequired = required ? providers[required] : false;
  return {
    chat: {
      enabled: !!chatModel && hasRequired,
      chat_model: chatModel,
      provider,
      missing: !chatModel ? ['chat_model'] : hasRequired ? [] : [`${provider}_api_key`],
    },
    providers,
  };
}
