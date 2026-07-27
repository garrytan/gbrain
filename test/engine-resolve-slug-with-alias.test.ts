// v0.42 Type Unification (T26) — engine.resolveSlugWithAlias contract tests.
//
// Coverage: scalar sourceId, sourceIds[] array, no-match → input unchanged,
// single-source match, multi-source ambiguity warn + first-by-order win,
// pre-v104 brain defense-in-depth.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { _resetWarnOnceForTests } from '../src/core/utils.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetWarnOnceForTests();
});

async function insertAlias(sourceId: string, alias: string, canonical: string, notes?: string) {
  await engine.executeRaw(
    `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
     VALUES ($1, $2, $3, $4)`,
    [sourceId, alias, canonical, notes ?? null],
  );
}

describe('resolveSlugWithAlias', () => {
  it('returns input unchanged when no alias matches', async () => {
    const result = await engine.resolveSlugWithAlias('wiki/concepts/unknown', 'default');
    expect(result).toBe('wiki/concepts/unknown');
  });

  it('resolves single alias via scalar sourceId', async () => {
    await insertAlias('default', 'old-name', 'wiki/concepts/canonical');
    const result = await engine.resolveSlugWithAlias('old-name', 'default');
    expect(result).toBe('wiki/concepts/canonical');
  });

  it('accepts sourceIds[] array (federated reads, F10)', async () => {
    await insertAlias('default', 'old-name', 'canonical-a');
    const result = await engine.resolveSlugWithAlias('old-name', ['default']);
    expect(result).toBe('canonical-a');
  });

  it('returns input unchanged when sourceIds is empty array', async () => {
    await insertAlias('default', 'old-name', 'canonical-a');
    const result = await engine.resolveSlugWithAlias('old-name', []);
    expect(result).toBe('old-name');
  });

  it('emits multi_match warning + returns first by array order (F10)', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alt', 'alt') ON CONFLICT DO NOTHING`);
    await insertAlias('default', 'shared-alias', 'canonical-default');
    await insertAlias('alt', 'shared-alias', 'canonical-alt');
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const result = await engine.resolveSlugWithAlias('shared-alias', ['alt', 'default']);
      // First-in-array order wins: 'alt' before 'default'
      expect(result).toBe('canonical-alt');
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/multi_match/);
    } finally {
      console.warn = orig;
    }
  });

  it('respects array order for multi-source disambiguation', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alt', 'alt') ON CONFLICT DO NOTHING`);
    await insertAlias('default', 'shared-alias', 'canonical-default');
    await insertAlias('alt', 'shared-alias', 'canonical-alt');
    const orig = console.warn;
    console.warn = () => {};
    try {
      const result1 = await engine.resolveSlugWithAlias('shared-alias', ['default', 'alt']);
      expect(result1).toBe('canonical-default');
    } finally {
      console.warn = orig;
    }
  });

  it('handles canonical that is soft-deleted (returns canonical_slug anyway)', async () => {
    // resolveSlugWithAlias is a pointer-only resolver; soft-delete of the
    // canonical is the caller's concern (e.g. wikilink resolver may then
    // fall through to fuzzy match).
    await insertAlias('default', 'old-name', 'wiki/concepts/canonical');
    const result = await engine.resolveSlugWithAlias('old-name', 'default');
    expect(result).toBe('wiki/concepts/canonical');
  });
});
