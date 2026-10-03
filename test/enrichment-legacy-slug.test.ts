import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { enrichEntity, legacyAsciiEntitySlug, slugifyEntity } from '../src/core/enrichment-service.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  for (const t of ['content_chunks', 'links', 'tags', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as unknown as { db: { exec(q: string): Promise<unknown> } }).db.exec(`DELETE FROM ${t}`);
  }
});

async function personSlugs(): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE slug LIKE 'people/%' AND deleted_at IS NULL ORDER BY slug");
  return rows.map(r => r.slug);
}

describe('entity enrichment keeps pages created under the ASCII-only slug', () => {
  test('the Unicode-aware slug differs from the legacy ASCII slug for accented names', () => {
    expect(slugifyEntity('José García', 'person')).toBe('people/jose-garcia');
    expect(legacyAsciiEntitySlug('José García', 'person')).toBe('people/jos-garc-a');
  });

  test('an existing legacy-slug page is updated instead of minting a duplicate', async () => {
    await engine.putPage('people/jos-garc-a', { type: 'person', title: 'José García', compiled_truth: 'Existing page from an older brain.', frontmatter: {} });
    const result = await enrichEntity(engine, { entityName: 'José García', entityType: 'person', context: 'met at the conference', sourceSlug: 'notes/day1' }, { trusted: true });
    expect(result.action).toBe('updated');
    expect(result.slug).toBe('people/jos-garc-a');
    expect(await personSlugs()).toEqual(['people/jos-garc-a']);
  });

  test('with no legacy page, a new page is created under the Unicode-aware slug', async () => {
    const result = await enrichEntity(engine, { entityName: 'José García', entityType: 'person', context: 'first mention', sourceSlug: 'notes/day1' }, { trusted: true });
    expect(result.slug).toBe('people/jose-garcia');
    expect(await personSlugs()).toEqual(['people/jose-garcia']);
  });

  test('a name whose legacy slug is empty never matches a bare prefix page', async () => {
    expect(legacyAsciiEntitySlug('Иван Петров', 'person')).toBe('people/');
    const result = await enrichEntity(engine, { entityName: 'Иван Петров', entityType: 'person', context: 'c', sourceSlug: 'notes/day1' }, { trusted: true });
    expect(result.slug).toBe(slugifyEntity('Иван Петров', 'person'));
  });

  test('a legacy slug held by a differently named page is not reused', async () => {
    expect(legacyAsciiEntitySlug('José', 'person')).toBe('people/jos');
    await engine.putPage('people/jos', { type: 'person', title: 'Jos', compiled_truth: 'A different person.', frontmatter: {} });
    const result = await enrichEntity(engine, { entityName: 'José', entityType: 'person', context: 'c', sourceSlug: 'notes/day1' }, { trusted: true });
    expect(result.slug).toBe('people/jose');
    expect(await personSlugs()).toEqual(['people/jos', 'people/jose']);
  });
});
