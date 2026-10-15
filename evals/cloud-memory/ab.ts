/** Live LongMemEval matrix through the shipped query operation. See README.md. */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { LongMemEvalQuestion } from '../../src/eval/longmemeval/adapter.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { benchmarkConditions, compareMatrix, summarizeMatrix, type BenchmarkRow } from './matrix.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const datasetPath = arg('--dataset'), idsPath = arg('--ids'), out = arg('--out');
if (!datasetPath || !idsPath || !out || !process.env.HYDRA_DB_API_KEY || !process.env.OPENROUTER_API_KEY) {
  throw new Error('Provide --dataset, --ids and --out; set HYDRA_DB_API_KEY and OPENROUTER_API_KEY. Only the selected public benchmark corpus is uploaded.');
}
const k = Number(arg('--k') ?? 10), share = Number(arg('--local-share') ?? 0.3), repeats = Number(arg('--repeats') ?? 3);
const concurrency = Number(arg('--ingest-concurrency') ?? 1);
if (!Number.isInteger(k) || k < 1 || !Number.isInteger(repeats) || repeats < 1 || share <= 0 || share >= 1 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Invalid k, repeats, local-share or ingest-concurrency (1–4).');
let bytes = readFileSync(datasetPath);
const datasetHash = createHash('sha256').update(bytes).digest('hex');
const expectedHash = JSON.parse(readFileSync(join(import.meta.dir, '../longmemeval/splits-seed42.json'), 'utf8')).dataset_sha256;
if (datasetHash !== expectedHash) throw new Error('Dataset hash differs from the pinned cleaned LongMemEval S split.');
const wanted = readFileSync(idsPath, 'utf8').trim().split(/\s+/);
const dataset = JSON.parse(bytes.toString()) as LongMemEvalQuestion[];
const questions = wanted.map(id => dataset.find(q => q.question_id === id));
if (new Set(wanted).size !== wanted.length || questions.some(q => !q || !q.answer_session_ids.length)) throw new Error('Every unique selected id must exist and have gold sessions.');
const selected = JSON.parse(JSON.stringify(questions)) as LongMemEvalQuestion[];
dataset.length = 0; questions.length = 0; bytes = Buffer.alloc(0);
const embeddingModel = 'openrouter:openai/text-embedding-3-small';
const workspaceArg = arg('--work-dir');
let workspace: string | undefined;
if (workspaceArg) {
  mkdirSync(workspaceArg, { recursive: true }); workspace = realpathSync(workspaceArg);
  const manifest = join(workspace, 'manifest.json');
  const identity = JSON.stringify({ schema_version: 2, dataset_sha256: datasetHash, ids: wanted, share, embedding_model: embeddingModel });
  if (existsSync(manifest) && readFileSync(manifest, 'utf8') !== identity) throw new Error('Existing work-dir contains a different benchmark corpus or embedding configuration.');
  writeFileSync(manifest, identity);
  if (existsSync(join(workspace, 'live-cloud.json'))) throw new Error('A previous owned cloud database still needs cleanup; inspect work-dir/live-cloud.json before starting another run.');
}
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'gbrain-hydra-benchmark-'));
process.env.GBRAIN_HOME = scratch; process.env.GBRAIN_NON_INTERACTIVE = '1';
const key = process.env.HYDRA_DB_API_KEY, embeddingKey = process.env.OPENROUTER_API_KEY;
delete process.env.HYDRA_DB_API_KEY; delete process.env.OPENROUTER_API_KEY;
const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { configureGateway, embedQuery } = await import('../../src/core/ai/gateway.ts');
const { importFromContent } = await import('../../src/core/import-file.ts');
const { runEmbedCore } = await import('../../src/commands/embed.ts');
const { dispatchToolCall } = await import('../../src/mcp/dispatch.ts');
const { unpackToolResult } = await import('../../src/core/mcp-client.ts');
const { HYDRADB_CONFIG, hydraRequest } = await import('../../src/core/hydradb.ts');
const { uploadBenchmarkCorpus } = await import('./ingest.ts');
const { haystackToPages } = await import('../../src/eval/longmemeval/adapter.ts');
const { buildSlugToRawMap, collisionsTouchingGold, goldMissingFromHaystack, scoreRecall } = await import('../../src/eval/longmemeval/metrics.ts');
const { drainAllBackgroundWorkForCliExit } = await import('../../src/core/background-work.ts');
const gateway = (embeddings: boolean) => configureGateway({ embedding_model: embeddingModel, embedding_dimensions: 1536,
  env: embeddings ? { OPENROUTER_API_KEY: embeddingKey } : {} } as never);
