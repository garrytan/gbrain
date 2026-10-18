/**
 * Retrieval telemetry lives in `page_retrievals` (migration v224), not on
 * `pages`. These cases pin the move: the side-table upsert bumps exactly the
 * pages the legacy `UPDATE pages SET last_retrieved_at` bumped and leaves the
 * same effective timestamps under the 5-minute throttle; it never advances
 * page_generation_clock_seq; hard deletes clean up; and every reader sees
 * GREATEST(legacy column, side table).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  BUMP_LAST_RETRIEVED_SQL,
  bumpLastRetrievedAt,
  awaitPendingLastRetrievedWrites,
  _resetTrackRetrievalCacheForTests,
} from '../src/core/last-retrieved.ts';
import { volunteerUsageStats } from '../src/core/context/volunteer.ts';
import { insertVolunteerEvents } from '../src/core/context/volunteer-events.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';

const LEGACY_BUMP_SQL = `UPDATE pages SET last_retrieved_at = NOW()
  WHERE id = ANY($1::int[]) AND (last_retrieved_at IS NULL OR last_retrieved_at < NOW() - INTERVAL '5 minutes')`;

let engine: PGLiteEngine;

async function seed(slug: string, title = slug): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, 'default', 'person', $2, 'body', '') RETURNING id`, [slug, title]);
  return row!.id;
}
const clock = async () => Number((await engine.executeRaw<{ v: string }>('SELECT last_value::text AS v FROM page_generation_clock_seq'))[0]!.v);
const ageMinutes = async (sql: string, params: unknown[]) =>
  (await engine.executeRaw<{ id: number; age: number | null }>(sql, params)).map(r => ({ id: Number(r.id), age: r.age === null ? null : Math.round(Number(r.age)) }));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM context_volunteer_events').catch(() => {});
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw('DELETE FROM page_retrievals');
  _resetTrackRetrievalCacheForTests();
});

describe('page_retrievals bump', () => {
  test('bumps the same pages as the legacy UPDATE and leaves the same effective timestamps', async () => {
    const never = await seed('people/never');
    const stale = await seed('people/stale');
    const fresh = await seed('people/fresh');
    const softDeleted = await seed('people/soft-deleted');
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE id = $1`, [softDeleted]);
    const ids = [never, stale, fresh, softDeleted, 999_999];
    const ages: Array<[number, string | null]> = [[stale, '10 minutes'], [fresh, '1 minute']];

    for (const [id, age] of ages) await engine.executeRaw(`UPDATE pages SET last_retrieved_at = now() - $2::interval WHERE id = $1`, [id, age]);
    const legacyBumped = (await engine.executeRaw<{ id: number }>(`${LEGACY_BUMP_SQL} RETURNING id`, [ids])).map(r => Number(r.id)).sort();
    const legacy = await ageMinutes(`SELECT id, EXTRACT(EPOCH FROM now() - last_retrieved_at) / 60 AS age FROM pages ORDER BY id`, []);

    await engine.executeRaw('UPDATE pages SET last_retrieved_at = NULL');
    for (const [id, age] of ages) await engine.executeRaw(`INSERT INTO page_retrievals VALUES ($1, now() - $2::interval)`, [id, age]);
    const sideBumped = (await engine.executeRaw<{ page_id: number }>(`${BUMP_LAST_RETRIEVED_SQL} RETURNING page_id`, [ids])).map(r => Number(r.page_id)).sort();
    const side = await ageMinutes(`SELECT p.id, EXTRACT(EPOCH FROM now() - GREATEST(p.last_retrieved_at, r.last_retrieved_at)) / 60 AS age
      FROM pages p LEFT JOIN page_retrievals r ON r.page_id = p.id ORDER BY p.id`, []);

    expect(sideBumped).toEqual(legacyBumped);
    expect(sideBumped).toEqual([never, stale, softDeleted].sort());
    expect(side).toEqual(legacy);
    expect(side.find(r => r.id === fresh)!.age).toBe(1);
    expect(await engine.executeRaw('SELECT 1 FROM page_retrievals WHERE page_id = 999999')).toEqual([]);
  });

  test('a repeat bump inside the window writes nothing, one past it moves the timestamp', async () => {
    const id = await seed('people/repeat');
    expect((await engine.executeRaw(`${BUMP_LAST_RETRIEVED_SQL} RETURNING page_id`, [[id]])).length).toBe(1);
    expect((await engine.executeRaw(`${BUMP_LAST_RETRIEVED_SQL} RETURNING page_id`, [[id, id]])).length).toBe(0);
    await engine.executeRaw(`UPDATE page_retrievals SET last_retrieved_at = now() - interval '6 minutes'`);
    expect((await engine.executeRaw(`${BUMP_LAST_RETRIEVED_SQL} RETURNING page_id`, [[id]])).length).toBe(1);
  });

  test('never advances the page generation clock; the legacy UPDATE did even when it matched no row', async () => {
    const id = await seed('people/clock');
    const before = await clock();
    bumpLastRetrievedAt(engine, [id]);
    bumpLastRetrievedAt(engine, [id]);
    await awaitPendingLastRetrievedWrites();
    expect(await clock()).toBe(before);
    expect((await engine.executeRaw('SELECT 1 FROM page_retrievals WHERE page_id = $1', [id])).length).toBe(1);
    await engine.executeRaw(LEGACY_BUMP_SQL, [[-1]]);
    expect(await clock()).toBeGreaterThan(before);
  });

  test('a hard-deleted page loses its row; a soft delete keeps it', async () => {
    const keep = await seed('people/keep');
    const gone = await seed('people/gone');
    await engine.executeRaw(BUMP_LAST_RETRIEVED_SQL, [[keep, gone]]);
    await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [keep]);
    await engine.executeRaw('DELETE FROM pages WHERE id = $1', [gone]);
    const rows = (await engine.executeRaw<{ page_id: number }>('SELECT page_id FROM page_retrievals ORDER BY page_id')).map(r => Number(r.page_id));
    expect(rows).toEqual([keep]);
  });
});

describe('page_retrievals readers take GREATEST(legacy column, side table)', () => {
  test('volunteer usage stats count a retrieval recorded in either place', async () => {
    const viaSide = await seed('people/alice-example', 'Alice Example');
    await seed('people/bob-example', 'Bob Example');
    const unused = await seed('people/carol-example', 'Carol Example');
    await insertVolunteerEvents(engine, ['alice-example', 'bob-example', 'carol-example'].map(name => ({
      source_id: 'default', slug: `people/${name}`, confidence: 0.9, match_arm: 'exact', rationale: '', channel: 'op',
    })) as never);
    await engine.executeRaw(`INSERT INTO page_retrievals VALUES ($1, now() + interval '1 minute')`, [viaSide]);
    await engine.executeRaw(`UPDATE pages SET last_retrieved_at = now() + interval '1 minute' WHERE slug = 'people/bob-example'`);
    await engine.executeRaw(`INSERT INTO page_retrievals VALUES ($1, now() - interval '1 day')`, [unused]);
    const stats = await volunteerUsageStats(engine, ['default']);
    expect(stats.total_volunteered).toBe(3);
    expect(stats.total_used).toBe(2);
  });

  test('domain-bank samplers and the entity card return the newer of the two timestamps', async () => {
    const side = await seed('wiki/a/side', 'Side Example');
    const legacy = await seed('wiki/b/legacy', 'Legacy Example');
    await seed('wiki/c/never', 'Never Example');
    await engine.executeRaw(`UPDATE pages SET last_retrieved_at = now() - interval '200 days' WHERE id = ANY($1::int[])`, [[side, legacy]]);
    await engine.executeRaw(`INSERT INTO page_retrievals VALUES ($1, now() - interval '1 day'), ($2, now() - interval '300 days')`, [side, legacy]);
    const days = (v: Date | string | null) => v === null ? null : Math.round((Date.now() - new Date(v).getTime()) / 86_400_000);
    const sampled = await engine.listPrefixSampledPages({ prefixes: ['wiki/a', 'wiki/b', 'wiki/c'], staleBias: true });
    expect(sampled.map(r => [r.slug, days(r.last_retrieved_at)])).toEqual([['wiki/a/side', 1], ['wiki/b/legacy', 200], ['wiki/c/never', null]]);
    const corpus = await engine.listCorpusSample({ n: 10, seed: 0.5 });
    expect(Object.fromEntries(corpus.map(r => [r.slug, days(r.last_retrieved_at)]))).toEqual({ 'wiki/a/side': 1, 'wiki/b/legacy': 200, 'wiki/c/never': null });
    const card = await buildEntityCard(engine, 'default', 'Side Example', { remote: false });
    expect(card.found).toBe(true);
    expect(days((card as { card: { last_touched: { last_retrieved_at: string | null } } }).card.last_touched.last_retrieved_at)).toBe(1);
  });
});
