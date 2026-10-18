/**
 * `gbrain eval longmemeval --via-operation query|search`: each question runs
 * through the real operation with an agent's stdio MCP context, keyless (fixture
 * embed and expansion transports; no provider is called).
 *
 * Protects: rows record the operation context, the `expand` sent, model calls
 * per touchpoint, latency, the CRAG grade and the expansion outcome; the
 * pins (and so retrieval_config_hash) carry the via-operation context; the
 * summary's run_config has `via_operation_summary` (tree, p50/p95 latency,
 * model calls per query); `query` expands by the resolved mode unless
 * `--op-expand` says otherwise; a run that expects expansion fails when a
 * question did not expand (the throwing-provider fixture); and flags the path
 * would ignore are refused.
 * Serial: mutates the process-global gateway and its transports.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import { configureGateway, resetGateway, __clearQueryEmbedCacheForTests, __setEmbedTransportForTests, __setGenerateObjectTransportForTests, __setRerankTransportForTests } from '../src/core/ai/gateway.ts';
import { execFileSync } from 'node:child_process';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');
const QUESTIONS = readFileSync(FIXTURE, 'utf8').split('\n').filter(l => l.trim()).length;
const DIMS = 1536;
const tmp = mkdtempSync(join(tmpdir(), 'lme-via-op-'));
const embedTransport = (async (p: { values: string[] }) => ({
  embeddings: p.values.map(v => Array.from({ length: DIMS }, (_, j) => (j === v.length % DIMS ? 1 : 0.01))), values: p.values, warnings: [], usage: { tokens: p.values.length },
})) as unknown as Parameters<typeof __setEmbedTransportForTests>[0];

/** tokenmax builds per-chunk synopses with a chat model; title context keeps these runs keyless. */
const NO_SYNOPSIS = ['--search-pin', 'search.contextual_retrieval=title'];

let expansionCalls = 0;
function expansionTransport(behavior: 'variants' | 'throw'): void {
  __setGenerateObjectTransportForTests((async () => {
    expansionCalls++;
    if (behavior === 'throw') throw new Error('provider exploded');
    return { object: { queries: ['an alternate phrasing of the question', 'another framing of it'] }, usage: { inputTokens: 50, outputTokens: 10 } };
  }) as never);
}

async function run(args: string[], runOpts: Record<string, unknown> = {}): Promise<{ rows: any[]; summary: any; err: string; failed: boolean }> {
  const out = join(tmp, `out-${Math.random().toString(36).slice(2)}.jsonl`);
  const engine: PGLiteEngine = await createBenchmarkBrain();
  // Query embeddings are cached per process; each run starts cold so its model calls are its own.
  __clearQueryEmbedCacheForTests();
  const write = process.stderr.write.bind(process.stderr);
  let err = '';
  let failed = false;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try {
    await runEvalLongMemEval([FIXTURE, '--no-embed-cache', '--by-type', '--retrieval-only', '--no-trajectory', '--reranker', 'off', '--output', out, ...args], {
      engine, exitOnError: false, embedTransport, ...runOpts,
    });
  } catch (e) {
    if (!/longmemeval failed/.test((e as Error).message)) {
      process.stderr.write = write;
      await engine.disconnect();
      throw Object.assign(e as Error, { stderr: err });
    }
    failed = true;
  }
  process.stderr.write = write;
  await engine.disconnect();
  const lines = readFileSync(out, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  return { rows: lines.filter(l => l.kind !== 'by_type_summary'), summary: lines.find(l => l.kind === 'by_type_summary'), err, failed };
}

beforeAll(() => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, expansion_model: 'anthropic:claude-haiku-5-5',
    env: { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test', VOYAGE_API_KEY: 'pa-test' },
  });
  __setEmbedTransportForTests(embedTransport);
});

afterEach(() => {
  __setGenerateObjectTransportForTests(null);
  __setRerankTransportForTests(null);
  expansionCalls = 0;
});

afterAll(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
  rmSync(tmp, { recursive: true, force: true });
});

