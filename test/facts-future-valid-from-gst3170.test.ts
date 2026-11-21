/**
 * GST-3170 item 6(a): a fact dated in the far future ranks, in the newest-first fact reads, as of when it was written, not
 * at its date, so a far-future `valid_from` cannot keep facts at the head of a limited window and push the honest ones out.
 * A fact whose date has passed ranks at its date as before. Seams: listFactsByEntity (fact lists, hot memory) and
 * entitySavedFacts (the entity card); PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { entitySavedFacts, ENTITY_FACTS_CAP } from '../src/core/search/entity-facts.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

const SLUG = 'people/alice-example';
const day = (d: string) => new Date(d + 'T00:00:00Z');
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function add(engine: BrainEngine, sourceId: string, fact: string, validFrom: string, writtenDaysAgo = 0): Promise<number> {
  const { id } = await engine.insertFact({ fact, entity_slug: SLUG, source: 'test', visibility: 'world', valid_from: day(validFrom) }, // gbrain-allow-direct-insert: seeds dated facts for the read-order probe
    { source_id: sourceId });
  if (writtenDaysAgo) await engine.executeRaw("UPDATE facts SET created_at = now() - make_interval(days => $2) WHERE id = $1", [id, writtenDaysAgo]);
  return id;
}

for (const backend of testBackends()) describe('[' + backend + '] far-future valid_from does not hold the head of newest-first fact reads (GST-3170)', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('fact lists and the entity card keep the honest facts; a past-dated scheduled fact ranks at its date', async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      const sourceId = await newSource(engine);
      await putPage(engine, sourceId, SLUG, page('person', 'Alice Example', 'Alice Example is a designer.'));
      const honest: number[] = [];
      for (let i = 1; i <= ENTITY_FACTS_CAP; i++) honest.push(await add(engine, sourceId, 'Alice Example honest fact ' + i, daysAgo(i)));
      await add(engine, sourceId, 'Alice Example far-future fact one', '9999-01-01', 30);
      await add(engine, sourceId, 'Alice Example far-future fact two', '9999-06-01', 30);
      const listed = await engine.listFactsByEntity(sourceId, SLUG, { limit: ENTITY_FACTS_CAP });
      expect(listed.map(f => Number(f.id)).sort((a, b) => a - b)).toEqual(honest);
      const card = await entitySavedFacts(engine, { pages: [{ slug: SLUG, source_id: sourceId }], tokens: [0, 1] }, { remote: false, excludePrivate: false });
      expect(card.map(f => f.fact).filter(f => f.includes('far-future'))).toEqual([]);
      const passed = await add(engine, sourceId, 'Alice Example scheduled fact that has happened', daysAgo(0), 60);
      expect(Number((await engine.listFactsByEntity(sourceId, SLUG, { limit: 1 }))[0]!.id)).toBe(passed);
    } finally { await close(); }
  }, 300_000);
});
