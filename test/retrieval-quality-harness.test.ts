/**
 * T6 — NamedThingBench harness unit tests (pure scoring + gate logic).
 */

import { describe, test, expect } from 'bun:test';
import {
  scoreQuestion,
  runRetrievalQuality,
  evaluateGate,
  parseQuestionsJsonl,
  type NamedThingQuestion,
} from '../src/eval/retrieval-quality/harness.ts';

describe('scoreQuestion', () => {
  test('Hit@1 when relevant slug is rank 0', () => {
    const q: NamedThingQuestion = { family: 'title-substring', query: 'x', relevant: ['a'] };
    const r = scoreQuestion(q, ['a', 'b', 'c']);
    expect(r.hit_at_1).toBe(true);
    expect(r.hit_at_3).toBe(true);
    expect(r.reciprocal_rank).toBe(1);
  });
  test('Hit@3 but not Hit@1 when relevant is rank 2', () => {
    const q: NamedThingQuestion = { family: 'title-substring', query: 'x', relevant: ['c'] };
    const r = scoreQuestion(q, ['a', 'b', 'c', 'd']);
    expect(r.hit_at_1).toBe(false);
    expect(r.hit_at_3).toBe(true);
    expect(r.reciprocal_rank).toBeCloseTo(1 / 3, 6);
  });
  test('miss when relevant absent from top-3', () => {
    const q: NamedThingQuestion = { family: 'title-substring', query: 'x', relevant: ['z'] };
    const r = scoreQuestion(q, ['a', 'b', 'c', 'z']);
    expect(r.hit_at_3).toBe(false);
    expect(r.reciprocal_rank).toBeCloseTo(0.25, 6);
  });
  test('hard-negative: clean when forbidden slug absent from top-3', () => {
    const q: NamedThingQuestion = { family: 'hard-negative', query: 'x', forbidden: ['bad'] };
    expect(scoreQuestion(q, ['a', 'b', 'c']).negative_clean).toBe(true);
    expect(scoreQuestion(q, ['a', 'bad', 'c']).negative_clean).toBe(false);
  });
});

describe('evaluateGate', () => {
  async function reportFor(qs: NamedThingQuestion[], ranked: Record<string, string[]>) {
    return runRetrievalQuality(qs, async (query) => ranked[query] ?? []);
  }

  test('passes when hard families meet floors', async () => {
    const qs: NamedThingQuestion[] = [
      { family: 'title-substring', query: 't', relevant: ['p'] },
      { family: 'alias-synonym', query: 'a', relevant: ['p'] },
      { family: 'multi-chunk-dilution', query: 'd', relevant: ['p'] },
    ];
    const report = await reportFor(qs, { t: ['p'], a: ['p'], d: ['p'] });
    const gate = evaluateGate(report);
    expect(gate.pass).toBe(true);
    expect(gate.breaches).toHaveLength(0);
  });

  test('fails when title-substring Hit@1 below floor', async () => {
    const qs: NamedThingQuestion[] = [
      { family: 'title-substring', query: 't', relevant: ['p'] },
    ];
    const report = await reportFor(qs, { t: ['other', 'p'] }); // p at rank 1, not 0
    const gate = evaluateGate(report);
    expect(gate.pass).toBe(false);
    expect(gate.breaches[0].family).toBe('title-substring');
    expect(gate.breaches[0].metric).toBe('hit_at_1');
  });

  test('soft family low score is a warning, not a breach', async () => {
    const qs: NamedThingQuestion[] = [
      { family: 'graph-relationship', query: 'g', relevant: ['p'] },
    ];
    const report = await reportFor(qs, { g: ['x', 'y', 'z', 'p'] }); // miss in top-3
    const gate = evaluateGate(report);
    expect(gate.pass).toBe(true); // soft → no breach
    expect(gate.warnings.some(w => w.family === 'graph-relationship')).toBe(true);
  });

  test('no questions for a hard family → not gated (no false breach)', async () => {
    const qs: NamedThingQuestion[] = [{ family: 'short-vs-rich', query: 's', relevant: ['p'] }];
    const report = await reportFor(qs, { s: ['p'] });
    expect(evaluateGate(report).pass).toBe(true);
  });
});

describe('NamedThingBench fixture privacy guard', () => {
  test('fixture uses placeholder names only (every slug is an *-example)', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const raw = readFileSync(join(import.meta.dir, 'fixtures/retrieval-quality/namedthing.jsonl'), 'utf8').toLowerCase();
    // The load-bearing guard: every relevant/forbidden slug must be an
    // `*-example` placeholder, so no real brain page can be referenced. (We
    // don't enumerate banned real names here — listing them as string literals
    // would itself trip scripts/check-test-real-names.sh.)
    const slugs = [...raw.matchAll(/"(projects|people|notes|companies)\/([a-z0-9-]+)"/g)];
    expect(slugs.length).toBeGreaterThan(0);
    for (const m of slugs) {
      expect(m[2]).toContain('example');
    }
  });
});

describe('parseQuestionsJsonl', () => {
  test('skips blanks + comments', () => {
    const qs = parseQuestionsJsonl(`
{"family":"title-substring","query":"x","relevant":["a"]}
# comment
{"family":"hard-negative","query":"y","forbidden":["b"]}
`);
    expect(qs).toHaveLength(2);
    expect(qs[1].forbidden).toEqual(['b']);
  });
});
