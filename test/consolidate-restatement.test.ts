/**
 * Consolidate and restated facts. When the same claim is said again on a later date, the upkeep consolidate step used to
 * end each earlier copy on the next copy's valid_from, so the value's active record started at its last restatement and
 * the date it was first stated was no longer on any active row. A restatement is the value still holding: a member ends
 * only at the valid_from of the next member that says something else.
 *
 * The cluster is seeded as a real embedder leaves identical text: one stored embedding for every copy, no tuned cosine.
 * Unmanaged (the closing chain in consolidate.ts) and managed (the closes in prepared-maintenance.ts), PGLite always and
 * Postgres too when DATABASE_URL is set (test/e2e wrapper). New consolidations only; nothing rewrites consolidated rows.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

const SLUG = 'people/alice-example';
const OSLO = 'Alice Example lives in Oslo.';
const BERGEN = 'Alice Example lives in Bergen.';

async function seedFacts(engine: BrainEngine, sourceId: string, statements: Array<[string, string]>): Promise<void> {
  const [{ t }] = await engine.executeRaw<{ t: string }>("SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'facts'::regclass AND attname = 'embedding'");
  const dim = Number(t.match(/\((\d+)\)/)![1]);
  const vec = '[' + Array.from({ length: dim }, (_, k) => (k % 7 === 0 ? 0.3 : 0.01)).join(',') + ']';
  for (const [text, day] of statements) {
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from, embedding, embedded_at, embedding_model, embedded_text_hash)
      VALUES ($1, $2, $3, 'event', 'cli:extract-conversation-facts:v1', 'world', 1, $4::timestamptz, $5::vector, now(), 'openai:text-embedding-3-large', md5($3))`,
      [sourceId, SLUG, text, `${day}T00:00:00Z`, vec]);
  }
}
const chain = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ fact: string; vf: string; vu: string | null; consolidated: boolean }>(
  `SELECT fact, to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS vf, to_char(valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS vu,
     consolidated_at IS NOT NULL AS consolidated FROM facts WHERE source_id = $1 AND entity_slug = $2 ORDER BY valid_from, id`, [sourceId, SLUG]));

for (const backend of testBackends()) describe(`[${backend}] consolidate keeps restated facts open`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const unmanaged = async (statements: Array<[string, string]>) => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      const sourceId = await newSource(engine);
      await putPage(engine, sourceId, SLUG, page('person', 'Alice Example', 'Alice Example is a designer.'));
      await seedFacts(engine, sourceId, statements);
      await runPhaseConsolidate(engine, { sourceId });
      return await chain(engine, sourceId);
    } finally { await close(); }
  };

  test('a value restated without change keeps no end date, and its first-stated date stays on an active row', async () => {
    expect(await unmanaged([[OSLO, '2025-03-01'], [OSLO, '2025-06-01'], [OSLO, '2025-09-01']])).toEqual([
      { fact: OSLO, vf: '2025-03-01', vu: null, consolidated: true },
      { fact: OSLO, vf: '2025-06-01', vu: null, consolidated: true },
      { fact: OSLO, vf: '2025-09-01', vu: null, consolidated: true },
    ]);
  }, 300_000);

  test('restated copies all end when the value changes, at the date it changed', async () => {
    expect(await unmanaged([[OSLO, '2025-03-01'], [OSLO, '2025-06-01'], [BERGEN, '2025-09-01']])).toEqual([
      { fact: OSLO, vf: '2025-03-01', vu: '2025-09-01', consolidated: true },
      { fact: OSLO, vf: '2025-06-01', vu: '2025-09-01', consolidated: true },
      { fact: BERGEN, vf: '2025-09-01', vu: null, consolidated: true },
    ]);
  }, 300_000);

  test('managed: the publication closes restated database rows the same way', () => managedBrain(async ({ engine, ctx }) => {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, request_id: randomUUID(), content: page('person', 'Alice Example', 'Alice Example is a designer.') } });
    await settleManagedGitEffects(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try { await seedFacts(engine, 'default', [[OSLO, '2025-03-01'], [OSLO, '2025-06-01'], [BERGEN, '2025-09-01'], [BERGEN, '2025-12-01']]); }
    finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
    await runPhaseConsolidate(engine, { sourceId: 'default' });
    expect(await chain(engine, 'default')).toEqual([
      { fact: OSLO, vf: '2025-03-01', vu: '2025-09-01', consolidated: true },
      { fact: OSLO, vf: '2025-06-01', vu: '2025-09-01', consolidated: true },
      { fact: BERGEN, vf: '2025-09-01', vu: null, consolidated: true },
      { fact: BERGEN, vf: '2025-12-01', vu: null, consolidated: true },
    ]);
  }, { databaseUrl }), 300_000);
});
