import { describe, expect, test } from 'bun:test';
import { runPhaseRecomputeEmotionalWeight } from '../src/core/cycle/recompute-emotional-weight.ts';
import type {
  EmotionalWeightInputRow,
  EmotionalWeightWriteRow,
} from '../src/core/types.ts';

/**
 * Unit-level coverage for the v0.29 recompute_emotional_weight phase.
 * The full e2e (against PGLite) is in test/e2e/cycle-recompute-emotional-weight-pglite.test.ts.
 */

interface FakeEngine {
  batchLoadEmotionalInputs(slugs?: string[]): Promise<EmotionalWeightInputRow[]>;
  setEmotionalWeightBatch(rows: EmotionalWeightWriteRow[]): Promise<number>;
  getConfig(key: string): Promise<string | null>;
}

function makeEngine(rows: EmotionalWeightInputRow[], configMap: Record<string, string | null> = {}): FakeEngine & {
  written: EmotionalWeightWriteRow[];
  loadCalls: (string[] | undefined)[];
} {
  const written: EmotionalWeightWriteRow[] = [];
  const loadCalls: (string[] | undefined)[] = [];
  return {
    written,
    loadCalls,
    async batchLoadEmotionalInputs(slugs?: string[]) {
      loadCalls.push(slugs);
      if (!slugs) return rows;
      const sset = new Set(slugs);
      return rows.filter(r => sset.has(r.slug));
    },
    async setEmotionalWeightBatch(rs: EmotionalWeightWriteRow[]) {
      written.push(...rs);
      return rs.length;
    },
    async getConfig(key: string) {
      return configMap[key] ?? null;
    },
  };
}

describe('runPhaseRecomputeEmotionalWeight', () => {
  test('zero affected slugs short-circuits — no DB read, no write', async () => {
    const engine = makeEngine([]);
    const r = await runPhaseRecomputeEmotionalWeight(engine as any, { affectedSlugs: [] });
    expect(r.status).toBe('ok');
    expect(r.pages_recomputed).toBe(0);
    expect(engine.loadCalls.length).toBe(0); // skipped batch read
    expect(engine.written.length).toBe(0);
  });

  test('full mode walks every page', async () => {
    const rows: EmotionalWeightInputRow[] = [
      { slug: 'a', source_id: 'default', tags: ['wedding'], takes: [] },
      { slug: 'b', source_id: 'default', tags: [], takes: [] },
    ];
    const engine = makeEngine(rows);
    const r = await runPhaseRecomputeEmotionalWeight(engine as any, {});
    expect(r.status).toBe('ok');
    expect(r.pages_recomputed).toBe(2);
    expect(engine.written.length).toBe(2);
    // Both rows present, with weights from the formula.
    const byslug = Object.fromEntries(engine.written.map(w => [w.slug, w.weight]));
    expect(byslug.a).toBeCloseTo(0.5, 5); // wedding tag
    expect(byslug.b).toBe(0);
  });

  test('incremental mode passes slugs through to engine read', async () => {
    const rows: EmotionalWeightInputRow[] = [
      { slug: 'a', source_id: 'default', tags: ['wedding'], takes: [] },
      { slug: 'b', source_id: 'default', tags: ['family'], takes: [] },
      { slug: 'c', source_id: 'default', tags: [], takes: [] },
    ];
    const engine = makeEngine(rows);
    const r = await runPhaseRecomputeEmotionalWeight(engine as any, { affectedSlugs: ['a', 'c'] });
    expect(r.status).toBe('ok');
    expect(engine.loadCalls[0]).toEqual(['a', 'c']);
    // Filter on the fake engine returns only a + c → both written.
    expect(engine.written.map(w => w.slug).sort()).toEqual(['a', 'c']);
  });

  test('multi-source: writes preserve source_id (no fan-out)', async () => {
    const rows: EmotionalWeightInputRow[] = [
      { slug: 'shared', source_id: 'src-a', tags: ['wedding'], takes: [] },
      { slug: 'shared', source_id: 'src-b', tags: [], takes: [] },
    ];
    const engine = makeEngine(rows);
    await runPhaseRecomputeEmotionalWeight(engine as any, {});
    const sources = engine.written.map(w => w.source_id).sort();
    expect(sources).toEqual(['src-a', 'src-b']);
    const wA = engine.written.find(w => w.source_id === 'src-a');
    const wB = engine.written.find(w => w.source_id === 'src-b');
    expect(wA!.weight).toBeCloseTo(0.5, 5);
    expect(wB!.weight).toBe(0);
  });

  test('dry-run computes weights but skips the UPDATE', async () => {
    const rows: EmotionalWeightInputRow[] = [
      { slug: 'a', source_id: 'default', tags: ['wedding'], takes: [] },
    ];
    const engine = makeEngine(rows);
    const r = await runPhaseRecomputeEmotionalWeight(engine as any, { dryRun: true });
    expect(r.status).toBe('ok');
    expect(r.details.dry_run).toBe(true);
    expect(r.pages_recomputed).toBe(1); // would-write count
    expect(engine.written.length).toBe(0); // but nothing actually written
  });

  test('config override of high_emotion_tags is honored', async () => {
    const rows: EmotionalWeightInputRow[] = [
      { slug: 'p', source_id: 'default', tags: ['hardware-failure'], takes: [] },
    ];
    const engine = makeEngine(rows, {
      'emotional_weight.high_tags': JSON.stringify(['hardware-failure']),
    });
    await runPhaseRecomputeEmotionalWeight(engine as any, {});
    expect(engine.written[0].weight).toBeCloseTo(0.5, 5);
  });

  test('engine throw bubbles into a fail PhaseResult, not an unhandled exception', async () => {
    const engine: FakeEngine = {
      batchLoadEmotionalInputs: async () => { throw new Error('db down'); },
      setEmotionalWeightBatch: async () => 0,
      getConfig: async () => null,
    };
    const r = await runPhaseRecomputeEmotionalWeight(engine as any, {});
    expect(r.status).toBe('fail');
    expect(r.error?.code).toBe('RECOMPUTE_EMOTIONAL_WEIGHT_FAIL');
    expect(r.error?.message).toContain('db down');
  });
});
