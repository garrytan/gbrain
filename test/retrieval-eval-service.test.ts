import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluateLiveRetrievalFixture } from '../src/core/evaluation/retrieval-eval.ts';
import {
  scoreRetrievalTrajectory,
  summarizeRetrievalTrajectoryScores,
} from '../src/core/evaluation/retrieval-trajectory-score.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { RetrievalTrace } from '../src/core/types.ts';
import type { RetrievalEvalReport } from '../src/core/evaluation/retrieval-eval.ts';
import {
  P2_GOLD_EVAL_CONFIGS,
  p2GoldRouteMatchRate,
  runP2GoldEvalConfig,
  type P2GoldEvalConfig,
} from './fixtures/retrieval-eval/p2-gold-configs.ts';
import { loadP2GoldFixture, seedP2GoldCorpus } from './fixtures/retrieval-eval/p2-gold-corpus.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 120_000));

// PGLite cold starts (WASM Postgres + full schema init) are slow on CI,
// especially macOS runners; honor the repo-wide TEST_TIMEOUT_MS contract but
// default these suites to a larger budget than the file-wide default.
const PGLITE_EVAL_TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS ?? 300_000);

const tempPaths: string[] = [];
const P2_GOLD_FIXTURE_URL = new URL('./fixtures/retrieval-eval/p2-gold.jsonl', import.meta.url);
const BASELINE_DIR_URL = new URL('./fixtures/retrieval-eval/baselines/', import.meta.url);

// retrieve_context derives its selected intent from the memory scenario
// classifier plus deterministic auto-route upgrades: a slug-like ref selects
// precision_lookup, and episodic personal recall with a personal_episode
// known-subject ref selects personal_episode_lookup. All six intents are now
// reachable, so the fixture's former route-mismatch canaries must pass.
const REACHABLE_INTENTS = [
  'broad_synthesis',
  'task_resume',
  'personal_profile_lookup',
  'personal_episode_lookup',
  'precision_lookup',
  'mixed_scope_bridge',
] as const;

afterEach(() => {
  while (tempPaths.length > 0) {
    rmSync(tempPaths.pop()!, { recursive: true, force: true });
  }
});

