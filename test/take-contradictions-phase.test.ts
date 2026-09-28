import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { ALL_PHASES } from '../src/core/cycle.ts';
import { runPhaseTakeContradictions, __testing } from '../src/core/cycle/take-contradictions.ts';
import { generateActiveTakesPairs } from '../src/core/eval-contradictions/active-takes-pairing.ts';
import { buildJudgePrompt } from '../src/core/eval-contradictions/judge.ts';
import { loadTrend } from '../src/core/eval-contradictions/trends.ts';
import type { JudgeOutput } from '../src/core/eval-contradictions/judge.ts';

let engine: PGLiteEngine;
let alicePageId: number;
let bobPageId: number;
let aliceTakeId: number;
let bobTakeId: number;

const SAME_VECTOR = new Float32Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const alice = await engine.putPage('people/alice-example', { title: 'Alice', type: 'person', compiled_truth: 'Alice content' });
  const bob = await engine.putPage('people/bob-example', { title: 'Bob', type: 'person', compiled_truth: 'Bob content' });
  alicePageId = alice.id;
  bobPageId = bob.id;

  await engine.addTakesBatch([
    { page_id: alicePageId, row_num: 1, claim: 'The Q3 launch will ship on time', kind: 'take', holder: 'alice', weight: 0.6 },
    { page_id: bobPageId, row_num: 1, claim: 'The Q3 launch will slip past Q3', kind: 'take', holder: 'bob', weight: 0.6 },
  ]);

  const rows = await engine.executeRaw<{ id: number; page_id: number }>(
    'SELECT id, page_id FROM takes WHERE page_id = ANY($1::int[]) ORDER BY page_id',
    [[alicePageId, bobPageId]],
  );
  aliceTakeId = rows.find((r) => r.page_id === alicePageId)!.id;
  bobTakeId = rows.find((r) => r.page_id === bobPageId)!.id;

  // Same embedding on both → they're each other's nearest neighbor, on
  // different pages, so the topical clustering pass pairs them.
  await engine.updateTakeEmbeddings([
    { take_id: aliceTakeId, embedding: SAME_VECTOR },
    { take_id: bobTakeId, embedding: SAME_VECTOR },
  ]);
});

afterAll(async () => {
  await engine.disconnect();
});

const contradictionJudge = async (): Promise<JudgeOutput> => ({
  verdict: { verdict: 'contradiction', severity: 'high', axis: 'launch timing', confidence: 0.95, resolution_kind: null },
  usage: { inputTokens: 10, outputTokens: 10 },
});
const noContradictionJudge = async (): Promise<JudgeOutput> => ({
  verdict: { verdict: 'no_contradiction', severity: 'info', axis: '', confidence: 0.9, resolution_kind: null },
  usage: { inputTokens: 10, outputTokens: 10 },
});

describe('runPhaseTakeContradictions — core verification', () => {
  test('genuine cross-holder contradiction: found, traced to both source pages, manual_review, no mutation', async () => {
    await engine.setConfig('dream.take_contradictions.enabled', 'true');
    await engine.setConfig('dream.take_contradictions.budget', '1.0');

    const r = await runPhaseTakeContradictions(engine, {
      dryRun: false,
      judgeFn: contradictionJudge,
      noCache: true,
    });

    expect(r.status).toBe('complete');
    const totals = r.totals as { candidates: number; judged: number; contradictions_found: number };
    expect(totals.candidates).toBeGreaterThanOrEqual(1);
    expect(totals.judged).toBeGreaterThanOrEqual(1);
    expect(totals.contradictions_found).toBe(1);

    // Landed in the SAME eval_contradictions_runs table the CLI probe uses — no new table.
    const trend = await loadTrend(engine, 1);
    expect(trend.length).toBeGreaterThanOrEqual(1);
    const findings = trend[0]!.report_json.per_query.flatMap((pq) => pq.contradictions).filter((f) => f.kind === 'active_takes');
    expect(findings.length).toBe(1);
    const finding = findings[0]!;

    // Traces to both source pages/holders.
    const slugs = [finding.a.slug, finding.b.slug].sort();
    expect(slugs).toEqual(['people/alice-example', 'people/bob-example']);
    const holders = [finding.a.holder, finding.b.holder].sort();
    expect(holders).toEqual(['alice', 'bob']);

    // Must NOT auto-accept: always manual_review for a genuine active_takes contradiction,
    // never one of the auto-applying kinds (takes_supersede/dream_synthesize).
    expect(finding.resolution_kind).toBe('manual_review');
    expect(finding.resolution_command).toContain('people/alice-example');
    expect(finding.resolution_command).toContain('people/bob-example');

    // Never mutated either take.
    const rows = await engine.executeRaw<{ active: boolean; resolved_at: string | null; superseded_by: number | null }>(
      'SELECT active, resolved_at, superseded_by FROM takes WHERE id = ANY($1::int[])',
      [[aliceTakeId, bobTakeId]],
    );
    for (const row of rows) {
      expect(row.active).toBe(true);
      expect(row.resolved_at).toBeNull();
      expect(row.superseded_by).toBeNull();
    }

    await engine.setConfig('dream.take_contradictions.enabled', 'false');
  });

  test('a still-open finding is carried forward when the next run does not re-detect it (never silently buried)', async () => {
    await engine.setConfig('dream.take_contradictions.enabled', 'true');
    // First run: detect it.
    await runPhaseTakeContradictions(engine, { dryRun: false, judgeFn: contradictionJudge, noCache: true });

    // Second run: judge now says no_contradiction for the (still-existing) pair — simulates
    // a pass that doesn't re-flag it, e.g. transient judge disagreement — but the prior
    // finding must still be visible afterward, not silently overwritten away.
    const r2 = await runPhaseTakeContradictions(engine, { dryRun: false, judgeFn: noContradictionJudge, noCache: true });
    const totals2 = r2.totals as { carried_forward: number };
    expect(totals2.carried_forward).toBeGreaterThanOrEqual(1);

    const trend = await loadTrend(engine, 1);
    const findings = trend[0]!.report_json.per_query.flatMap((pq) => pq.contradictions).filter((f) => f.kind === 'active_takes');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.status === 'open')).toBe(true);

    await engine.setConfig('dream.take_contradictions.enabled', 'false');
  });
});

