/**
 * #5756 (wave 15 P2.9, S half): a schema pack that declares a legacy-floor
 * type as not extractable (`extractable: false`) removes it from atom
 * extraction. The floor (meeting, source, article, video, book, original)
 * applies only to types the active pack is silent about, so gbrain-base
 * (meeting/source declared true, the rest undeclared) is unchanged, while
 * gbrain-recommended's `source: extractable: false` now holds for atoms the
 * way it already did for facts (facts/eligibility.ts). The active pack is
 * selected through GBRAIN_SCHEMA_PACK inside withEnv, so nothing leaks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { countExtractAtomsBacklog, discoverExtractablePages, unionExtractableTypes } from '../src/core/cycle/extract-atoms.ts';

const LEGACY = ['meeting', 'source', 'article', 'video', 'book', 'original'];

describe('unionExtractableTypes honors an explicit pack exclusion (#5756)', () => {
  test('a floor type the pack declares not extractable is removed; silent floor types stay', () => {
    const r = unionExtractableTypes(['note'], ['source', 'book']);
    expect(r).not.toContain('source');
    expect(r).not.toContain('book');
    for (const t of ['meeting', 'article', 'video', 'original', 'note']) expect(r).toContain(t);
  });

  test('a pack that is silent about every floor type keeps the whole floor', () => {
    const r = unionExtractableTypes(['note'], []);
    for (const t of LEGACY) expect(r).toContain(t);
  });

  test('excluding a non-floor type is a no-op and synthesis outputs stay excluded either way', () => {
    const r = unionExtractableTypes(['concept', 'atom', 'note'], ['writing', 'concept']);
    expect(r).toContain('note');
    for (const t of ['concept', 'atom', 'writing']) expect(r).not.toContain(t);
    for (const t of LEGACY) expect(r).toContain(t);
  });

  test('nonExtractableTypesFromPack names the declared types whose extractable flag resolves to false', async () => {
    const { nonExtractableTypesFromPack, extractableTypesFromPack } = await import('../src/core/schema-pack/extractable.ts');
    const pack = { page_types: [
      { name: 'source', extractable: false },
      { name: 'meeting', extractable: true },
      { name: 'statute', extractable: { prompt_template: 'fidelity' } },
      { name: 'person', extractable: false },
    ] } as never;
    expect([...nonExtractableTypesFromPack(pack)].sort()).toEqual(['person', 'source']);
    expect([...extractableTypesFromPack(pack)].sort()).toEqual(['meeting', 'statute']);
  });
});

describe('discovery under the active pack (#5756)', () => {
  let engine: PGLiteEngine;
  const prose = (n: string) => `A durable statement about ${n}, recorded in prose with enough context to extract. `.repeat(10);

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.putPage('sources/example-statute', { type: 'source', title: 'Example statute', compiled_truth: prose('the statute') } as never);
    await engine.putPage('meetings/example-sync', { type: 'meeting', title: 'Example sync', compiled_truth: prose('the sync') } as never);
  });

  const slugs = async () => (await discoverExtractablePages(engine, 'default')).map(p => p.slug).sort();

  test('gbrain-base (source declared extractable) discovers both pages', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: 'gbrain-base' }, async () => {
      expect(await slugs()).toEqual(['meetings/example-sync', 'sources/example-statute']);
      expect(await countExtractAtomsBacklog(engine, 'default')).toBe(2);
    });
  });

  test('gbrain-recommended (source: extractable false) discovers and counts only the meeting', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: 'gbrain-recommended' }, async () => {
      expect(await slugs()).toEqual(['meetings/example-sync']);
      expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    });
  });
});
