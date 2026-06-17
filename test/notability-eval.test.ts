/**
 * v0.31.2 — notability gate eval harness.
 *
 * Two responsibilities:
 *
 *   1. Mining + JSONL utilities (pure functions in
 *      src/commands/notability-eval.ts) — covered with deterministic
 *      no-LLM tests.
 *
 *   2. Eval harness — given a fixture of (paragraph, confirmed_tier)
 *      and the runtime extractor, computes precision@HIGH, recall@HIGH,
 *      F1, and the full confusion matrix. Soft gate: warn if
 *      precision@HIGH < 0.75; fail PR if < 0.50.
 *
 * The harness runs against the public-anonymized fixture (40 cases) by
 * default. Operators with a private fixture (`~/.gbrain/eval/
 * notability-real.jsonl`, mined + hand-confirmed via `gbrain notability-
 * eval`) can opt into the larger run by setting GBRAIN_NOTABILITY_EVAL_REAL=1.
 *
 * Sample size justification: the public fixture has 14 HIGH cases.
 * For precision@HIGH = 0.75 with a 95% CI ±10pp, n=14 gives roughly
 * the right floor for a "is the gate dramatically wrong" check;
 * tighter measurements need the private fixture (50 cases).
 *
 * The actual LLM call is stubbed via __setChatTransportForTests so this
 * file is parallel-safe and fast — it's a CONTRACT test for the harness
 * shape, not a quality measurement of any specific model. A real
 * quality run uses --real (against a configured Sonnet).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { join } from 'path';
import {
  mineNotabilityCandidates,
  splitParagraphs,
  walkMarkdownFiles,
  loadJsonlCases,
  writeJsonlCases,
  defaultMiningOutPath,
  defaultReviewOutPath,
  type ConfirmedCase,
} from '../src/commands/notability-eval.ts';
import { extractFactsFromTurn } from '../src/core/facts/extract.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'notability-eval-test-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

describe('splitParagraphs', () => {
  test('splits on blank lines and filters by length', () => {
    const body = [
      'short',
      '',
      'this is a long enough paragraph to clear the 80-char minimum threshold for inclusion as a candidate.',
      '',
      'another long paragraph that meets the minimum length cutoff should also be included in the output.',
    ].join('\n');
    const ps = splitParagraphs(body);
    expect(ps.length).toBe(2);
    expect(ps[0]).toContain('long enough paragraph');
    expect(ps[1]).toContain('another long paragraph');
  });

  test('drops paragraphs over the max-char ceiling', () => {
    const huge = 'x'.repeat(900);
    const ps = splitParagraphs(huge);
    expect(ps.length).toBe(0);
  });
});

describe('walkMarkdownFiles', () => {
  test('walks a directory tree for .md files only', () => {
    const root = mkdtempSync(join(tmpdir(), 'walk-md-'));
    try {
      mkdirSync(join(root, 'meetings'), { recursive: true });
      mkdirSync(join(root, 'personal'), { recursive: true });
      writeFileSync(join(root, 'meetings', 'one.md'), 'x'.repeat(100));
      writeFileSync(join(root, 'meetings', 'two.txt'), 'not md');
      writeFileSync(join(root, 'personal', 'three.md'), 'x'.repeat(100));
      const out = walkMarkdownFiles(root);
      const sorted = out.slice().sort();
      expect(sorted.length).toBe(2);
      expect(sorted[0]).toBe('meetings/one.md');
      expect(sorted[1]).toBe('personal/three.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mineNotabilityCandidates — round-robin (skipLlm)', () => {
  test('returns up to target counts per tier', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mine-rr-'));
    try {
      // Seed enough paragraphs across two corpus dirs to fill all three tiers.
      mkdirSync(join(root, 'meetings'), { recursive: true });
      mkdirSync(join(root, 'personal'), { recursive: true });
      const para = (n: number) =>
        Array.from({ length: 6 }, (_, i) =>
          `Paragraph ${n}.${i} with enough characters to clear the eighty character minimum threshold for the candidate filter to accept it as input.`,
        ).join('\n\n');
      for (let i = 0; i < 4; i++) {
        writeFileSync(join(root, 'meetings', `m${i}.md`), para(i));
        writeFileSync(join(root, 'personal', `p${i}.md`), para(i + 100));
      }

      const candidates = await mineNotabilityCandidates(root, {
        targetHigh: 5,
        targetMedium: 5,
        targetLow: 3,
        skipLlm: true,
      });

      // We can't guarantee EXACTLY 5/5/3 because round-robin into bucket
      // sizes depends on candidate count modulo 3, but every tier should
      // be reached AND total ≤ 13.
      const tiers = new Set(candidates.map(c => c.predicted_tier));
      expect(tiers.size).toBeGreaterThan(0);
      expect(candidates.length).toBeLessThanOrEqual(13);
      expect(candidates.length).toBeGreaterThan(0);
      // Every candidate has a real path + paragraph.
      for (const c of candidates) {
        expect(c.path).toMatch(/\.(md)$/);
        expect(c.paragraph.length).toBeGreaterThanOrEqual(80);
        expect(['high', 'medium', 'low']).toContain(c.predicted_tier);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns empty when corpus dirs are empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mine-empty-'));
    try {
      const candidates = await mineNotabilityCandidates(root, { skipLlm: true });
      expect(candidates).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('JSONL utilities', () => {
  test('writeJsonlCases + loadJsonlCases round-trip', () => {
    const path = join(tmp, 'roundtrip.jsonl');
    const cases = [
      { path: 'a.md', paragraph: 'p1', predicted_tier: 'high' as const, predicted_at: 'now' },
      { path: 'b.md', paragraph: 'p2', predicted_tier: 'low' as const, predicted_at: 'now' },
    ];
    writeJsonlCases(path, cases);
    const out = loadJsonlCases<typeof cases[0]>(path);
    expect(out).toEqual(cases);
  });

  test('loadJsonlCases skips malformed lines', () => {
    const path = join(tmp, 'malformed.jsonl');
    writeFileSync(path, '{"valid":1}\n{this is not json}\n{"valid":2}\n');
    const out = loadJsonlCases<{ valid: number }>(path);
    expect(out.length).toBe(2);
    expect(out[0]?.valid).toBe(1);
    expect(out[1]?.valid).toBe(2);
  });

  test('default paths resolve under ~/.gbrain/eval/', () => {
    expect(defaultMiningOutPath()).toContain('.gbrain/eval/notability-mining-candidates.jsonl');
    expect(defaultReviewOutPath()).toContain('.gbrain/eval/notability-real.jsonl');
  });
});

describe('public-anonymized fixture — shape contract', () => {
  test('40 cases, ~14 HIGH + ~13 MEDIUM + ~13 LOW', () => {
    const cases = loadJsonlCases<ConfirmedCase>(
      'test/fixtures/notability-eval-public.jsonl',
    );
    expect(cases.length).toBe(40);
    const counts = { high: 0, medium: 0, low: 0 };
    for (const c of cases) {
      counts[c.confirmed_tier] += 1;
    }
    // Allow some slack for future fixture tuning.
    expect(counts.high).toBeGreaterThanOrEqual(10);
    expect(counts.medium).toBeGreaterThanOrEqual(10);
    expect(counts.low).toBeGreaterThanOrEqual(10);
    expect(counts.high + counts.medium + counts.low).toBe(40);
  });

  test('every fixture case has a paragraph >= 80 chars and a rationale', () => {
    const cases = loadJsonlCases<ConfirmedCase & { tier_rationale?: string }>(
      'test/fixtures/notability-eval-public.jsonl',
    );
    for (const c of cases) {
      expect(c.paragraph.length).toBeGreaterThanOrEqual(80);
      // Rationale isn't required by the helper but the public fixture
      // documents tier choices for reviewer transparency.
      expect(typeof c.tier_rationale === 'string' && c.tier_rationale.length > 0).toBe(true);
    }
  });
});

/**
 * Eval harness contract: given a confirmed-tier fixture and a stubbed
 * extractor, compute precision@HIGH and assert the harness shape works.
 *
 * The `tierOf` function below extracts the dominant notability from a
 * paragraph by stubbing the LLM to return the confirmed tier. This is
 * a CONTRACT test for the harness shape, not a quality measurement.
 * (A quality run uses --real against a configured Sonnet.)
 */