gateway(true);
const sourceOf = (q: LongMemEvalQuestion) => 'lme-' + createHash('sha256').update(q.question_id).digest('hex').slice(0, 20);
const conditions = benchmarkConditions();
const brains = (['full', 'recent'] as const).flatMap(corpus => [true, false].map(embeddings => ({
  id: `${corpus}/${embeddings ? 'embeddings' : 'no-embeddings'}`, corpus, embeddings, engine: new PGLiteEngine(),
})));
const full = brains.find(b => b.corpus === 'full' && b.embeddings)!;
const conn = { database: 'gbrain_bench_' + randomUUID().replaceAll('-', '').slice(0, 12), apiKey: key, baseUrl: process.env.HYDRA_DB_BASE_URL };
const logger = { info() {}, warn() {}, error() {} };
const log = (message: string) => console.error(`[benchmark] ${message}`);
const rows: BenchmarkRow[] = [];
let created = false, cloudRemoved = false, complete = false, stage = 'preflight';
let pages = 0, partialPages = 0, mirror: unknown = null;
const coverage: Array<{ brain: string; total: number; embedded: number }> = [];
const started = Date.now(), measuredCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8' }).trim();
const version = readFileSync(join(import.meta.dir, '../../VERSION'), 'utf8').trim();
const harnessHash = createHash('sha256').update(['ab.ts', 'ingest.ts', 'matrix.ts'].map(file => readFileSync(join(import.meta.dir, file), 'utf8')).join('\n')).digest('hex');
const contextsPath = out + '.contexts.ndjson';
writeFileSync(contextsPath, '');
const receipt = () => ({ schema_version: 2, complete, stage, cloud_removed: cloudRemoved,
  measured_commit: measuredCommit, version, dataset: 'LongMemEval_s cleaned', dataset_sha256: datasetHash,
  harness_sha256: harnessHash, started_at: new Date(started).toISOString(),
  selected_ids: wanted, question_types: Object.fromEntries([...new Set(selected.map(q => q.question_type))].map(type => [type, selected.filter(q => q.question_type === type).length])),
  conditions, k, repeats, local_share: share, full_pages: pages, recent_pages: partialPages,
  embedding_model: embeddingModel, local_embedding_dimensions: 1536, coverage,
  query_expansion: false, semantic_cache: false, autocut: false, reader_accuracy_measured: false,
  hydradb_modes: ['fast', 'thinking'], fast_timeout_ms: 2500, thinking_timeout_ms: 15000,
  elapsed_seconds: Math.round((Date.now() - started) / 1000), mirror, summary: summarizeMatrix(rows),
  comparisons: complete ? compareMatrix(rows) : [], rows });
