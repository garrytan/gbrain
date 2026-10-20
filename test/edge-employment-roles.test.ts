/**
 * #6953: edge_contradictions' works_at candidates admit only a person-like
 * subject (the pack's person type and its alias closure, per source) and an
 * employer target, before grouping and LIMIT. The judge prompt is unchanged
 * (D7). PGLite here; Postgres through test/e2e/edge-employment-roles-postgres.test.ts.
 * Imports only APIs that predate the fix, so on an unfixed tree the assertions
 * run and fail (personTypesFromPack is tested in schema-pack-person-types-6953).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';
import { PACKS, writeEntityTypePacks } from './helpers/entity-types-pack-fixture.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { testBackends } from './helpers/test-backends.ts';
import { runPhaseEdgeContradictions } from '../src/core/cycle/edge-contradictions.ts';
import { targetTakesVerb } from '../src/core/link-target-roles.ts';
import { extractPageLinks } from '../src/core/link-extraction.ts';
import type { EdgeJudgeFn } from '../src/core/cycle/edge-contradictions.ts';

for (const backend of testBackends()) describe(`employment role admission (${backend})`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    if (backend === 'postgres') {
      const { setupDB } = await import('./e2e/helpers.ts');
      engine = await setupDB();
    } else {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    }
  }, 60_000);
  afterAll(async () => {
    if (backend === 'postgres') {
      const { teardownDB } = await import('./e2e/helpers.ts');
      await teardownDB();
    } else await engine.disconnect();
  });
  beforeEach(async () => {
    if (backend === 'pglite') await resetPgliteState(engine as PGLiteEngine);
    else {
      await engine.executeRaw('DELETE FROM link_edge_proposals');
      await engine.executeRaw('DELETE FROM pages');
    }
    await engine.setConfig('dream.edge_contradictions.mode', 'propose');
    await engine.setConfig('dream.edge_contradictions.max_subjects', '1');
    _resetPackCacheForTests();
  });

  async function page(slug: string, type: string) {
    const p = await engine.putPage(slug, { type, title: slug, compiled_truth: 'Synthetic fixture.' });
    return Number(p.id);
  }
  async function edge(from: number, to: number, type = 'works_at', refreshed = '2020-01-01') {
    await engine.executeRaw(`INSERT INTO link_relationships
      (from_page_id, to_page_id, link_type, scope, source_id, semantics, valid_ranges, status_now, evidence_hash, refreshed_at)
      VALUES ($1, $2, $3, 'all', 'default', 'state', '{[2020-01-01,)}'::datemultirange, 'live', $4, $5::timestamptz)`,
    [from, to, type, `${from}:${to}:${type}`, refreshed]);
  }
  async function judged() {
    const inputs: Array<Parameters<EdgeJudgeFn>[0]> = [];
    await runPhaseEdgeContradictions(engine, { judge: async input => {
      inputs.push(input);
      return [{ a: 1, b: 2, conflict: false, confidence: 0.9 }];
    } });
    return inputs;
  }

  test('mistyped newer groups cannot starve a valid person/employer pair at LIMIT 1', async () => {
    const person = await page('people/alice-example', 'person');
    const a = await page('orgs/acme-example', 'company');
    const b = await page('orgs/widget-example', 'organization');
    await edge(person, a); await edge(person, b);
    for (const type of ['meeting', 'conversation', 'email', 'source', 'note', 'inbox', 'person']) {
      const subject = await page(`people/${type}-example`, 'person');
      const invalid = await page(`arbitrary/${type}-example`, type);
      await edge(subject, a, 'works_at', '2099-01-01');
      await edge(subject, invalid, 'works_at', '2099-01-01');
    }
    const inputs = await judged();
    expect(inputs.map(i => i.subject.slug)).toEqual(['people/alice-example']);
    expect(inputs[0].relationships.map(r => r.target).sort()).toEqual(['orgs/acme-example', 'orgs/widget-example']);
  });

  test('inverted company subject never reaches the judge or writes a proposal', async () => {
    const subject = await page('companies/acme-example', 'company');
    await edge(subject, await page('people/alice-example', 'person'));
    await edge(subject, await page('people/bob-example', 'person'));
    expect(await judged()).toEqual([]);
    expect(await engine.executeRaw('SELECT id FROM link_edge_proposals')).toEqual([]);
  });

  test('filters invalid members before the per-subject relationship cap', async () => {
    const subject = await page('people/alice-example', 'person');
    for (let i = 0; i < 9; i++) await edge(subject, await page(`aaa/note-${i}`, 'note'));
    await edge(subject, await page('orgs/acme-example', 'company'));
    await edge(subject, await page('orgs/widget-example', 'investment-firm'));
    const inputs = await judged();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].relationships.map(r => r.target)).toEqual(['orgs/acme-example', 'orgs/widget-example']);
  });

  test('a pack type aliasing person is a subject; an entity type without the alias is not', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-6953-'));
    try {
      writeEntityTypePacks(home);
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
        await engine.setConfig('schema_pack', PACKS.personAlias);
        await engine.setConfig('dream.edge_contradictions.max_subjects', '5');
        const researcher = await page('researchers/alice-example', 'researcher');
        const lab = await page('labs/acme-lab-example', 'lab');
        const a = await page('orgs/acme-example', 'company');
        const b = await page('orgs/widget-example', 'company');
        await edge(researcher, a); await edge(researcher, b);
        await edge(lab, a, 'works_at', '2099-01-01'); await edge(lab, b, 'works_at', '2099-01-01');
        expect((await judged()).map(i => i.subject.slug)).toEqual(['researchers/alice-example']);
      });
    } finally {
      await engine.executeRaw("DELETE FROM config WHERE key = 'schema_pack'");
      _resetPackCacheForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('unrelated state relations retain organization subjects and document targets', async () => {
    const subject = await page('companies/acme-example', 'company');
    await edge(subject, await page('notes/a-example', 'note'), 'custom_state');
    await edge(subject, await page('notes/b-example', 'note'), 'custom_state');
    expect(await judged()).toHaveLength(1);
  });
});

describe('employment inference and evidence policy', () => {
  test('real link extraction keeps document mentions without inventing employment', async () => {
    for (const type of ['conversation', 'email', 'source', 'note', 'inbox']) {
      const { candidates } = await extractPageLinks('people/alice-example',
        'Alice is the CEO of [Example](arbitrary/example).', {}, 'person',
        { resolve: async name => name }, { targetType: () => type });
      expect(candidates.find(c => c.targetSlug === 'arbitrary/example')?.linkType).toBe('mentions');
    }
  });
  test('document and person targets never take works_at, including untyped conventional paths', () => {
    for (const type of ['conversation', 'email', 'source', 'note', 'inbox', 'person', 'meeting']) {
      expect(targetTakesVerb('works_at', 'arbitrary/example', type)).toBe(false);
    }
    for (const prefix of ['conversations/', 'emails/', 'sources/', 'notes/', 'inbox/', 'people/', 'meetings/']) {
      expect(targetTakesVerb('works_at', `${prefix}example`)).toBe(false);
    }
    expect(targetTakesVerb('works_at', 'orgs/example', 'custom-employer')).toBe(true);
    expect(targetTakesVerb('invested_in', 'people/example', 'person')).toBe(true);
  });
});
