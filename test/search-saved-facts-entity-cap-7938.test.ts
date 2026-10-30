/**
 * Value: protects=correction decisions survive the word-match cap and entity
 * enrichment; fails_when=an omitted corrected fact returns as current through
 * its entity copy; why_new=earlier cap tests have no resolved entity;
 * seam=none; no_claim=semantic correction detection or query fact-row ranking.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { SAVED_FACTS_SUPERSEDE_KEY } from '../src/core/search/saved-facts-match.ts';
import { entitySavedFacts } from '../src/core/search/entity-facts.ts';
import { resolveQueryEntity } from '../src/core/search/alias-fanout.ts';
import { testBackends } from './helpers/test-backends.ts';
import { setupDB, teardownDB } from './e2e/helpers.ts';

type SavedFact = { id: number; fact: string; corrected_by?: number };
for (const backend of testBackends()) describe(`${backend}: entity saved-fact correction cap`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    if (backend === 'postgres') engine = await setupDB();
    else {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    }
    await engine.setConfig('search.query_facts_arm', 'false');
    await engine.setConfig('search.query_facts_block', 'false');
  }, 180_000);
  beforeEach(async () => { await engine.executeRaw('DELETE FROM facts'); });
  afterAll(async () => {
    if (backend === 'postgres') await teardownDB();
    else await engine?.disconnect();
  });

  async function seed(name: string, fillers: number, visibility = 'world') {
    const slug = `companies/${name.toLowerCase()}`;
    await importFromContent(engine, slug, serializeMarkdown({}, `${name} is a customer account.`, '', { type: 'company', title: name, tags: [] }), { noEmbed: true });
    async function fact(text: string, entity: string | null, at: string, vis = 'world') {
      const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts
        (source_id, entity_slug, fact, kind, visibility, source, valid_from)
        VALUES ('default', $1, $2, 'fact', $3, 'fixture', $4::timestamptz) RETURNING id`, [entity, text, vis, at]);
      return Number(row.id);
    }
    const text = `${name} renewal seats plan has 52 seats.`;
    const old = await fact(text, slug, '2026-01-01T00:00:00Z');
    const copy = await fact(text, slug, '2026-01-01T00:00:00Z');
    const correction = await fact(`Correction: ${name} seats are 46, ignore the 52.`, null, '2026-01-02T00:00:00Z', visibility);
    for (let i = 0; i < fillers; i++) await fact(`${name} renewal seats plan records 46 and 52 for desk ${String.fromCharCode(97 + i)}.`, null, '2026-01-03T00:00:00Z');
    const query = `${name} renewal seats plan`;
    const entity = await resolveQueryEntity(engine, query, { sourceId: 'default', excludePrivate: true });
    expect(entity).toBeDefined();
    const own = await entitySavedFacts(engine, entity!, { remote: true, excludePrivate: true });
    expect(own.some(f => f.id === copy)).toBe(true);
    return { query, old, copy, correction, text };
  }
  async function call(op: 'search' | 'query', query: string) {
    const result = await dispatchToolCall(engine, op, { query }, { remote: true, transport: 'http', sourceId: 'default' });
    expect(result.isError).toBeFalsy();
    const facts = (result._meta?.retrieval as { saved_facts?: SavedFact[] })?.saved_facts ?? [];
    return { facts, text: result.content.map(c => c.text ?? '').join('\n') };
  }

  test('neither collapsed entity copy resurrects a fact whose corrector the cap cut', async () => {
    const f = await seed('Capstone', 5);
    for (const op of ['search', 'query'] as const) {
      const { facts, text } = await call(op, f.query);
      expect(facts.map(r => r.id)).not.toContain(f.old);
      expect(facts.map(r => r.id)).not.toContain(f.copy);
      expect(facts.map(r => r.id)).not.toContain(f.correction);
      expect(facts).toHaveLength(5);
      expect(text).not.toContain(f.text);
    }
  }, 30_000);

  test('an entity copy outside the match cap stays labelled when its corrector is returned', async () => {
    const f = await seed('Labelstone', 4);
    for (const op of ['search', 'query'] as const) {
      const { facts, text } = await call(op, f.query);
      expect(facts.map(r => r.id)).toContain(f.correction);
      expect(facts.find(r => r.id === f.copy)?.corrected_by).toBe(f.correction);
      expect(text).toContain('corrected by a newer saved fact');
      const ids = new Set(facts.map(r => r.id));
      for (const row of facts) if (row.corrected_by !== undefined) expect(ids.has(row.corrected_by)).toBe(true);
    }
  }, 30_000);

  test('disabling supersession preserves entity facts, and private corrections do not suppress them', async () => {
    const f = await seed('Privatestone', 5, 'private');
    expect((await call('search', f.query)).facts.map(r => r.id)).toContain(f.copy);
    const capped = await seed('Offstone', 5);
    await engine.setConfig(SAVED_FACTS_SUPERSEDE_KEY, 'false');
    try {
      const { facts } = await call('search', capped.query);
      expect(facts.map(r => r.id)).toContain(capped.copy);
      expect(facts.some(r => r.corrected_by !== undefined)).toBe(false);
    } finally { await engine.unsetConfig(SAVED_FACTS_SUPERSEDE_KEY); }
  }, 30_000);

  test('removing an unavailable corrector also removes entity claims that depend on it', async () => {
    const f = await seed('Chainstone', 5);
    await engine.executeRaw(`UPDATE facts SET fact = 'Correction: Chainstone renewal seats are 46.', entity_slug = 'companies/chainstone' WHERE id = $1`, [f.correction]);
    await engine.executeRaw(`INSERT INTO facts (source_id, fact, kind, visibility, source, valid_from)
      VALUES ('default', 'Correction: Chainstone seats are 52.', 'fact', 'world', 'fixture', '2026-01-04')`);
    for (const op of ['search', 'query'] as const) {
      const { facts } = await call(op, f.query);
      expect(facts).toHaveLength(5);
      expect(facts.map(r => r.id)).not.toContain(f.copy);
      expect(facts.map(r => r.id)).not.toContain(f.correction);
      expect(facts.some(r => r.corrected_by !== undefined)).toBe(false);
    }
    // Read-side suppression never expires or deletes historical claims.
    expect(await engine.executeRaw('SELECT id FROM facts WHERE id = ANY($1::int[])', [[f.old, f.copy, f.correction]])).toHaveLength(3);
  }, 30_000);
});
