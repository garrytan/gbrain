/**
 * #6940: get_health's most_connected must not count links whose far endpoint
 * is soft-deleted. The islanded scan already applies endpoint liveness both
 * ways (#4153); most_connected checked only scope, so a hub kept the edges to
 * pages the user deleted and outranked live hubs. Real engines, both backends
 * (Postgres through the e2e twin).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) describe(`most_connected liveness (${backend})`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    if (backend === 'postgres') {
      const { setupDB, getEngine } = await import('./e2e/helpers.ts');
      await setupDB();
      engine = getEngine();
    } else {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    }
  }, 120_000);
  afterAll(async () => {
    if (backend === 'postgres') {
      const { teardownDB } = await import('./e2e/helpers.ts');
      await teardownDB();
    } else await engine?.disconnect();
  });
  beforeEach(async () => {
    for (const t of ['links', 'content_chunks', 'timeline_entries', 'tags', 'page_versions', 'pages']) {
      await engine.executeRaw(`DELETE FROM ${t}`);
    }
  });

  const put = (slug: string, type: string) =>
    engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `about ${slug}`, frontmatter: {} });
  const id = async (slug: string) =>
    (await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]))[0].id;
  const link = async (from: string, to: string) =>
    engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'mentions')`, [await id(from), await id(to)]);
  const ranking = async () => (await engine.getHealth()).most_connected.map(r => [r.slug, r.link_count]);

  test('edges to and from soft-deleted pages do not count in either direction', async () => {
    await put('people/alice-example', 'person');
    await put('companies/acme-example', 'company');
    for (const n of [0, 1, 2]) await put(`notes/n${n}`, 'note');
    // alice: 3 outbound + 1 inbound; two of the notes get deleted below.
    for (const n of [0, 1, 2]) await link('people/alice-example', `notes/n${n}`);
    await link('notes/n0', 'people/alice-example');
    // acme: 2 live edges.
    await link('companies/acme-example', 'notes/n2');
    await link('notes/n2', 'companies/acme-example');
    expect(await ranking()).toEqual([['people/alice-example', 4], ['companies/acme-example', 2]]);

    await engine.softDeletePage('notes/n0');
    await engine.softDeletePage('notes/n1');
    // alice keeps only her edge to n2; acme's two edges are live.
    expect(await ranking()).toEqual([['companies/acme-example', 2], ['people/alice-example', 1]]);
  });
});
