/**
 * Near-name references must not resolve to a different entity.
 *
 * The link resolver (wikilinks, frontmatter entity fields) and the fact entity
 * resolver used trigram similarity alone, so "Carol Exampl" linked to the page of
 * a different person, "Carol Example", and facts about "Bob Jones Example" (no
 * page) landed on a meeting page. A fuzzy candidate that is a person, company,
 * fund or organization now resolves only when its name carries the same tokens
 * as the reference (case, punctuation, order and accents aside). Otherwise the
 * reference stays unresolved: the link resolver returns null and the fact
 * resolver falls back to the reference's own slug.
 *
 * PGLite in-memory, no embeddings ($0).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { makeResolver } from '../src/core/link-extraction.ts';
import { resolveEntitySlugWithSource } from '../src/core/entities/resolve.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const pages: Array<[string, string, string]> = [
    ['people/carol-example', 'person', 'Carol Example'],
    ['people/alice-exampleson', 'person', 'Alice Exampleson'],
    ['people/alice-smith-example', 'person', 'Alice Smith Example'],
    ['companies/widgetco-robotics', 'company', 'Widgetco Robotics'],
    ['meetings/2026-03-01-bob-jones-example-sync', 'meeting', 'Bob Jones Example sync'],
    ['concepts/retrieval-augmented-generation', 'concept', 'Retrieval Augmented Generation'],
  ];
  for (const [slug, type, title] of pages) {
    await importFromContent(engine, slug, `---\ntype: ${type}\ntitle: ${title}\n---\n\n${title} notes.\n`, { noEmbed: true });
  }
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('link resolver', () => {
  for (const mode of ['live', 'batch'] as const) {
    test(`${mode}: a near-name of a different person or company stays unresolved`, async () => {
      const r = makeResolver(engine, { mode, sourceId: 'default' });
      expect(await r.resolve('Carol Exampl', 'people')).toBeNull();
      expect(await r.resolve('Carol Exampl')).toBeNull();
      expect(await r.resolve('Alice Examplston', 'people')).toBeNull();
      expect(await r.resolve('Alicia Exampleson', 'people')).toBeNull();
      expect(await r.resolve('Widgetco Robotic Arms', 'companies')).toBeNull();
      expect(await r.resolve('Widgetco Robotic Arms')).toBeNull();
    });

    test(`${mode}: the same name in another spelling still resolves`, async () => {
      const r = makeResolver(engine, { mode, sourceId: 'default' });
      expect(await r.resolve('Exampleson, Alice', 'people')).toBe('people/alice-exampleson');
      expect(await r.resolve('carol example')).toBe('people/carol-example');
    });

    test(`${mode}: typo tolerance survives for non-entity pages`, async () => {
      const r = makeResolver(engine, { mode, sourceId: 'default' });
      expect(await r.resolve('Retrieval Augmented Generaton')).toBe('concepts/retrieval-augmented-generation');
    });
  }
});

describe('fact entity resolver', () => {
  test('a different person with a near name falls back to the reference slug', async () => {
    expect(await resolveEntitySlugWithSource(engine, 'default', 'Alicia Smith Example'))
      .toEqual({ slug: 'alicia-smith-example', source: 'fallback_slugify' });
  });

  test('a person without a page never lands on a meeting page', async () => {
    expect(await resolveEntitySlugWithSource(engine, 'default', 'Bob Jones Example'))
      .toEqual({ slug: 'bob-jones-example', source: 'fallback_slugify' });
  });

  test('the same person in another spelling still resolves', async () => {
    expect(await resolveEntitySlugWithSource(engine, 'default', 'Example, Alice Smith'))
      .toEqual({ slug: 'people/alice-smith-example', source: 'fuzzy_match' });
    expect(await resolveEntitySlugWithSource(engine, 'default', 'Widgetco Robotics Inc'))
      .toEqual({ slug: 'companies/widgetco-robotics', source: 'fuzzy_match' });
  });
});