describe('live retrieval eval harness', () => {
  test('EV-1b: the full P2 gold fixture runs live against the seeded corpus and holds its floors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-p2-gold-live-'));
    tempPaths.push(dir);
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    try {
      await seedP2GoldCorpus(engine);

      const report = await evaluateLiveRetrievalFixture(engine, loadP2GoldFixture());

      expect(report.case_count).toBe(30);
      // Floors are set from what the seeded corpus actually achieves
      // (top1 1.0, recall 1.0, mrr 1.0, route match 30/30) with headroom so
      // only a real ranking or routing regression trips them.
      expect(report.recall_at_10).toBeGreaterThanOrEqual(0.9);
      expect(report.top1_match_rate).toBeGreaterThanOrEqual(0.9);
      expect(report.mrr).toBeGreaterThanOrEqual(0.85);
      const routeMatchRate = report.cases.filter((entry) => entry.route_match === true).length
        / report.case_count;
      expect(routeMatchRate).toBeGreaterThanOrEqual(0.966);

      for (const intent of REACHABLE_INTENTS) {
        expect(report.per_route[intent]?.case_count).toBeGreaterThanOrEqual(1);
        expect(report.per_route[intent]?.recall_at_10).toBeGreaterThanOrEqual(0.9);
      }
      const perRouteTotal = Object.values(report.per_route)
        .reduce((total, summary) => total + summary.case_count, 0);
      expect(perRouteTotal).toBe(30);

      // Every case must now match its expected intent; any recall/top1 miss
      // or route regression shows up here and turns this red.
      expect(report.failures).toEqual([]);
      expect(report.status).toBe('passed');
      expect(report.cases.every((entry) => entry.route_match === true)).toBe(true);

      // The Korean case must be answered from the live index, not skipped.
      const korean = report.cases.find((entry) => entry.id === 'p2-003-korean-rebellion-architecture');
      expect(korean?.recall_at_10).toBe(1);
      expect(korean?.top1_match).toBe(true);

      // task_resume runs against a real task thread, not just a label.
      const taskResume = report.cases.find((entry) => entry.id === 'p2-017-task-resume');
      expect(taskResume?.selected_intent).toBe('task_resume');
      expect(taskResume?.route_match).toBe(true);

      // The former canaries now select their intents deterministically: the
      // slug-like known subject drives precision_lookup and the episodic
      // personal-recall query with an episode subject drives
      // personal_episode_lookup.
      const precision = report.cases.find((entry) => entry.id === 'p2-030-review-local-mcp');
      expect(precision?.selected_intent).toBe('precision_lookup');
      expect(precision?.route_match).toBe(true);
      const episode = report.cases.find((entry) => entry.id === 'p2-015-personal-episode');
      expect(episode?.selected_intent).toBe('personal_episode_lookup');
      expect(episode?.route_match).toBe(true);
    } finally {
      await engine.disconnect();
    }
  });

  test('EV-1b regression sensitivity: a broken candidate search collapses recall below the floor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-p2-gold-broken-'));
    tempPaths.push(dir);
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    try {
      await seedP2GoldCorpus(engine);
      // A decoy page that no fixture case lists as gold: the broken search
      // below always "finds" this page, simulating a catastrophic ranking
      // regression while keeping the candidate pipeline exercised.
      await importFromContent(engine, 'brain/concepts/decoy-noise', [
        '---',
        'type: concept',
        'title: Decoy Noise Beacon',
        '---',
        'Decoy noise beacon content that answers no fixture query.',
        '[Source: User, direct message, 2026-07-04 12:00 KST]',
      ].join('\n'), { path: 'brain/concepts/decoy-noise.md' });

      const report = await evaluateLiveRetrievalFixture(engine, loadP2GoldFixture('p2-gold-broken-ranking'), {
        retrieve_context_dependencies: {
          candidateSearch: (_query, options) =>
            engine.searchKeyword('decoy noise beacon', { limit: options.limit }),
        },
      });

      expect(report.case_count).toBe(30);
      expect(report.status).toBe('failed');
      // Healthy floor is 0.9; the broken ranking must fall far below it so the
      // live gate is provably sensitive to ranking regressions.
      expect(report.recall_at_10).toBeLessThan(0.2);
      expect(report.mrr).toBeLessThan(0.2);
      expect(report.top1_match_rate).toBeLessThan(0.2);
      expect(report.failures.length).toBeGreaterThanOrEqual(28);
    } finally {
      await engine.disconnect();
    }
  });

  test('records a non-ceremonial P2 gold fixture with route and provenance metadata', () => {
    const lines = readFileSync(P2_GOLD_FIXTURE_URL, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines.length).toBeGreaterThanOrEqual(30);
    expect(lines.some((entry) =>
      Array.isArray(entry.gold_slugs) && entry.gold_slugs.length > 1,
    )).toBe(true);
    expect(lines.some((entry) => String(entry.query).includes('레벨리온'))).toBe(true);
    expect(new Set(lines.map((entry) => entry.expected_selected_intent))).toEqual(new Set([
      'task_resume',
      'broad_synthesis',
      'precision_lookup',
      'mixed_scope_bridge',
      'personal_profile_lookup',
      'personal_episode_lookup',
    ]));
    expect(lines.every((entry) => entry.provenance && typeof entry.provenance === 'object')).toBe(true);
  });

  test('scores recall, precision, MRR, latency, and per-route aggregates over a real index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-retrieval-eval-'));
    tempPaths.push(dir);
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    try {
      await seedEvalPages(engine);

      const report = await evaluateLiveRetrievalFixture(engine, {
        fixture_id: 'retrieval-eval-basic',
        thresholds: { top1_match_rate: 1, recall_at_10: 1 },
        cases: [
          {
            id: 'precision-hybrid-search',
            route: 'broad_synthesis',
            expected_selected_intent: 'broad_synthesis',
            query: 'hybrid search retrieval method',
            gold_slugs: ['concepts/hybrid-search'],
            gold_answer: 'Hybrid search combines keyword and vector retrieval.',
            precision_k: 3,
          },
          {
            id: 'korean-rebellion',
            route: 'broad_synthesis',
            expected_selected_intent: 'broad_synthesis',
            query: '레벨리온 아키텍처',
            gold_slugs: ['concepts/rebellion-architecture'],
            gold_answer: '레벨리온 아키텍처는 한국어 검색 fixture이다.',
            precision_k: 3,
          },
          {
            id: 'broad-compiled-truth',
            route: 'broad_synthesis',
            expected_selected_intent: 'broad_synthesis',
            query: 'compiled truth timeline evidence',
            gold_slugs: ['concepts/compiled-truth'],
            gold_answer: 'Compiled truth distills timeline evidence.',
            precision_k: 3,
          },
        ],
      });

      expect(report.status).toBe('passed');
      expect(report.top1_match_rate).toBe(1);
      expect(report.recall_at_10).toBe(1);
      expect(report.precision_at_k).toBeGreaterThan(0);
      expect(report.mrr).toBe(1);
      expect(report.latency_ms_avg).toEqual(expect.any(Number));
      expect(report.retrieved_token_count_total).toBeGreaterThan(0);
      expect(report.per_route.broad_synthesis?.case_count).toBe(3);
      expect(report.cases.every((entry) => entry.route_match === true)).toBe(true);
      expect(report.cases.every((entry) => entry.scored_slugs[0] === entry.required_read_slugs[0])).toBe(true);
      expect(report.cases.find((entry) => entry.id === 'korean-rebellion')?.candidate_slugs)
        .toContain('concepts/rebellion-architecture');
      expect(report.cases.find((entry) => entry.id === 'korean-rebellion')?.required_read_slugs)
        .toContain('concepts/rebellion-architecture');
    } finally {
      await engine.disconnect();
    }
  });

  test('fails by default when gold pages are not retrieved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-retrieval-eval-fail-'));
    tempPaths.push(dir);
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    try {
      await seedEvalPages(engine);

      const report = await evaluateLiveRetrievalFixture(engine, {
        fixture_id: 'retrieval-eval-default-thresholds',
        cases: [{
          id: 'missing-gold',
          route: 'broad_synthesis',
          expected_selected_intent: 'broad_synthesis',
          query: 'hybrid search retrieval method',
          gold_slugs: ['concepts/does-not-exist'],
        }],
      });

      expect(report.status).toBe('failed');
      expect(report.thresholds).toEqual({ top1_match_rate: 1, recall_at_10: 1 });
      expect(report.cases[0]?.status).toBe('failed');
      expect(report.failures[0]?.reason_codes).toContain('recall_at_10_miss');
    } finally {
      await engine.disconnect();
    }
  });

  test('fails when the expected selected intent does not match the trace route', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-retrieval-eval-judge-'));
    tempPaths.push(dir);
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    try {
      await seedEvalPages(engine);

      const report = await evaluateLiveRetrievalFixture(engine, {
        fixture_id: 'retrieval-eval-route-mismatch',
        thresholds: { top1_match_rate: 1, recall_at_10: 1 },
        cases: [{
          id: 'route-mismatch',
          route: 'precision_lookup',
          expected_selected_intent: 'precision_lookup',
          query: 'hybrid search retrieval method',
          gold_slugs: ['concepts/hybrid-search'],
        }],
      });

      expect(report.status).toBe('failed');
      expect(report.cases[0]?.selected_intent).toBe('broad_synthesis');
      expect(report.cases[0]?.route_match).toBe(false);
      expect(report.failures[0]?.reason_codes).toContain('route_mismatch');
    } finally {
      await engine.disconnect();
    }
  });

  test('judges canonical read evidence instead of candidate metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-retrieval-eval-judge-'));
    tempPaths.push(dir);
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    try {
      await seedEvalPages(engine);

      const report = await evaluateLiveRetrievalFixture(engine, {
        fixture_id: 'retrieval-eval-judge',
        thresholds: { top1_match_rate: 1, recall_at_10: 1 },
        cases: [{
          id: 'judge-hybrid-search',
          route: 'broad_synthesis',
          expected_selected_intent: 'broad_synthesis',
          query: 'hybrid search retrieval method',
          gold_slugs: ['concepts/hybrid-search'],
          gold_answer: 'Hybrid search combines keyword and vector retrieval.',
        }],
      }, {
        judge_model: 'judge-model',
        judge_prompt_version: 'v1',
        judge: async (request) => {
          expect(request.evidence_text).toContain('Hybrid search combines keyword retrieval');
          expect(request.candidate_answer).toContain('Hybrid search combines keyword retrieval');
          expect(request.evidence_text).not.toContain('matched_chunk_sources:');
          return {
            score: 0.9,
            passed: true,
            reason: 'grounded',
            model_id: request.judge_model,
            prompt_version: request.prompt_version,
          };
        },
      });

      expect(report.status).toBe('passed');
      expect(report.cases[0]?.read_trace_id).toEqual(expect.any(String));
      expect(report.cases[0]?.judge?.score).toBe(0.9);
      expect(report.retrieved_token_count_total).toBeGreaterThan(0);
    } finally {
      await engine.disconnect();
    }
  });
});

