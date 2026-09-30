/**
 * The exact-name floor: a mention that is exactly a live page's own name
 * resolves to that page, even when another page lists the same string in its
 * `aliases:` (a former name). The alias arm stays authoritative for mentions
 * that are nobody's own name. (gbrain-evals N4 entity-resolution, bug 1.)
 *
 * Synthetic data only.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resolveEntitySlug, resolveEntitySlugWithSource } from '../src/core/entities/resolve.ts';
import { operations } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importFromContent(engine, 'people/jordan-lee-example',
    '---\ntitle: Jordan Lee-Example\ntype: person\n---\n\n# Jordan Lee-Example\n', { noEmbed: true });
  await importFromContent(engine, 'people/jordan-smith-example',
    '---\ntitle: Jordan Smith-Example\ntype: person\naliases:\n  - "Jordan Lee-Example"\n  - "Jojo Example"\n---\n\n# Jordan Smith-Example\n\nFormerly Jordan Lee-Example.\n', { noEmbed: true });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('exact own name beats another page\'s alias', () => {
  test('resolveEntitySlugWithSource returns the page whose own name matches', async () => {
    const r = await resolveEntitySlugWithSource(engine, 'default', 'Jordan Lee-Example');
    expect(r?.slug).toBe('people/jordan-lee-example');
  });

  test('resolveEntitySlug agrees', async () => {
    expect(await resolveEntitySlug(engine, 'default', 'Jordan Lee-Example')).toBe('people/jordan-lee-example');
  });

  test('an alias that is nobody\'s own name still resolves through the alias arm', async () => {
    expect(await resolveEntitySlugWithSource(engine, 'default', 'Jojo Example'))
      .toEqual({ slug: 'people/jordan-smith-example', source: 'alias_exact' });
  });

  test('remember stores the fact on the exact-name page', async () => {
    const ctx = { engine, config: {}, logger: console, dryRun: false, remote: false, sourceId: 'default' } as any;
    const remember = operations.find(o => o.name === 'remember')!;
    const saved = await remember.handler(ctx, { fact: 'Jordan Lee-Example joined the platform team', entity: 'Jordan Lee-Example', provenance: 'test' }) as any;
    expect(saved.entity_slug).toBe('people/jordan-lee-example');
  });
});
