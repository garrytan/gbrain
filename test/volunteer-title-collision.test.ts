/**
 * #6725: a meeting or transcript page that shares an entity's exact title must
 * not be volunteered in place of the entity page.
 *
 * Protects: among exact-title hits for one name WITHIN one source, the pointer
 * goes to the explicit exact slug, then a linkable entity type, then anything
 * else (the same ladder the `entity` card uses), whatever order the rows were
 * written in; the choice happens after the privacy gate, so a private entity
 * page falls back to the readable page; same-title pages in different sources
 * are different entities and both stay. Regression: the title arm pushed every
 * matching row in SQL row order, so a same-title meeting took the pointer slot.
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';
import { extractCandidates } from '../src/core/context/entity-salience.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;
const config = { engine: 'pglite' } as never;

async function seed(slug: string, type: string, title: string, body: string, source = 'default', frontmatter: Record<string, unknown> = {}) {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter)
     VALUES ($1, $2, $3, $4, $5, '', $6::text::jsonb)`,
    [slug, source, type, title, body, JSON.stringify(frontmatter)],
  );
}

const pointers = async (text: string, opts: Parameters<typeof resolveEntitiesToPointers>[3] = {}) =>
  ((await resolveEntitiesToPointers(engine, 'default', extractCandidates(text), opts))?.pointers ?? []).map(p => [p.source_id, p.slug]);

async function call(op: string, args: Record<string, unknown>, ctx: Record<string, unknown>) {
  const r = await dispatchToolCall(engine, op, args, { config, ...ctx } as never);
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('wiki', 'wiki', '{}') ON CONFLICT (id) DO NOTHING`);
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM page_aliases').catch(() => {});
  await engine.executeRaw('DELETE FROM pages');
});

describe('#6725 same-title collisions in the volunteer title arm', () => {
  for (const entityFirst of [false, true]) {
    test(`the entity page wins over a same-title meeting (entity written first: ${entityFirst})`, async () => {
      const rows: Array<[string, string]> = [['meetings/2026-10-01-alice-sync', 'conversation'], ['people/alice-example', 'person']];
      if (entityFirst) rows.reverse();
      for (const [slug, type] of rows) await seed(slug, type, 'Alice Example', `${type} synopsis.`);

      expect(await pointers('about Alice Example', { maxPointers: 1 })).toEqual([['default', 'people/alice-example']]);
      expect(await pointers('about Alice Example', { maxPointers: 10 })).toEqual([['default', 'people/alice-example']]);

      const volunteered = await call('volunteer_context', { window: 'user: what do we know about Alice Example?' }, { remote: true, sourceId: 'default' });
      expect(volunteered.pages.map((p: { slug: string }) => p.slug)).toEqual(['people/alice-example']);
      const card = await call('entity', { name: 'Alice Example' }, { remote: true, sourceId: 'default' });
      expect(card.card.entity.slug).toBe('people/alice-example');
    });
  }

  test('a private entity page falls back to the readable same-title page', async () => {
    await seed('meetings/2026-10-01-alice-sync', 'conversation', 'Alice Example', 'Public transcript.');
    await seed('people/alice-example', 'person', 'Alice Example', 'Private entity.', 'default', { visibility: 'private' });
    expect(await pointers('about Alice Example')).toEqual([['default', 'meetings/2026-10-01-alice-sync']]);
  });

  test('an explicit exact slug beats an inferred entity type', async () => {
    await seed('alice-example', 'note', 'Alice Example', 'Explicit page.');
    await seed('people/alice-example', 'person', 'Alice Example', 'Entity.');
    expect(await pointers('about Alice Example')).toEqual([['default', 'alice-example']]);
  });

  test('equal preferences pick the same page whatever the write order', async () => {
    await seed('people/z-alice', 'person', 'Alice Example', 'Written first.');
    await seed('people/a-alice', 'person', 'Alice Example', 'Written second.');
    expect(await pointers('about Alice Example')).toEqual([['default', 'people/a-alice']]);
  });

  test('same-title pages in different sources are different entities and both stay', async () => {
    await seed('meetings/2026-10-01-alice-sync', 'conversation', 'Alice Example', 'Default transcript.');
    await seed('people/alice-example', 'person', 'Alice Example', 'Default person.');
    await seed('people/alice-example', 'person', 'Alice Example', 'Wiki person.', 'wiki');
    expect((await pointers('about Alice Example', { sourceIds: ['default', 'wiki'], maxPointers: 10 })).sort())
      .toEqual([['default', 'people/alice-example'], ['wiki', 'people/alice-example']]);
  });

  test('a lone container in one source is not displaced by an entity in another source', async () => {
    await seed('meetings/2026-10-01-alice-sync', 'conversation', 'Alice Example', 'Default transcript.');
    await seed('people/alice-example', 'person', 'Alice Example', 'Wiki person.', 'wiki');
    expect((await pointers('about Alice Example', { sourceIds: ['default', 'wiki'], maxPointers: 10 })).sort())
      .toEqual([['default', 'meetings/2026-10-01-alice-sync'], ['wiki', 'people/alice-example']]);
  });
});