const checkpoint = () => { writeFileSync(out + '.tmp', JSON.stringify(receipt(), null, 2) + '\n'); renameSync(out + '.tmp', out); };
const originalFetch = globalThis.fetch;
let activity: { embedding: number; cloud: number; statuses: number[] } | null = null;
let statusPolls = 0;
try {
  await embedQuery('A synthetic benchmark authentication probe.');
  gateway(false);
  stage = 'local-import';
  for (const brain of brains) {
    await brain.engine.connect(workspace ? { database_path: join(workspace, brain.id.replace('/', '-')) } : {});
    await brain.engine.initSchema();
    await brain.engine.unsetConfig(HYDRADB_CONFIG.database);
    await brain.engine.setConfig(HYDRADB_CONFIG.primary, 'false');
    if (brain.embeddings) await brain.engine.unsetConfig('embedding_disabled');
    else await brain.engine.setConfig('embedding_disabled', 'true');
  }
  for (const [i, q] of selected.entries()) {
    const map = buildSlugToRawMap(q);
    if (collisionsTouchingGold(map, q.answer_session_ids).length || goldMissingFromHaystack(map, q.answer_session_ids).length) throw new Error('The preselected dataset has ambiguous or absent gold sessions; do not silently filter it.');
    const sourceId = sourceOf(q), sessions = haystackToPages(q);
    const recent = new Set(sessions.map((p, n) => ({ slug: p.slug, date: q.haystack_dates?.[n] ?? String(n).padStart(6, '0') }))
      .sort((x, y) => x.date.localeCompare(y.date)).slice(-Math.max(1, Math.ceil(sessions.length * share))).map(p => p.slug));
    for (const brain of brains) {
      await brain.engine.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [sourceId]);
      for (const p of sessions) if (brain.corpus === 'full' || recent.has(p.slug)) {
        if (!await brain.engine.getPage(p.slug, { sourceId })) await importFromContent(brain.engine, p.slug, p.content, { sourceId, noEmbed: true });
        // These are replicas of the same fixture, not independently edited memories.
        // Align their UUID revision before embedding so cloud graph provenance is equally fresh.
        if (brain !== full) {
          const canonical = await full.engine.getPage(p.slug, { sourceId });
          const held = await brain.engine.getPage(p.slug, { sourceId });
          if (!canonical || !held || held.content_hash !== canonical.content_hash) throw new Error('The fixture replicas have different page content.');
          if (held.knowledge_revision !== canonical.knowledge_revision) {
            await brain.engine.executeRaw('UPDATE pages SET knowledge_revision=$1::uuid WHERE source_id=$2 AND slug=$3', [canonical.knowledge_revision, sourceId, p.slug]);
            await importFromContent(brain.engine, p.slug, p.content, { sourceId, noEmbed: true });
          }
        }
      }
    }
    pages += sessions.length; partialPages += recent.size;
    log(`Imported ${i + 1}/${selected.length} questions (${pages} full, ${partialPages} recent-session pages in each embedding condition).`);
    checkpoint();
  }
  stage = 'local-embeddings'; gateway(true);
  for (const brain of brains) {
    if (brain.embeddings) {
      log(`Embedding ${brain.id} using ${embeddingModel}.`);
      const result = await runEmbedCore(brain.engine, { stale: true });
      log(`Embedding receipt: ${JSON.stringify(result)}`);
    }
    const [count] = await brain.engine.executeRaw<{ total: number; embedded: number }>('SELECT count(*)::int AS total, count(embedding)::int AS embedded FROM content_chunks');
    if (!count?.total || (brain.embeddings ? count.total !== count.embedded : count.embedded !== 0)) throw new Error('Local vector coverage does not match the declared condition.');
    coverage.push({ brain: brain.id, ...count }); checkpoint();
  }
  await drainAllBackgroundWorkForCliExit(); gateway(false);
  const canonicalPages = await full.engine.executeRaw<{ source_id: string; slug: string; knowledge_revision: string; content_hash: string }>(
    'SELECT source_id, slug, knowledge_revision, content_hash FROM pages WHERE deleted_at IS NULL');
  const canonical = new Map(canonicalPages.map(p => [`${p.source_id}:${p.slug}`, p]));
  for (const brain of brains) {
    const copies = await brain.engine.executeRaw<{ source_id: string; slug: string; knowledge_revision: string; text_projection_revision: string; content_hash: string }>(
      'SELECT source_id, slug, knowledge_revision, text_projection_revision, content_hash FROM pages WHERE deleted_at IS NULL');
    if (copies.length !== (brain.corpus === 'full' ? pages : partialPages) || copies.some(p => {
      const original = canonical.get(`${p.source_id}:${p.slug}`);
      return !original || p.content_hash !== original.content_hash || p.knowledge_revision !== original.knowledge_revision || p.text_projection_revision !== p.knowledge_revision;
    })) throw new Error('Fixture corpus, revisions or sealed projections differ between comparison arms.');
  }
  process.env.HYDRA_DB_API_KEY = key;
  stage = 'cloud-provision';
  await hydraRequest(conn, 'POST', '/databases', { json: { database: conn.database } }); created = true;
  if (workspace) writeFileSync(join(workspace, 'live-cloud.json'), JSON.stringify({ database: conn.database, base_url: conn.baseUrl, created_at: new Date().toISOString() }));
  const deadline = Date.now() + 120_000;
  for (;;) {
    const r = await hydraRequest<{ infra?: { ready_for_ingestion?: boolean } }>(conn, 'GET', '/databases/status', { query: { database: conn.database } });
    if (r.infra?.ready_for_ingestion) break;
    if (Date.now() > deadline) throw new Error('HydraDB database provisioning timed out.');
    await Bun.sleep(1000);
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const at = performance.now();
    if (url.pathname.endsWith('/embeddings')) { if (activity) activity.embedding++; }
    const cloudHost = url.origin === new URL(conn.baseUrl ?? 'https://api.hydradb.com').origin;
    if (activity && cloudHost) activity.cloud++;
    const response = await originalFetch(input as string, init);
    if (activity && cloudHost) activity.statuses.push(response.status);
    if (url.pathname === '/context/status' && ++statusPolls % 30 === 0) {
      const body = await response.clone().json() as { data?: { statuses?: Array<{ indexing_status: string; error_code?: string }> } };
      const statuses = body.data?.statuses ?? [];
      log('Index states: ' + JSON.stringify(Object.fromEntries([...new Set(statuses.map(s => s.indexing_status))].map(state => [state, statuses.filter(s => s.indexing_status === state).length]))));
      const codes = statuses.map(s => s.error_code).filter(c => typeof c === 'string' && /^[A-Z][A-Z0-9_-]{0,31}$/.test(c));
      if (codes.length) log('Index error codes: ' + JSON.stringify([...new Set(codes)]));
    }
    if (cloudHost && url.pathname !== '/context/status') log(`${init?.method ?? 'GET'} ${url.pathname}: ${response.status}, ${Math.round(performance.now() - at)}ms`);
    return response;
  }) as typeof fetch;
  stage = 'cloud-indexing';
  log(`Uploading ${pages} pages in verified batches; benchmark setup concurrency ${concurrency}.`);
  mirror = await uploadBenchmarkCorpus(full.engine, conn, selected.map(sourceOf), concurrency, n => { log(`Verified ${n}/${pages} indexed pages.`); });
  for (const brain of brains) {
    await brain.engine.setConfig(HYDRADB_CONFIG.database, conn.database);
    if (conn.baseUrl) await brain.engine.setConfig(HYDRADB_CONFIG.baseUrl, conn.baseUrl);
  }
  const titleMap = new Map<string, string>();
  for (const page of await full.engine.executeRaw<{ title: string; slug: string }>('SELECT title, slug FROM pages')) {
    titleMap.set((page.title || page.slug).replace(/[\\/\x00-\x1f]/g, ' ').slice(0, 120), page.slug);
  }
  stage = 'queries'; checkpoint();
  for (const [i, q] of selected.entries()) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const offset = (i * repeats + repeat) % conditions.length;
      const arms = [...conditions.slice(offset), ...conditions.slice(0, offset)];
      if ((i + repeat) % 2) arms.reverse();
      for (const arm of arms) {
        const brain = brains.find(b => b.corpus === arm.corpus && b.embeddings === arm.embeddings)!;
        await brain.engine.setConfig(HYDRADB_CONFIG.primary, String(arm.mode !== 'local'));
        await brain.engine.setConfig(HYDRADB_CONFIG.mode, arm.mode === 'thinking' ? 'thinking' : 'fast');
        gateway(arm.embeddings);
        activity = { embedding: 0, cloud: 0, statuses: [] };
        const t0 = performance.now();
        const r = await dispatchToolCall(brain.engine, 'query', { query: q.question, source_id: sourceOf(q), limit: k,
          expand: false, use_cache: false, autocut: false, fields: 'full', snippet_chars: 0 },
          { remote: false, transport: 'stdio', sourceId: sourceOf(q), config: { engine: 'pglite', embedding_disabled: !arm.embeddings } as never, logger });
        const latency = performance.now() - t0;
        const requests = activity; activity = null;
        const hits = r.isError ? [] : unpackToolResult<SearchResult[]>(r);
        if (!Array.isArray(hits)) throw new Error('Unexpected structured query output.');
        const meta = r._meta?.retrieval as { backend?: string; vector_enabled?: boolean; hydradb_mode?: string; degraded?: unknown } | undefined;
        if (!r.isError && arm.mode === 'local' && Boolean(meta?.vector_enabled) !== arm.embeddings) throw new Error('The local baseline did not use its declared embedding setting.');
        if (!arm.embeddings && requests.embedding) throw new Error('The no-embedding condition made an embedding-provider request.');
        if (arm.mode === 'local' ? requests.cloud !== 0 : requests.cloud === 0) throw new Error('The selected backend did not make its declared cloud request.');
        if (meta?.backend === 'hydradb' && meta.hydradb_mode !== arm.mode) throw new Error('HydraDB used the wrong query mode.');
        const map = buildSlugToRawMap(q);
        const raw = hits.slice(0, k).flatMap(h => map.get(h.slug?.replace(/^cloud\//, '') ?? '') ?? map.get(titleMap.get(h.title) ?? '') ?? []);
        const score = scoreRecall(raw, q.answer_session_ids, k);
        const markdown = r.content[0]?.type === 'text' ? r.content[0].text : '';
        rows.push({ ...arm, question_id: q.question_id, question_type: q.question_type, repeat,
          backend: meta?.backend ?? 'local', vector_enabled: Boolean(meta?.vector_enabled), recall_any: score.recall_any_hit,
          recall_all: score.recall_all_hit, gold_found: score.gold_found, gold_total: score.gold_total,
          latency_ms: Math.round(latency), returned: hits.length, embedding_requests: requests.embedding,
          cloud_requests: requests.cloud, cloud_statuses: requests.statuses, markdown_chars: markdown.length,
          query_error: r.isError ? 'operation_error' : null, degraded: meta?.degraded ?? [] });
        appendFileSync(contextsPath, JSON.stringify({ question_id: q.question_id, condition: arm.id, repeat,
          backend: meta?.backend ?? 'local', is_error: Boolean(r.isError), results: hits, markdown }) + '\n');
        checkpoint();
      }
    }
    log(`Scored ${i + 1}/${selected.length} questions (${rows.length} measurements).`);
  }
  if (rows.length !== selected.length * repeats * conditions.length || new Set(rows.map(r => `${r.question_id}:${r.id}:${r.repeat}`)).size !== rows.length) throw new Error('Incomplete or duplicated benchmark observations.');
  complete = true; stage = 'complete'; checkpoint();
  console.table(summarizeMatrix(rows));
} finally {
  activity = null; globalThis.fetch = originalFetch;
  await drainAllBackgroundWorkForCliExit();
  try {
    if (created) { await hydraRequest(conn, 'DELETE', '/databases', { query: { database: conn.database } }); cloudRemoved = true; }
    if (workspace && cloudRemoved) rmSync(join(workspace, 'live-cloud.json'), { force: true });
  } finally {
    await Promise.allSettled(brains.map(b => b.engine.disconnect()));
    rmSync(scratch, { recursive: true, force: true });
    checkpoint();
  }
}
