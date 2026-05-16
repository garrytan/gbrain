import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { resolveEntitySlug, slugify } from '../src/core/entities/resolve.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * Entity resolution prefix expansion tests.
 *
 * Validates that bare first names resolve to existing pages via prefix
 * expansion, preventing phantom stub creation.
 *
 * Fixture names use the `alice-example` / `bob-example` / `charlie-example`
 * / `dave-example` placeholder pattern per CLAUDE.md privacy rule.
 * `stripe` and `stripe-atlas` are intentional — household-brand exception
 * exercises the two-word company prefix case.
 */

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();

  // Seed test pages. Naming pattern:
  //   - alice-example: single-match case (only people/alice-*)
  //   - bob-example vs bob-rosenstein: multi-match tiebreaker (bob-example wins on connections)
  //   - charlie-example vs charlie-bankcroft: multi-match tiebreaker (charlie-example wins on connections)
  //   - dave-example: single-match case
  const pages = [
    { slug: 'people/alice-example', title: 'Alice Example', type: 'person' },
    { slug: 'people/bob-example', title: 'Bob Example', type: 'person' },
    { slug: 'people/bob-rosenstein', title: 'Bob Rosenstein', type: 'person' },
    { slug: 'people/charlie-example', title: 'Charlie Example', type: 'person' },
    { slug: 'people/charlie-bankcroft', title: 'Charlie Bankcroft', type: 'person' },
    { slug: 'people/dave-example', title: 'Dave Example', type: 'person' },
    { slug: 'companies/stripe', title: 'Stripe', type: 'company' },
    { slug: 'companies/stripe-atlas', title: 'Stripe Atlas', type: 'company' },
  ];

  for (const p of pages) {
    await engine.putPage(p.slug, {
      type: p.type as any,
      title: p.title,
      compiled_truth: `# ${p.title}`,
      frontmatter: { type: p.type, title: p.title, slug: p.slug },
    }, { sourceId: 'default' });
  }

  // Give alice-example 10 chunks (single match, ensures it's the resolved target)
  const alicePage = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM pages WHERE slug = 'people/alice-example' AND source_id = 'default'`,
    [],
  );
  if (alicePage.length > 0) {
    for (let i = 0; i < 10; i++) {
      await engine.executeRaw(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
         VALUES ($1, $2, $3)`,
        [alicePage[0].id, i, `Chunk ${i} about Alice Example`],
      );
    }
  }

  // Give charlie-example more connections than charlie-bankcroft (20 vs 0)
  const charliePage = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM pages WHERE slug = 'people/charlie-example' AND source_id = 'default'`,
    [],
  );
  if (charliePage.length > 0) {
    for (let i = 0; i < 20; i++) {
      await engine.executeRaw(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
         VALUES ($1, $2, $3)`,
        [charliePage[0].id, i, `Chunk ${i} about Charlie Example`],
      );
    }
  }

  // Give bob-example more connections than bob-rosenstein (15 vs 0)
  const bobPage = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM pages WHERE slug = 'people/bob-example' AND source_id = 'default'`,
    [],
  );
  if (bobPage.length > 0) {
    for (let i = 0; i < 15; i++) {
      await engine.executeRaw(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
         VALUES ($1, $2, $3)`,
        [bobPage[0].id, i, `Chunk ${i} about Bob Example`],
      );
    }
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('resolveEntitySlug — prefix expansion', () => {
  it('resolves "Alice" to people/alice-example', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Alice');
    expect(result).toBe('people/alice-example');
  });

  it('resolves "alice" (lowercase) to people/alice-example', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'alice');
    expect(result).toBe('people/alice-example');
  });

  it('resolves "Bob" to people/bob-example (more connections)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Bob');
    expect(result).toBe('people/bob-example');
  });

  it('resolves "Charlie" to people/charlie-example (more connections)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Charlie');
    expect(result).toBe('people/charlie-example');
  });

  it('resolves "Dave" to people/dave-example (single match)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Dave');
    expect(result).toBe('people/dave-example');
  });

  it('falls through to slugify for unknown names', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Zyxwvut');
    expect(result).toBe('zyxwvut');
  });

  it('exact match still works for fully-qualified slugs', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'people/alice-example');
    expect(result).toBe('people/alice-example');
  });

  it('multi-word input does NOT trigger prefix expansion', async () => {
    // "Alice Example" should go through fuzzy match, not prefix expansion
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Alice Example');
    // Should resolve via fuzzy match to the same page
    expect(result).toContain('alice-example');
  });

  it('hyphenated input does NOT trigger prefix expansion', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'alice-example');
    expect(result).toBe('people/alice-example');
  });

  it('returns null for empty input', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', '');
    expect(result).toBeNull();
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Alice Example')).toBe('alice-example');
  });

  it('handles single word', () => {
    expect(slugify('Alice')).toBe('alice');
  });

  it('strips accents', () => {
    expect(slugify('José García')).toBe('jose-garcia');
  });
});