describe('EV-1c per-config live retrieval baselines', () => {
  // Governed-probe configs (embeddings pinned to none) must hold the same
  // floors the SQLite EV-1b gate holds. The stub-embeddings configs exercise
  // the real vector path (backfill -> storage -> query embedding ->
  // engine.searchVector -> RRF fusion) with the deterministic stub-hash-1024
  // provider; the lexical stub demotes the broad multi-topic system page out
  // of a few top-10 windows, so their recall floor is set from what the
  // instrument actually achieves (committed baseline: sqlite 0.8, pglite
  // ~0.783) with the exact baseline comparison as the real regression fence.
  const GOVERNED_PROBE_FLOORS = { recall_at_10: 0.9, mrr: 0.85, route_match_rate: 0.9 };
  const STUB_EMBEDDINGS_FLOORS = { recall_at_10: 0.75, mrr: 0.85, route_match_rate: 0.9 };

  function loadBaseline(name: string): {
    engine: string;
    embedding_provider: string;
    metrics: { recall_at_10: number; mrr: number; top1_match_rate: number; route_match_rate: number };
    cases: Array<{
      id: string;
      status: 'passed' | 'failed';
      top1_slug: string | null;
      top1_match: boolean;
      route_match: boolean | null;
      missing_gold_slugs: string[];
    }>;
  } {
    return JSON.parse(readFileSync(new URL(`./${name}.json`, BASELINE_DIR_URL), 'utf8'));
  }

  function expectFloorsAndBaselineMatch(
    config: P2GoldEvalConfig,
    report: RetrievalEvalReport,
    floors: { recall_at_10: number; mrr: number; route_match_rate: number },
  ) {
    expect(report.case_count).toBe(30);
    expect(report.recall_at_10).toBeGreaterThanOrEqual(floors.recall_at_10);
    expect(report.mrr).toBeGreaterThanOrEqual(floors.mrr);
    expect(p2GoldRouteMatchRate(report)).toBeGreaterThanOrEqual(floors.route_match_rate);

    // The committed baseline is the regression fence: the live run must
    // reproduce it exactly (the regen script is deterministic by contract).
    const baseline = loadBaseline(config.name);
    expect(baseline.engine).toBe(config.engine);
    expect(report.recall_at_10).toBe(baseline.metrics.recall_at_10);
    expect(report.mrr).toBe(baseline.metrics.mrr);
    expect(report.top1_match_rate).toBe(baseline.metrics.top1_match_rate);
    expect(p2GoldRouteMatchRate(report)).toBe(baseline.metrics.route_match_rate);
    expect(report.cases.map((entry) => ({
      id: entry.id,
      status: entry.status,
      top1_slug: entry.top1_slug,
      top1_match: entry.top1_match,
      route_match: entry.route_match,
      missing_gold_slugs: entry.missing_gold_slugs,
    }))).toEqual(baseline.cases.map((entry) => ({
      id: entry.id,
      status: entry.status,
      top1_slug: entry.top1_slug,
      top1_match: entry.top1_match,
      route_match: entry.route_match,
      missing_gold_slugs: entry.missing_gold_slugs,
    })));
  }

  function configByName(name: string): P2GoldEvalConfig {
    const config = P2_GOLD_EVAL_CONFIGS.find((candidate) => candidate.name === name);
    if (!config) throw new Error(`Unknown P2 gold eval config: ${name}`);
    return config;
  }

  test('PGLite governed-probe-on holds the SQLite floors and matches its committed baseline', async () => {
    const config = configByName('pglite-governed-probe-on');
    const { report } = await runP2GoldEvalConfig(config);
    expectFloorsAndBaselineMatch(config, report, GOVERNED_PROBE_FLOORS);
    expect(report.status).toBe('passed');
    expect(report.failures).toEqual([]);
  }, PGLITE_EVAL_TEST_TIMEOUT_MS);

  test('PGLite governed-probe-off holds the SQLite floors and matches its committed baseline', async () => {
    const config = configByName('pglite-governed-probe-off');
    const { report } = await runP2GoldEvalConfig(config);
    expectFloorsAndBaselineMatch(config, report, GOVERNED_PROBE_FLOORS);
    expect(report.status).toBe('passed');
    expect(report.failures).toEqual([]);
  }, PGLITE_EVAL_TEST_TIMEOUT_MS);

  test('SQLite stub-embeddings exercises the vector path end-to-end and matches its committed baseline', async () => {
    const config = configByName('sqlite-stub-embeddings');
    const { report, stub_stats, stub_backfill_stats } = await runP2GoldEvalConfig(config);
    expectFloorsAndBaselineMatch(config, report, STUB_EMBEDDINGS_FLOORS);

    // Prove the vector path actually ran: the stub embedded corpus chunks at
    // backfill time and was called again for query embeddings during the eval.
    expect(stub_backfill_stats!.text_count).toBeGreaterThan(0);
    expect(stub_stats!.batch_count).toBeGreaterThan(stub_backfill_stats!.batch_count);
  });

  test('PGLite stub-embeddings exercises the vector path end-to-end and matches its committed baseline', async () => {
    const config = configByName('pglite-stub-embeddings');
    const { report, stub_stats, stub_backfill_stats } = await runP2GoldEvalConfig(config);
    expectFloorsAndBaselineMatch(config, report, STUB_EMBEDDINGS_FLOORS);
    expect(stub_backfill_stats!.text_count).toBeGreaterThan(0);
    expect(stub_stats!.batch_count).toBeGreaterThan(stub_backfill_stats!.batch_count);
  }, PGLITE_EVAL_TEST_TIMEOUT_MS);
});