describe('eval longmemeval --via-operation', () => {
  test('search: rows and run_config record the agent-shaped context, latency and model calls; the hash differs from the direct path', async () => {
    expansionTransport('variants');
    const direct = await run(['--mode', 'balanced']);
    const via = await run(['--via-operation', 'search', '--mode', 'balanced']);
    expect(via.failed).toBe(false);
    expect(via.rows).toHaveLength(QUESTIONS);
    for (const row of via.rows) {
      expect(row.via_operation).toMatchObject({ op: 'search', expand: false, expansion: { expected: false, outcome: 'not_expected' } });
      expect(row.via_operation.latency_ms).toBeGreaterThanOrEqual(0);
      expect(row.via_operation.model_calls.embedding).toBeGreaterThanOrEqual(1);
      expect(row.via_operation.model_calls.expansion).toBeUndefined();
      expect(Array.isArray(row.retrieved_session_ids)).toBe(true);
    }
    expect(expansionCalls).toBe(0);
    const rc = via.summary.run_config;
    expect(rc.via_operation).toEqual({ op: 'search', expand: null, limit: 'operation_default', context: { remote: true, transport: 'stdio', source_id: 'default' } });
    expect(rc.via_operation_summary).toMatchObject({ questions: QUESTIONS, expansion_outcomes: { not_expected: QUESTIONS } });
    expect(typeof rc.via_operation_summary.tree).toBe('string');
    expect(rc.via_operation_summary.latency_ms.p50).toBeGreaterThanOrEqual(0);
    expect(rc.via_operation_summary.latency_ms.p95).toBeGreaterThanOrEqual(rc.via_operation_summary.latency_ms.p50);
    expect(rc.via_operation_summary.model_calls_per_query.embedding).toBeGreaterThanOrEqual(1);
    expect(rc.retrieval_config_hash).not.toBe(direct.summary.run_config.retrieval_config_hash);
    expect(direct.summary.run_config.via_operation).toBeUndefined();
    expect(direct.rows.every(r => !('via_operation' in r))).toBe(true);
  }, 120_000);

  test('search with the reranker on: rows record reranked from the operation\'s rerank call, and the summary names gbrain\'s own tree from any cwd', async () => {
    let rerankCalls = 0;
    __setRerankTransportForTests((async (_url: string, init: RequestInit) => {
      rerankCalls++;
      const docs = JSON.parse(String(init.body)).documents as string[];
      const data = docs.map((_, index) => ({ index, relevance_score: 1 - index / (docs.length + 1) }));
      return new Response(JSON.stringify({ data, usage: { total_tokens: docs.length } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never);
    const repo = join(import.meta.dir, '..');
    const cwd = process.cwd();
    process.chdir(tmp);
    let via: Awaited<ReturnType<typeof run>>;
    try {
      via = await run(['--via-operation', 'search', '--mode', 'balanced', '--reranker', 'on'], { rerankerReadiness: async () => ({ plane: 'db', readiness: { ready: true } }) });
    } finally {
      process.chdir(cwd);
    }
    expect(via.failed).toBe(false);
    expect(rerankCalls).toBe(QUESTIONS);
    for (const row of via.rows) {
      expect(row.via_operation.model_calls.rerank).toBe(1);
      expect(row.search_meta.reranked).toBe(true);
    }
    const summary = via.summary.run_config.via_operation_summary;
    expect(summary.tree).toBe(execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim());
    expect(summary.commit).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim());
    expect(typeof summary.dirty).toBe('boolean');
  }, 120_000);

  test('query under balanced: the mode decides, so nothing expands; the CRAG grade is recorded', async () => {
    expansionTransport('variants');
    const via = await run(['--via-operation', 'query', '--mode', 'balanced']);
    expect(via.failed).toBe(false);
    expect(expansionCalls).toBe(0);
    expect(via.summary.run_config.expansion).toBe(false);
    for (const row of via.rows) {
      expect(row.via_operation).toMatchObject({ op: 'query', expand: null, expansion: { expected: false, outcome: 'not_expected' } });
      expect(typeof row.via_operation.crag_confidence).toBe('string');
      expect(row.search_meta.expansion_applied).toBe(false);
    }
    expect(Object.values(via.summary.run_config.via_operation_summary.crag_confidence).reduce((a: number, b) => a + (b as number), 0)).toBe(QUESTIONS);
  }, 120_000);

  test('query --op-expand on: every question expands once and the run passes', async () => {
    expansionTransport('variants');
    const via = await run(['--via-operation', 'query', '--mode', 'balanced', '--op-expand', 'on']);
    expect(via.failed).toBe(false);
    expect(expansionCalls).toBe(QUESTIONS);
    expect(via.summary.run_config.expansion).toBe(true);
    expect(via.summary.run_config.via_operation.expand).toBe(true);
    for (const row of via.rows) {
      expect(row.via_operation).toMatchObject({ expand: true, expansion: { expected: true, outcome: 'applied' } });
      expect(row.via_operation.model_calls.expansion).toBe(1);
      expect(row.search_meta.expansion_applied).toBe(true);
    }
    expect(via.summary.run_config.via_operation_summary.model_calls_per_query.expansion).toBe(1);
  }, 120_000);

  test('query under tokenmax with no --op-expand: the mode default no longer expands (GBRA-94)', async () => {
    expansionTransport('variants');
    const via = await run(['--via-operation', 'query', '--mode', 'tokenmax', ...NO_SYNOPSIS]);
    expect(via.failed).toBe(false);
    expect(expansionCalls).toBe(0);
    expect(via.summary.run_config.expansion).toBe(false);
    expect(via.rows.every(r => r.via_operation.expansion.outcome === 'not_expected')).toBe(true);
  }, 120_000);

  test('a throwing expansion provider invalidates the arm: every row says failed and the run fails', async () => {
    expansionTransport('throw');
    const via = await run(['--via-operation', 'query', '--mode', 'balanced', '--op-expand', 'on']);
    expect(via.failed).toBe(true);
    expect(expansionCalls).toBeGreaterThanOrEqual(QUESTIONS);
    for (const row of via.rows) {
      expect(row.via_operation.expansion).toEqual({ expected: true, outcome: 'failed' });
      expect(row.search_meta.degraded.map((d: { stage: string }) => d.stage)).toContain('expansion_not_applied');
    }
    expect(via.summary.run_config.expansion_failed_rows).toBe(QUESTIONS);
    expect(via.err).toContain(`FAIL --via-operation query (expansion expected): ${QUESTIONS} row(s) did not expand`);
  }, 120_000);

  test('--op-expand off under tokenmax skips expansion', async () => {
    expansionTransport('variants');
    const via = await run(['--via-operation', 'query', '--mode', 'tokenmax', ...NO_SYNOPSIS, '--op-expand', 'off']);
    expect(via.failed).toBe(false);
    expect(expansionCalls).toBe(0);
    expect(via.rows.every(r => r.via_operation.expand === false && r.via_operation.expansion.outcome === 'not_expected')).toBe(true);
  }, 120_000);

  test('flags the via-operation path would ignore are refused', async () => {
    const refused = async (args: string[]) => {
      const engine = await createBenchmarkBrain();
      try {
        return await runEvalLongMemEval([FIXTURE, '--retrieval-only', ...args], { engine, exitOnError: false }).then(() => 'ran', (e: Error) => e.message);
      } finally { await engine.disconnect(); }
    };
    const write = process.stderr.write.bind(process.stderr);
    let err = '';
    process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
    try {
      for (const args of [['--op-expand', 'on'], ['--via-operation', 'search', '--op-expand', 'on'], ['--via-operation', 'query', '--expansion'], ['--via-operation', 'query', '--keyword-only'], ['--via-operation', 'think']]) {
        expect(await refused(args)).not.toBe('ran');
      }
    } finally { process.stderr.write = write; }
    expect(err).toContain('--op-expand needs --via-operation query');
    expect(err).toContain('--op-expand applies to --via-operation query only');
    expect(err).toContain('--via-operation cannot be combined with --expansion');
    expect(err).toContain('--via-operation cannot be combined with --keyword-only');
    expect(err).toContain('--via-operation must be query|search');
  }, 120_000);
});
