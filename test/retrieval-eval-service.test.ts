import { afterEach, describe, expect, test } from 'bun:test';
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

const tempPaths: string[] = [];
const WAVE3_DG1_ARTIFACT_URL = new URL('./fixtures/retrieval-eval/wave3-dg1-non-regression.json', import.meta.url);
const P2_GOLD_FIXTURE_URL = new URL('./fixtures/retrieval-eval/p2-gold.jsonl', import.meta.url);

afterEach(() => {
  while (tempPaths.length > 0) {
    rmSync(tempPaths.pop()!, { recursive: true, force: true });
  }
});

describe('live retrieval eval harness', () => {
  test('records the EV-1 non-regression artifact for the DG-1 default flip', () => {
    const artifact = JSON.parse(readFileSync(WAVE3_DG1_ARTIFACT_URL, 'utf8'));

    expect(artifact).toMatchObject({
      artifact_kind: 'ev1_live_retrieval_non_regression',
      gate: 'EV-1',
      evaluated_change: 'RQ-7 retrieval_governed_probe_hybrid default-on',
      fixture_id: 'retrieval-eval-basic',
      fixture_path: 'test/fixtures/retrieval-eval/basic.jsonl',
      status: 'passed',
      thresholds: {
        top1_match_rate: 1,
        recall_at_10: 1,
      },
      metrics: {
        case_count: 3,
        top1_match_rate: 1,
        recall_at_10: 1,
        mrr: 1,
      },
    });
    expect(artifact.config['retrieval.governed_probe_hybrid']).toBe(true);
    expect(artifact.cases.every((entry: { status?: string }) => entry.status === 'passed')).toBe(true);
    expect(artifact.failures).toEqual([]);
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
      expect(report.cases.find((entry) => entry.id === 'korean-rebellion')?.candidate_slugs)
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
