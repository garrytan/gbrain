/**
 * Two rules end a fact. Supersession (facts/supersede-interval.ts, GBRA-574 A3) ends a replaced fact when gbrain learns of
 * the replacement; consolidate ends a cluster member at the next member with a different claim. Neither path re-ends a
 * fact the other already ended: consolidate reads only unexpired, open facts, so a superseded fact keeps its end; and a
 * replacement that starts after a consolidated fact's end leaves that end as it is.
 *
 * PGLite always; Postgres too when DATABASE_URL is set (test/e2e wrapper).
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

const SLUG = 'people/alice-example';
const OSLO = 'Alice Example lives in Oslo.';
const BERGEN = 'Alice Example lives in Bergen.';
const PARIS = 'Alice Example lives in Paris.';
const at = (day: string) => new Date(`${day}T00:00:00Z`);

async function add(engine: BrainEngine, sourceId: string, fact: string, day: string, supersedeId?: number): Promise<number> {
  const { id } = await engine.insertFact({ fact, entity_slug: SLUG, source: 'test', visibility: 'world', valid_from: at(day) }, // gbrain-allow-direct-insert: probes the engine supersede rule against consolidate
    { source_id: sourceId, ...(supersedeId ? { supersedeId } : {}) });
  const [{ t }] = await engine.executeRaw<{ t: string }>("SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'facts'::regclass AND attname = 'embedding'");
  const vec = '[' + Array.from({ length: Number(t.match(/\((\d+)\)/)![1]) }, (_, k) => (k % 7 === 0 ? 0.3 : 0.01)).join(',') + ']';
  await engine.executeRaw("UPDATE facts SET embedding=$2::vector, embedded_at=now(), embedding_model='openai:text-embedding-3-large', embedded_text_hash=md5(fact) WHERE id=$1", [id, vec]);
  return id;
}
const ends = async (engine: BrainEngine, sourceId: string) => Object.fromEntries((await engine.executeRaw<{ id: number; vu: string | null; expired: boolean }>(
  `SELECT id, to_char(valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS vu, expired_at IS NOT NULL AS expired FROM facts WHERE source_id = $1 ORDER BY id`, [sourceId]))
  .map(row => [Number(row.id), { vu: row.vu, expired: row.expired }]));

for (const backend of testBackends()) describe(`[${backend}] supersession and consolidate never re-end each other's facts`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const brain = async (run: (engine: BrainEngine, sourceId: string) => Promise<void>) => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      const sourceId = await newSource(engine);
      await putPage(engine, sourceId, SLUG, page('person', 'Alice Example', 'Alice Example is a designer.'));
      await run(engine, sourceId);
    } finally { await close(); }
  };

  test('a superseded fact keeps its end through consolidate', () => brain(async (engine, sourceId) => {
    const oslo = await add(engine, sourceId, OSLO, '2025-03-01');
    const bergen = await add(engine, sourceId, BERGEN, '2025-09-01', oslo);
    const again = await add(engine, sourceId, BERGEN, '2025-12-01');
    const before = await ends(engine, sourceId);
    expect(before[oslo]).toEqual({ vu: '2025-09-01', expired: true });
    await runPhaseConsolidate(engine, { sourceId });
    expect(await ends(engine, sourceId)).toEqual({ ...before, [bergen]: { vu: null, expired: false }, [again]: { vu: null, expired: false } });
  }), 300_000);

  test('a fact consolidate ended keeps its end when a later replacement supersedes it, and a second consolidate changes nothing', () => brain(async (engine, sourceId) => {
    const oslo = await add(engine, sourceId, OSLO, '2025-03-01');
    const restated = await add(engine, sourceId, OSLO, '2025-06-01');
    const bergen = await add(engine, sourceId, BERGEN, '2025-09-01');
    await runPhaseConsolidate(engine, { sourceId });
    expect(await ends(engine, sourceId)).toEqual({ [oslo]: { vu: '2025-09-01', expired: false }, [restated]: { vu: '2025-09-01', expired: false }, [bergen]: { vu: null, expired: false } });
    const paris = await add(engine, sourceId, PARIS, '2026-01-01', oslo);
    const after = await ends(engine, sourceId);
    expect(after[oslo]).toEqual({ vu: '2025-09-01', expired: true });
    expect(after[restated]).toEqual({ vu: '2025-09-01', expired: false });
    await runPhaseConsolidate(engine, { sourceId });
    expect(await ends(engine, sourceId)).toEqual({ ...after, [paris]: { vu: null, expired: false } });
  }), 300_000);
});
