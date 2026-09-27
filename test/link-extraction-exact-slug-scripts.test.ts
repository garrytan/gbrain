/**
 * #11: makeResolver's exact-slug step must accept a slug of any script.
 *
 * When the step rejects a real slug, the value falls through to pg_trgm fuzzy
 * matching over titles, which can pick a sibling page — on real data (#9) a
 * dated page with transposed digits. Runs on PGLite so the fuzzy step is the
 * real query, not a fake.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractFrontmatterLinks, makeResolver } from '../src/core/link-extraction.ts';

let engine: PGLiteEngine;

const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: 'Text.', timeline: '' });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Target and its sibling differ only by two transposed date digits.
  await engine.putPage('источники/2024-01-12-планёрка', note('2024-01-12 планёрка'));
  await engine.putPage('источники/2024-01-21-планёрка', note('источники 2024-01-21 планёрка'));
  // A title unlike the slug: only the exact-slug step can reach this page.
  await engine.putPage('люди/а.с.-пример', note('Контакт'));
  await engine.putPage('заметки/итоги', note('Итоги'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('makeResolver exact-slug step — slugs of every script (#11)', () => {
  test('a frontmatter source: slug links to that exact page, not a fuzzy sibling', async () => {
    const resolver = makeResolver(engine, { mode: 'batch' });
    const result = await extractFrontmatterLinks(
      'заметки/итоги', 'note',{ source: 'источники/2024-01-12-планёрка' }, resolver,
    );
    expect(result.candidates.map(c => c.targetSlug)).toEqual(['источники/2024-01-12-планёрка']);
  });

  test('a dotted Cyrillic slug resolves exactly', async () => {
    const resolver = makeResolver(engine, { mode: 'batch' });
    expect(await resolver.resolve('люди/а.с.-пример')).toBe('люди/а.с.-пример');
  });
});
