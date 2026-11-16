/**
 * #8618: `match: "keyword"` for a page's handle rewrites the query to every
 * name the entity has (`"Acme-Example" OR "acme corp"`). The handle names
 * the page through its slug only, so the rewrite must keep the slug-handle
 * arm beside the alias phrase: the named page is listed and counted. PGLite,
 * synthetic pages.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { callSearch, seedPage } from '../helpers/keyword-paging-fixture.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedPage(engine, 'companies/acme-example', 'A company that builds quokka widgets.', { type: 'company', title: 'Acme-Example', frontmatter: { aliases: ['acme corp'] } });
  await seedPage(engine, 'notes/renewal-call', 'The acme corp renewal call went well.');
  await seedPage(engine, 'notes/unrelated', 'Nothing about that company here.');
}, 60_000);

afterAll(async () => { await engine?.disconnect(); });

describe('#8618 slug handles across OR alternatives', () => {
  test('a keyword search for a handle lists and counts the page it names beside its alias matches', async () => {
    const { rows, retrieval } = await callSearch(engine, { query: 'Acme-Example', match: 'keyword' });
    expect(retrieval.match_names).toEqual(['Acme-Example', 'acme corp']);
    expect(rows.map(r => r.slug).sort()).toEqual(['companies/acme-example', 'notes/renewal-call']);
    expect(retrieval.total).toBe(2);
  });

  test('a typed handle OR name phrase keeps the named page', async () => {
    const { rows, retrieval } = await callSearch(engine, { query: '"acme-example" OR "renewal call"', match: 'keyword' });
    expect(rows.map(r => r.slug).sort()).toEqual(['companies/acme-example', 'notes/renewal-call']);
    expect(retrieval.total).toBe(2);
  });
});
