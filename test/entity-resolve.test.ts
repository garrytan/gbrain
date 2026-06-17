import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  resolveEntitySlug,
  resolveEntitySlugWithSource,
  slugify,
  type ResolutionSource,
} from '../src/core/entities/resolve.ts';
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

// ─────────────────────────────────────────────────────────────────────
// v0.40.2.0 — resolveEntitySlugWithSource
// ─────────────────────────────────────────────────────────────────────
//
// Same resolution chain as resolveEntitySlug, but returns the source
// tag (`exact_page` | `fuzzy_match` | `fallback_slugify`) so trajectory
// routing in `gbrain think` (Commit 2) can gate on
// `resolution_source !== 'fallback_slugify'` and avoid querying invented
// slugs in production. The longmemeval harness accepts fallback_slugify
// because its extractor uses the same slugify fallback (they cohere).
//
// These tests pin the source-tag contract per branch.

describe('resolveEntitySlugWithSource — exact_page branch', () => {
  it('returns exact_page when raw is a full slug that exists', async () => {
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'people/alice-example',
    );
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('people/alice-example');
    expect(result!.source).toBe<ResolutionSource>('exact_page');
  });

  it('returns exact_page when raw is a slug-shape match (lowercase, slash)', async () => {
    // Pre-existing companies/stripe is seeded; raw is exact.
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'companies/stripe',
    );
    expect(result!.slug).toBe('companies/stripe');
    expect(result!.source).toBe<ResolutionSource>('exact_page');
  });
});

describe('resolveEntitySlugWithSource — fuzzy_match branch', () => {
  it('returns fuzzy_match for a Title-cased display name', async () => {
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'Alice Example',
    );
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('people/alice-example');
    expect(result!.source).toBe<ResolutionSource>('fuzzy_match');
  });

  it('returns fuzzy_match for prefix-expansion (bare first name "Alice")', async () => {
    // Bare name "Alice" doesn't exact-match any slug, fuzzy fails the
    // 0.4 threshold on short trigrams, so prefix expansion fires and
    // resolves to people/alice-example. We tag this branch as
    // fuzzy_match (not fallback_slugify) so trajectory routing knows
    // it's a real-page resolution.
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'Alice',
    );
    expect(result!.slug).toBe('people/alice-example');
    expect(result!.source).toBe<ResolutionSource>('fuzzy_match');
  });
});

describe('resolveEntitySlugWithSource — fallback_slugify branch', () => {
  it('returns fallback_slugify when no page matches', async () => {
    // "Zelda" isn't seeded; no exact, no fuzzy (no people/zelda-*),
    // prefix expansion finds nothing, falls through to slugify.
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'Zelda',
    );
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('zelda');
    expect(result!.source).toBe<ResolutionSource>('fallback_slugify');
  });

  it('returns fallback_slugify for multi-word non-match phrase', async () => {
    // "coffee maker" — common-noun phrase the trajectory router may
    // pull from question text. No page, no fuzzy hit (multi-word but
    // generic), no prefix expansion (multi-token rejects bare-name
    // heuristic), so slugify fires.
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'coffee maker',
    );
    expect(result!.slug).toBe('coffee-maker');
    expect(result!.source).toBe<ResolutionSource>('fallback_slugify');
  });

  it('returns fallback_slugify for accented input (slugify path strips)', async () => {
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      'José García',
    );
    expect(result!.slug).toBe('jose-garcia');
    expect(result!.source).toBe<ResolutionSource>('fallback_slugify');
  });
});

describe('resolveEntitySlugWithSource — null tail', () => {
  it('returns null for empty input', async () => {
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      '',
    );
    expect(result).toBeNull();
  });

  it('returns null for whitespace-only input', async () => {
    const result = await resolveEntitySlugWithSource(
      engine as unknown as BrainEngine,
      'default',
      '   ',
    );
    expect(result).toBeNull();
  });
});

describe('resolveEntitySlugWithSource — back-compat with resolveEntitySlug', () => {
  it('exact_page branch matches resolveEntitySlug output (same slug, plus source tag)', async () => {
    const a = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'people/alice-example');
    const b = await resolveEntitySlugWithSource(engine as unknown as BrainEngine, 'default', 'people/alice-example');
    expect(b!.slug).toBe(a!);
  });

  it('fallback_slugify branch matches resolveEntitySlug output (same slug, plus source tag)', async () => {
    const a = await resolveEntitySlug(engine as unknown as BrainEngine, 'default', 'Zelda');
    const b = await resolveEntitySlugWithSource(engine as unknown as BrainEngine, 'default', 'Zelda');
    expect(b!.slug).toBe(a!);
    expect(b!.source).toBe<ResolutionSource>('fallback_slugify');
  });
});
