/**
 * Protects ambient source selection at the production probe/search boundary.
 * Dropping sourceId admits private text to the judge and persisted report.
 * Existing runner tests inject searchFn and cannot catch that omission.
 * Uses real retrieval with synthetic pages; only the paid judge is injected.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runContradictionProbe } from '../src/core/eval-contradictions/runner.ts';
import type { JudgeInput } from '../src/core/eval-contradictions/judge.ts';
import { loadTrend, writeRunRow } from '../src/core/eval-contradictions/trends.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('embedding_disabled', 'true');
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('company', 'Company'), ('private', 'Private')");
  for (const [sourceId, slug, text] of [
    ['company', 'notes/policy-a', 'zephyrpolicy retention is thirty days'],
    ['company', 'notes/policy-b', 'zephyrpolicy retention is sixty days'],
    ['private', 'notes/private-policy', 'zephyrpolicy private-marker retention is ninety days'],
  ]) {
    await engine.putPage(slug, { type: 'note', title: 'zephyrpolicy', compiled_truth: text }, { sourceId });
    await installFixtureChunks(engine, slug, [
      { chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' },
    ], { sourceId });
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function probe(source: string) {
  const judged: JudgeInput[] = [];
  const out = await withEnv({ GBRAIN_SOURCE: source }, () => runContradictionProbe({
    engine,
    queries: ['zephyrpolicy'],
    judgeModel: 'anthropic:claude-haiku-4-5',
    noCache: true,
    judgeFn: async (input) => {
      judged.push(input);
      return {
        verdict: {
          verdict: 'contradiction', severity: 'medium', confidence: 0.9,
          axis: 'retention', resolution_kind: 'dream_synthesize',
        },
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  }));
  return { ...out, judged };
}

test('selected source excludes private text from retrieval, judging and the stored report', async () => {
  const { report, judged } = await probe('company');
  expect(report.per_query[0].result_count).toBe(2);
  expect(judged).toHaveLength(1);
  expect(report.total_contradictions_flagged).toBe(1);
  expect(JSON.stringify(judged)).not.toContain('private-marker');
  await writeRunRow(engine, report, report.duration_ms);
  const rows = await loadTrend(engine, 1);
  const stored = rows.find((row) => row.run_id === report.run_id);
  expect(stored).toBeDefined();
  expect(stored!.report_json.per_query[0].result_count).toBe(2);
  expect(JSON.stringify(stored!.report_json)).not.toContain('private-marker');
}, 60_000);

test('existing all-sources selection retains whole-brain probing', async () => {
  const { report, judged } = await probe('__all__');
  expect(report.per_query[0].result_count).toBe(3);
  expect(judged).toHaveLength(3);
  expect(JSON.stringify(judged)).toContain('private-marker');
}, 60_000);

test('an unknown selected source refuses instead of probing every source', async () => {
  await expect(probe('missing-source')).rejects.toThrow();
});
