import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { resolveEntitySlug, slugify } from '../src/core/entities/resolve.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * v0.34.5 — entity resolution prefix expansion tests.
 *
 * Validates that bare first names resolve to existing pages via prefix
 * expansion, preventing phantom stub creation.
 */

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();

  // Seed test pages.
  const pages = [
    { slug: 'people/jared-friedman', title: 'Jared Friedman', type: 'person' },
    { slug: 'people/diana-hu', title: 'Diana Hu', type: 'person' },
    { slug: 'people/diana-ross', title: 'Diana Ross', type: 'person' },
    { slug: 'people/sam-altman', title: 'Sam Altman', type: 'person' },
    { slug: 'people/sam-bankman-fried', title: 'Sam Bankman-Fried', type: 'person' },
    { slug: 'people/garry-tan', title: 'Garry Tan', type: 'person' },
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

  // Give jared-friedman more connections (chunks) to win tiebreakers
  const jaredPage = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM pages WHERE slug = 'people/jared-friedman' AND source_id = 'default'`,
    [],
  );
  if (jaredPage.length > 0) {
    for (let i = 0; i < 10; i++) {
      await engine.executeRaw(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
         VALUES ($1, $2, $3)`,
        [jaredPage[0].id, i, `Chunk ${i} about Jared Friedman`],
      );
    }
  }

  // Give sam-altman more connections than sam-bankman-fried
  const samPage = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM pages WHERE slug = 'people/sam-altman' AND source_id = 'default'`,
    [],
  );
  if (samPage.length > 0) {
    for (let i = 0; i < 20; i++) {
      await engine.executeRaw(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
         VALUES ($1, $2, $3)`,
        [samPage[0].id, i, `Chunk ${i} about Sam Altman`],
      );
    }
  }

  // Give diana-hu more connections than diana-ross
  const dianaPage = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM pages WHERE slug = 'people/diana-hu' AND source_id = 'default'`,
    [],
  );
  if (dianaPage.length > 0) {
    for (let i = 0; i < 15; i++) {
      await engine.executeRaw(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
         VALUES ($1, $2, $3)`,
        [dianaPage[0].id, i, `Chunk ${i} about Diana Hu`],
      );
    }
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('resolveEntitySlug — prefix expansion (v0.34.5)', () => {
  it('resolves "Jared" to people/jared-friedman', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Jared');
    expect(result).toBe('people/jared-friedman');
  });

  it('resolves "jared" (lowercase) to people/jared-friedman', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'jared');
    expect(result).toBe('people/jared-friedman');
  });

  it('resolves "Diana" to people/diana-hu (more connections)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Diana');
    expect(result).toBe('people/diana-hu');
  });

  it('resolves "Sam" to people/sam-altman (more connections)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Sam');
    expect(result).toBe('people/sam-altman');
  });

  it('resolves "Garry" to people/garry-tan (single match)', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Garry');
    expect(result).toBe('people/garry-tan');
  });

  it('falls through to slugify for unknown names', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Zyxwvut');
    expect(result).toBe('zyxwvut');
  });

  it('exact match still works for fully-qualified slugs', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'people/jared-friedman');
    expect(result).toBe('people/jared-friedman');
  });

  it('multi-word input does NOT trigger prefix expansion', async () => {
    // "Jared Friedman" should go through fuzzy match, not prefix expansion
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Jared Friedman');
    // Should resolve via fuzzy match to the same page
    expect(result).toContain('jared-friedman');
  });

  it('hyphenated input does NOT trigger prefix expansion', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'jared-friedman');
    expect(result).toBe('people/jared-friedman');
  });

  it('returns null for empty input', async () => {
    const result = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', '');
    expect(result).toBeNull();
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Jared Friedman')).toBe('jared-friedman');
  });

  it('handles single word', () => {
    expect(slugify('Jared')).toBe('jared');
  });

  it('strips accents', () => {
    expect(slugify('José García')).toBe('jose-garcia');
  });
});
