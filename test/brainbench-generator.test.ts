/**
 * BrainBench corpus generator — determinism, holdout discipline, category
 * counts, and the committed corpus being exactly what gen.ts produces.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { generateCorpus, SEED, mulberry32 } from '../evals/brainbench/generator/gen.ts';

describe('generator determinism (decision 22)', () => {
  test('two generateCorpus() calls produce byte-identical fixtures + gold', () => {
    const a = generateCorpus();
    const b = generateCorpus();
    expect(a.length).toBe(b.length);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('mulberry32 is the pinned PRNG (seed 42 first draws)', () => {
    const rng = mulberry32(SEED);
    const first = [rng(), rng(), rng()];
    const rng2 = mulberry32(SEED);
    expect([rng2(), rng2(), rng2()]).toEqual(first);
  });

  test('committed corpus == generator output (no hand-edited drift in gen-* files)', () => {
    const emitted = generateCorpus();
    const byId = new Map(emitted.map((e) => [e.fixture.fixture_id as string, e]));
    const files = readdirSync('evals/brainbench/fixtures').filter((f) => f.startsWith('gen-'));
    expect(files.length).toBe(emitted.length);
    // spot-check every 10th file byte-for-byte (full check would be slow-ish but fine; do all)
    for (const f of files) {
      const onDisk = readFileSync(`evals/brainbench/fixtures/${f}`, 'utf-8');
      const id = f.replace('.fixture.json', '');
      const expected = JSON.stringify(byId.get(id)!.fixture, null, 2) + '\n';
      expect(onDisk).toBe(expected);
      const goldOnDisk = readFileSync(`evals/brainbench/gold/${id}.gold.json`, 'utf-8');
      expect(goldOnDisk).toBe(JSON.stringify(byId.get(id)!.gold, null, 2) + '\n');
    }
  });
});

describe('corpus shape', () => {
  const emitted = generateCorpus();

  test('category counts match the ledger contract', () => {
    const byCat = new Map<string, number>();
    for (const e of emitted) {
      const cat = e.fixture.category as string;
      byCat.set(cat, (byCat.get(cat) ?? 0) + 1);
    }
    expect(byCat.get('kta-pos')).toBe(25);
    expect(byCat.get('kta-neg')).toBe(15);
    expect(byCat.get('push')).toBe(20);
    expect(byCat.get('write-back')).toBe(20);
    expect(byCat.get('continuity')).toBe(30); // 15 pairs
    expect(byCat.get('multi-source')).toBe(10);
    expect(byCat.get('adversarial')).toBe(15);
  });

  test('holdout ≈15% and continuity pairs always move together', () => {
    const holdout = emitted.filter((e) => (e.fixture as { holdout?: boolean }).holdout);
    expect(holdout.length / emitted.length).toBeGreaterThan(0.1);
    expect(holdout.length / emitted.length).toBeLessThan(0.25);
    const byPair = new Map<string, Set<boolean>>();
    for (const e of emitted) {
      const cont = e.fixture.continuity as { pair_id: string } | undefined;
      if (!cont) continue;
      const set = byPair.get(cont.pair_id) ?? new Set<boolean>();
      set.add(!!(e.fixture as { holdout?: boolean }).holdout);
      byPair.set(cont.pair_id, set);
    }
    for (const [, set] of byPair) expect(set.size).toBe(1);
  });

  test('hard know-to-ask variants exist (lowercase + surname-only — the measured reflex limits)', () => {
    const ktaTexts = emitted
      .filter((e) => e.fixture.category === 'kta-pos')
      .flatMap((e) => (e.fixture.turns as Array<{ text: string }>).map((t) => t.text));
    expect(ktaTexts.some((t) => t.startsWith('remind me what'))).toBe(true); // lowercase variant
    expect(ktaTexts.some((t) => t.startsWith('Did ') && t.includes('ever follow up'))).toBe(true); // surname variant
  });

  test('multi-source fixtures declare teambrain and keep active_source=default', () => {
    const ms = emitted.filter((e) => e.fixture.category === 'multi-source');
    for (const e of ms) {
      expect(e.fixture.sources).toEqual(['teambrain']);
      expect(e.fixture.active_source).toBe('default');
    }
  });
});