describe('retrieval trajectory score', () => {
  test('computes deterministic cost and redundancy without an embedding provider', () => {
    const first = trace({
      id: 'trace-a',
      route: ['retrieve_context', 'read_context'],
      source_refs: [
        'compiled_truth:workspace:default:concepts/hybrid-search',
        'compiled_truth:workspace:default:concepts/compiled-truth',
      ],
      elapsed_ms: 120,
      retrieved_token_count: 80,
    });
    const second = trace({
      id: 'trace-b',
      route: ['retrieve_context', 'retry_vector', 'fallback_search', 'read_context'],
      source_refs: ['compiled_truth:workspace:default:concepts/hybrid-search'],
      elapsed_ms: 60,
      retrieved_token_count: 20,
    });

    const score = scoreRetrievalTrajectory(first, {
      evidence_texts: [
        'Hybrid search combines keyword retrieval with vector retrieval.',
        'Hybrid search combines keyword retrieval with reranking.',
      ],
    });
    expect(score.trace_id).toBe('trace-a');
    expect(score.groundedness).toBeNull();
    expect(score.redundancy_basis).toBe('evidence_text');
    expect(score.cost).toBeGreaterThan(0);
    expect(score.redundancy).toBeGreaterThan(0);
    expect(score.j).toBeLessThanOrEqual(0);

    const summary = summarizeRetrievalTrajectoryScores([score, scoreRetrievalTrajectory(second)]);
    expect(summary.trace_count).toBe(2);
    expect(summary.average_cost).toBeGreaterThan(score.cost);
    expect(summary.groundedness_status).toBe('unavailable_without_gold');
    expect(scoreRetrievalTrajectory(second).re_escalations).toBe(2);
  });
});