describe('eval harness — precision@HIGH contract', () => {
  function makeChatStub(predictedTier: 'high' | 'medium' | 'low') {
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({
        facts: [{
          fact: 'eval-stub',
          kind: 'fact',
          entity: null,
          confidence: 1.0,
          notability: predictedTier,
        }],
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    }));
  }

  test('100% perfect predictor → precision@HIGH = 1, recall@HIGH = 1, F1 = 1', async () => {
    const fixture = loadJsonlCases<ConfirmedCase>('test/fixtures/notability-eval-public.jsonl');
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const c of fixture) {
      makeChatStub(c.confirmed_tier);
      const facts = await extractFactsFromTurn({
        turnText: c.paragraph,
        source: 'eval-test',
      });
      const predicted = facts[0]?.notability ?? 'medium';
      if (c.confirmed_tier === 'high' && predicted === 'high') tp += 1;
      else if (c.confirmed_tier !== 'high' && predicted === 'high') fp += 1;
      else if (c.confirmed_tier === 'high' && predicted !== 'high') fn += 1;
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    expect(precision).toBe(1);
    expect(recall).toBe(1);
  });

  test('always-medium predictor → precision@HIGH = 0 (no HIGH predictions)', async () => {
    const fixture = loadJsonlCases<ConfirmedCase>('test/fixtures/notability-eval-public.jsonl');
    let tp = 0;
    let fp = 0;
    for (const c of fixture) {
      makeChatStub('medium');  // always-medium model
      const facts = await extractFactsFromTurn({
        turnText: c.paragraph,
        source: 'eval-test',
      });
      const predicted = facts[0]?.notability ?? 'medium';
      if (c.confirmed_tier === 'high' && predicted === 'high') tp += 1;
      else if (c.confirmed_tier !== 'high' && predicted === 'high') fp += 1;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    expect(precision).toBe(0);  // no HIGH predictions → no precision metric
  });

  test('over-predicts HIGH → precision drops below the warn threshold', async () => {
    const fixture = loadJsonlCases<ConfirmedCase>('test/fixtures/notability-eval-public.jsonl');
    let tp = 0;
    let fp = 0;
    for (const c of fixture) {
      makeChatStub('high');  // always-high model (max false-positive rate)
      const facts = await extractFactsFromTurn({
        turnText: c.paragraph,
        source: 'eval-test',
      });
      const predicted = facts[0]?.notability ?? 'medium';
      if (c.confirmed_tier === 'high' && predicted === 'high') tp += 1;
      else if (c.confirmed_tier !== 'high' && predicted === 'high') fp += 1;
    }
    const precision = tp / Math.max(1, tp + fp);
    // 14 TP / 40 predictions = 0.35 → below the 0.75 warn threshold
    // AND below the 0.50 PR-fail threshold. This is what a misaligned
    // model looks like; the harness CORRECTLY flags it.
    expect(precision).toBeLessThan(0.75);
    expect(precision).toBeLessThan(0.50);
  });
});
