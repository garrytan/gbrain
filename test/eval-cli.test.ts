import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runEval } from '../src/commands/eval.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    rmSync(tempPaths.pop()!, { recursive: true, force: true });
  }
});

describe('eval CLI runner', () => {
  test('persists a context fixture run and assertion summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-cli-'));
    tempPaths.push(dir);
    const fixturePath = join(dir, 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify({
      id: 'context-fixture',
      mode: 'injected_candidates',
      cases: [
        { id: 'case-pass', passed: true, expected: { selector: 'a' }, actual: { selector: 'a' } },
        { id: 'case-fail', passed: false, expected: { selector: 'b' }, actual: { selector: null } },
      ],
    }));
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => { logs.push(String(line)); };
    try {
      await runEval(fakeEvalEngine(), ['context', '--fixture', fixturePath, '--json']);
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(logs.join('\n'));
    expect(output.run.fixture_id).toBe('context-fixture');
    expect(output.run.status).toBe('failed');
    expect(output.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(output.assertions).toHaveLength(2);
  });

  test('real CLI preserves eval fixture flags through direct command dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-cli-real-'));
    tempPaths.push(dir);
    const dbPath = join(dir, 'brain.db');
    const configPath = join(dir, 'config.json');
    const fixturePath = join(dir, 'fixture.json');
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: dbPath });
    await engine.initSchema();
    await engine.disconnect();
    writeFileSync(configPath, JSON.stringify({ engine: 'sqlite', database_path: dbPath }));
    writeFileSync(fixturePath, JSON.stringify({
      id: 'real-cli-context-fixture',
      mode: 'injected_candidates',
      cases: [
        { id: 'case-pass', expected: { selector: 'a' }, actual: { selector: 'a' } },
      ],
    }));

    const output = execFileSync('bun', ['src/cli.ts', 'eval', 'context', '--fixture', fixturePath, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, MBRAIN_CONFIG_PATH: configPath },
    });
    const parsed = JSON.parse(output);

    expect(parsed.run.fixture_id).toBe('real-cli-context-fixture');
    expect(parsed.run.status).toBe('passed');
    expect(parsed.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
  });

  test('compares base and head eval reports without consuming --compare as a value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-compare-'));
    tempPaths.push(dir);
    const basePath = join(dir, 'base.json');
    const headPath = join(dir, 'head.json');
    writeFileSync(basePath, JSON.stringify({ metrics: { total: 2, passed: 1, failed: 1, pass_rate: 0.5 } }));
    writeFileSync(headPath, JSON.stringify({ metrics: { total: 2, passed: 2, failed: 0, pass_rate: 1 } }));
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => { logs.push(String(line)); };
    try {
      await runEval(fakeEvalEngine(), ['context', '--compare', basePath, headPath, '--json']);
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(logs.join('\n'));
    expect(output.delta).toMatchObject({ total: 0, passed: 1, failed: -1, pass_rate: 0.5 });
  });

  test('compares retrieval metric deltas in eval reports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-retrieval-compare-'));
    tempPaths.push(dir);
    const basePath = join(dir, 'base.json');
    const headPath = join(dir, 'head.json');
    writeFileSync(basePath, JSON.stringify({
      metrics: {
        total: 2,
        passed: 1,
        failed: 1,
        recall_at_10: 0.5,
        precision_at_k: 0.25,
        mrr: 0.5,
        judge_score: 0.4,
        per_route: {
          broad_synthesis: { case_count: 2, recall_at_10: 0.5, precision_at_k: 0.25, mrr: 0.5 },
        },
      },
    }));
    writeFileSync(headPath, JSON.stringify({
      metrics: {
        total: 2,
        passed: 2,
        failed: 0,
        recall_at_10: 1,
        precision_at_k: 0.5,
        mrr: 1,
        judge_score: 0.9,
        per_route: {
          broad_synthesis: { case_count: 2, recall_at_10: 1, precision_at_k: 0.5, mrr: 1 },
        },
      },
    }));
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => { logs.push(String(line)); };
    try {
      await runEval(fakeEvalEngine(), ['retrieval', '--compare', basePath, headPath, '--json']);
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(logs.join('\n'));
    expect(output.delta).toMatchObject({
      recall_at_10: 0.5,
      precision_at_k: 0.25,
      mrr: 0.5,
      judge_score: 0.5,
    });
    expect(output.per_route.broad_synthesis.delta).toMatchObject({
      recall_at_10: 0.5,
      precision_at_k: 0.25,
      mrr: 0.5,
    });
  });

  test('EV-1c: committed per-config baselines parse and diff through the retrieval compare path', async () => {
    const baselineDir = new URL('./fixtures/retrieval-eval/baselines/', import.meta.url).pathname;
    const baselineSpecs = [
      { file: 'sqlite-governed-probe-on.json', engine: 'sqlite', probe: true, embeddings: 'none', recallFloor: 0.9 },
      { file: 'sqlite-governed-probe-off.json', engine: 'sqlite', probe: false, embeddings: 'none', recallFloor: 0.9 },
      { file: 'pglite-governed-probe-on.json', engine: 'pglite', probe: true, embeddings: 'none', recallFloor: 0.9 },
      { file: 'pglite-governed-probe-off.json', engine: 'pglite', probe: false, embeddings: 'none', recallFloor: 0.9 },
      // Stub-embeddings baselines run the real vector path with the
      // deterministic stub-hash-1024 provider; their recall floor is the
      // instrument floor, not a quality claim (see
      // test/fixtures/retrieval-eval/stub-embedding-provider.ts).
      { file: 'sqlite-stub-embeddings.json', engine: 'sqlite', probe: true, embeddings: 'stub-hash-1024', recallFloor: 0.75 },
      { file: 'pglite-stub-embeddings.json', engine: 'pglite', probe: true, embeddings: 'stub-hash-1024', recallFloor: 0.75 },
    ] as const;

    for (const spec of baselineSpecs) {
      const baseline = JSON.parse(readFileSync(join(baselineDir, spec.file), 'utf8'));
      expect(baseline.artifact_kind).toBe('ev1c_live_retrieval_baseline');
      expect(baseline.generated_by).toBe('scripts/regen-retrieval-baselines.ts');
      expect(baseline.engine).toBe(spec.engine);
      expect(baseline.embedding_provider).toBe(spec.embeddings);
      expect(baseline.config['retrieval.governed_probe_hybrid']).toBe(spec.probe);
      expect(baseline.metrics.total).toBe(30);
      expect(baseline.metrics.per_route).toBeDefined();
      expect(baseline.metrics.per_route.broad_synthesis.case_count).toBeGreaterThanOrEqual(1);
      expect(baseline.metrics.recall_at_10).toBeGreaterThanOrEqual(spec.recallFloor);
      expect(baseline.metrics.mrr).toBeGreaterThanOrEqual(0.85);
      expect(baseline.metrics.route_match_rate).toBeGreaterThanOrEqual(0.9);
    }

    // With embeddings pinned to none, the hybrid probe degrades to
    // keyword-only, so the on/off configs must produce identical quality
    // metrics on both engines.
    for (const enginePrefix of ['sqlite', 'pglite'] as const) {
      const onPath = join(baselineDir, `${enginePrefix}-governed-probe-on.json`);
      const offPath = join(baselineDir, `${enginePrefix}-governed-probe-off.json`);
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (line?: unknown) => { logs.push(String(line)); };
      try {
        await runEval(fakeEvalEngine(), ['retrieval', '--compare', onPath, offPath, '--json']);
      } finally {
        console.log = originalLog;
      }

      const output = JSON.parse(logs.join('\n'));
      expect(output.delta.recall_at_10).toBe(0);
      expect(output.delta.mrr).toBe(0);
      expect(output.per_route.broad_synthesis.delta.recall_at_10).toBe(0);
    }
  });

  test('requires retrieval eval answer grounding config before running a judge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-retrieval-judge-gate-'));
    tempPaths.push(dir);
    const fixturePath = join(dir, 'retrieval.jsonl');
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      engine: 'sqlite',
      database_path: join(dir, 'brain.db'),
    }));
    writeFileSync(fixturePath, [
      JSON.stringify({
        id: 'hybrid-search-live',
        route: 'precision_lookup',
        query: 'hybrid search retrieval',
        gold_slugs: ['concepts/hybrid-search'],
      }),
    ].join('\n'));
    const previousConfigPath = process.env.MBRAIN_CONFIG_PATH;
    process.env.MBRAIN_CONFIG_PATH = configPath;
    try {
      await expect(runEval(fakeEvalEngine(), [
        'retrieval',
        '--fixture',
        fixturePath,
        '--judge',
        '--judge-model',
        'judge-model',
        '--judge-prompt-version',
        'v1',
      ])).rejects.toThrow('retrieval_eval.answer_grounding=true');
    } finally {
      if (previousConfigPath === undefined) delete process.env.MBRAIN_CONFIG_PATH;
      else process.env.MBRAIN_CONFIG_PATH = previousConfigPath;
    }
  });

  test('does not default missing fixture outcomes to pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-missing-outcome-'));
    tempPaths.push(dir);
    const fixturePath = join(dir, 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify({
      id: 'missing-outcome',
      mode: 'injected_candidates',
      cases: [{ id: 'case-missing' }],
    }));
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => { logs.push(String(line)); };
    try {
      await runEval(fakeEvalEngine(), ['context', '--fixture', fixturePath, '--json']);
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(logs.join('\n'));
    expect(output.run.status).toBe('failed');
    expect(output.summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
  });

  test('live_retrieve fixtures run retrieve_context and read_context with linked traces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-live-'));
    tempPaths.push(dir);
    const fixturePath = join(dir, 'fixture.json');
    const dbPath = join(dir, 'brain.db');
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: dbPath });
    await engine.initSchema();
    try {
      await importFromContent(engine, 'concepts/live-eval', [
        '---',
        'type: concept',
        'title: Live Eval',
        '---',
        '# Compiled Truth',
        'Live eval canonical evidence.',
        '[Source: User, direct message, 2026-06-29 12:00 KST]',
      ].join('\n'), { path: 'concepts/live-eval.md' });
      writeFileSync(fixturePath, JSON.stringify({
        id: 'live-context-fixture',
        mode: 'live_retrieve',
        cases: [{
          id: 'live-case',
          query: 'live eval',
          selectors: [{ kind: 'compiled_truth', slug: 'concepts/live-eval' }],
          expected: {
            answer_ready: true,
            authority_class: 'canonical_read',
            read_selector_ids: ['compiled_truth:workspace:default:concepts/live-eval'],
          },
        }],
      }));
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (line?: unknown) => { logs.push(String(line)); };
      try {
        await runEval(engine, ['context', '--fixture', fixturePath, '--json']);
      } finally {
        console.log = originalLog;
      }

      const output = JSON.parse(logs.join('\n'));
      expect(output.run.status).toBe('passed');
      expect(typeof output.assertions[0].retrieval_trace_id).toBe('string');
      expect(output.assertions[0].actual.trace_ids).toHaveLength(2);
    } finally {
      await engine.disconnect();
    }
  });

  test('retrieval fixtures persist live recall metrics and per-case assertions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-retrieval-'));
    tempPaths.push(dir);
    const fixturePath = join(dir, 'retrieval.jsonl');
    const dbPath = join(dir, 'brain.db');
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: dbPath });
    await engine.initSchema();
    try {
      await importFromContent(engine, 'concepts/hybrid-search', [
        '---',
        'type: concept',
        'title: Hybrid Search',
        '---',
        '# Compiled Truth',
        'Hybrid search combines keyword retrieval and vector retrieval for robust recall.',
        '[Source: User, direct message, 2026-07-03 12:00 KST]',
      ].join('\n'), { path: 'concepts/hybrid-search.md' });
      writeFileSync(fixturePath, [
        JSON.stringify({
          id: 'hybrid-search-live',
          route: 'broad_synthesis',
          expected_selected_intent: 'broad_synthesis',
          query: 'hybrid search retrieval',
          gold_slugs: ['concepts/hybrid-search'],
          gold_answer: 'Hybrid search combines keyword and vector retrieval.',
        }),
      ].join('\n'));

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (line?: unknown) => { logs.push(String(line)); };
      try {
        await runEval(engine, ['retrieval', '--fixture', fixturePath, '--json']);
      } finally {
        console.log = originalLog;
      }

      const output = JSON.parse(logs.join('\n'));
      expect(output.run.fixture_id).toBe('retrieval');
      expect(output.run.status).toBe('passed');
      expect(output.run.metrics).toMatchObject({
        total: 1,
        passed: 1,
        failed: 0,
        recall_at_10: 1,
        top1_match_rate: 1,
      });
      expect(output.retrieval_quality.per_route.broad_synthesis.case_count).toBe(1);
      expect(output.retrieval_quality.cases[0].selected_intent).toBe('broad_synthesis');
      expect(output.retrieval_quality.cases[0].route_match).toBe(true);
      expect(output.assertions[0]).toMatchObject({
        assertion_kind: 'live_retrieval_quality',
        passed: true,
        expected: {
          expected_selected_intent: 'broad_synthesis',
        },
        actual: {
          selected_intent: 'broad_synthesis',
          route_match: true,
        },
      });
    } finally {
      await engine.disconnect();
    }
  });
});

function fakeEvalEngine(): any {
  return {
    async putContextEvalRun(input: any) {
      return {
        id: input.id ?? 'run-1',
        ...input,
        started_at: input.started_at ?? new Date(),
        completed_at: input.completed_at ?? null,
        created_at: new Date(),
        updated_at: new Date(),
      };
    },
    async putContextEvalAssertion(input: any) {
      return {
        id: input.id ?? `assertion-${input.case_id}`,
        ...input,
        score: input.score ?? null,
        expected: input.expected ?? null,
        actual: input.actual ?? null,
        message: input.message ?? null,
        retrieval_trace_id: input.retrieval_trace_id ?? null,
        metadata: input.metadata ?? {},
        created_at: new Date(),
      };
    },
  };
}