async function seedEvalPages(engine: SQLiteEngine) {
  await importFromContent(engine, 'concepts/hybrid-search', [
    '---',
    'type: concept',
    'title: Hybrid Search',
    '---',
    '# Compiled Truth',
    'Hybrid search combines keyword retrieval and vector retrieval for robust recall.',
    '[Source: User, direct message, 2026-07-03 12:00 KST]',
  ].join('\n'), { path: 'concepts/hybrid-search.md' });
  await importFromContent(engine, 'concepts/rebellion-architecture', [
    '---',
    'type: concept',
    'title: 레벨리온 아키텍처',
    '---',
    '# Compiled Truth',
    '레벨리온 아키텍처는 한국어 검색 평가 fixture이며 레벨리온은 CJK prefix 검색으로 찾아야 한다.',
    '[Source: User, direct message, 2026-07-03 12:00 KST]',
  ].join('\n'), { path: 'concepts/rebellion-architecture.md' });
  await importFromContent(engine, 'concepts/compiled-truth', [
    '---',
    'type: concept',
    'title: Compiled Truth',
    '---',
    '# Compiled Truth',
    'Compiled truth distills timeline evidence into current best understanding.',
    '[Source: User, direct message, 2026-07-03 12:00 KST]',
  ].join('\n'), { path: 'concepts/compiled-truth.md' });
}

function trace(input: Partial<RetrievalTrace> & Pick<RetrievalTrace, 'id'>): RetrievalTrace {
  return {
    id: input.id,
    task_id: input.task_id ?? null,
    scope: input.scope ?? 'work',
    route: input.route ?? [],
    source_refs: input.source_refs ?? [],
    derived_consulted: input.derived_consulted ?? [],
    verification: input.verification ?? [],
    write_outcome: input.write_outcome ?? 'no_durable_write',
    selected_intent: input.selected_intent ?? null,
    scope_gate_policy: input.scope_gate_policy ?? null,
    scope_gate_reason: input.scope_gate_reason ?? null,
    elapsed_ms: input.elapsed_ms ?? null,
    retrieved_token_count: input.retrieved_token_count ?? null,
    outcome: input.outcome ?? 'answer_ready:unknown',
    created_at: input.created_at ?? new Date('2026-07-03T12:00:00Z'),
  };
}