describe('buildJudgePrompt — crossHolderDisagreementCounts regression guard', () => {
  const base = {
    query: 'q',
    a: { slug: 'a', text: 'text a', holder: 'alice' },
    b: { slug: 'b', text: 'text b', holder: 'bob' },
    maxPairChars: 1500,
  };

  test('undefined/false is byte-identical to the existing prompt', () => {
    const withFalse = buildJudgePrompt({ ...base, crossHolderDisagreementCounts: false });
    const withUndefined = buildJudgePrompt(base);
    expect(withFalse).toBe(withUndefined);
    expect(withFalse).toContain('Opinions held by DIFFERENT holders are not');
    expect(withFalse).toContain("User's query:");
  });

  test('true rewrites the different-holders rule and drops query-relevance framing', () => {
    const withTrue = buildJudgePrompt({ ...base, crossHolderDisagreementCounts: true });
    expect(withTrue).not.toContain('Opinions held by DIFFERENT holders are not');
    expect(withTrue).toContain('DIFFERENT named holders');
    expect(withTrue).not.toContain("User's query:");
    expect(withTrue).not.toContain('unrelated to the user\'s query');
  });
});

describe('generateActiveTakesPairs — clustering', () => {
  test('pairs the two different-holder, different-page takes via the topical/embedding pass', async () => {
    const pairs = await generateActiveTakesPairs(engine, {
      maxCandidateTakes: 300, maxPerHolderPairs: 5, maxNeighborsPerTake: 3,
    });
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs.every((p) => p.a.slug !== p.b.slug)).toBe(true);
  });

  test('two takes on the SAME page are never paired (that is intra_page_chunk_take\'s job)', async () => {
    const page = await engine.putPage('people/same-page-example', { title: 'Same', type: 'person', compiled_truth: 'x' });
    await engine.addTakesBatch([
      { page_id: page.id, row_num: 1, claim: 'X is true', kind: 'take', holder: 'carol', weight: 0.6 },
      { page_id: page.id, row_num: 2, claim: 'X is false', kind: 'take', holder: 'carol', weight: 0.6 },
    ]);
    const pairs = await generateActiveTakesPairs(engine, {
      maxCandidateTakes: 300, maxPerHolderPairs: 5, maxNeighborsPerTake: 3,
    });
    expect(pairs.some((p) => p.a.slug === 'people/same-page-example' && p.b.slug === 'people/same-page-example')).toBe(false);
  });
});

describe('runPhaseTakeContradictions — gating', () => {
  test('disabled by default → skipped', async () => {
    await engine.setConfig('dream.take_contradictions.enabled', 'false');
    const r = await runPhaseTakeContradictions(engine, { dryRun: false });
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('false');
  });

  test('forceEnabled (--once) bypasses the gate', async () => {
    await engine.setConfig('dream.take_contradictions.enabled', 'false');
    const r = await runPhaseTakeContradictions(engine, {
      dryRun: false, forceEnabled: true, judgeFn: noContradictionJudge,
    });
    expect(r.status).not.toBe('skipped');
  });

  test('dry-run reports candidate count without judging', async () => {
    await engine.setConfig('dream.take_contradictions.enabled', 'true');
    let judgeCalls = 0;
    const r = await runPhaseTakeContradictions(engine, {
      dryRun: true,
      judgeFn: async () => { judgeCalls += 1; return noContradictionJudge(); },
    });
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('dry-run');
    expect(judgeCalls).toBe(0);
    await engine.setConfig('dream.take_contradictions.enabled', 'false');
  });
});

test('take_contradictions is registered in ALL_PHASES', () => {
  expect(ALL_PHASES).toContain('take_contradictions');
});

test('internal config loader defaults match documented defaults when unset', async () => {
  // Unit-level: a minimal getConfig-only stub, not a second PGLiteEngine
  // (scripts/check-test-isolation.sh rule R3 — one real engine per file,
  // created in beforeAll). loadTakeContradictionsConfig only ever calls
  // engine.getConfig, so that's all this stub needs to satisfy.
  const stubEngine = { getConfig: async () => null } as unknown as BrainEngine;
  const cfg = await __testing.loadTakeContradictionsConfig(stubEngine);
  expect(cfg).toEqual({
    enabled: false, budgetUsd: 1.0, maxPerCycle: 20,
    maxCandidateTakes: 300, maxPerHolderPairs: 5, maxNeighborsPerTake: 3,
  });
});
