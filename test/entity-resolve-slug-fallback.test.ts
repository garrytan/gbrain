// #3447 — resolveEntitySlug's slugify fallback must not corrupt slug-shaped
// input. slugify()'s `[^a-z0-9]+ → '-'` rule rewrites the path separator
// (`people/alice-example` → `people-alice-example`), minting an entity_slug
// no page can ever have. The corruption is self-perpetuating: the flattened
// slug never matches a page, so every re-extraction re-mints it.
//
// Behavior pinned here: a slug-shaped input (contains '/') that fails every
// resolution arm falls back with its path separator INTACT — creating the
// page it names later makes the fact resolvable. Display-name fallback
// (no '/') keeps the existing slugify behavior.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  resolveEntitySlug,
  resolveEntitySlugWithSource,
} from '../src/core/entities/resolve.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  // Deliberately NO page at people/zeta-nonexistent — the fallback arm is
  // exactly the "well-formed slug, page not created yet" case from #3447.
});

afterAll(async () => {
  await engine.disconnect();
});

describe('resolveEntitySlug fallback preserves slug-shaped input (#3447)', () => {
  it('returns a well-formed but unresolvable slug untouched', async () => {
    const out = await resolveEntitySlug(engine, 'default', 'people/zeta-nonexistent');
    expect(out).toBe('people/zeta-nonexistent');
  });

  it('normalizes a messy path-shaped input per segment, keeping the separator', async () => {
    const out = await resolveEntitySlug(engine, 'default', 'People/Zeta Nonexistent');
    expect(out).toBe('people/zeta-nonexistent');
  });

  it('still slugifies display names (no separator) as before', async () => {
    const out = await resolveEntitySlug(engine, 'default', 'Zeta Nonexistent Q. Persson');
    expect(out).toBe('zeta-nonexistent-q-persson');
  });

  it('resolveEntitySlugWithSource fallback_slugify agrees with resolveEntitySlug', async () => {
    const out = await resolveEntitySlugWithSource(engine, 'default', 'companies/zeta-widgets-nonexistent');
    expect(out).toEqual({ slug: 'companies/zeta-widgets-nonexistent', source: 'fallback_slugify' });
  });
});
