/**
 * v0.31 Phase 6 — entity slug canonicalization (D4).
 *
 * Pins:
 *   - Exact slug match against pages.slug → returns it untouched
 *   - Fuzzy match falls through to deterministic slugify
 *   - slugify rules (lowercase, hyphenate, collapse multiples, trim ends)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveEntitySlug, slugify } from '../src/core/entities/resolve.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO pages (slug, type, title) VALUES ('people/alice-example', 'person', 'Alice Example') ON CONFLICT DO NOTHING`);
  await engine.executeRaw(`INSERT INTO pages (slug, type, title) VALUES ('companies/anthropic', 'company', 'Anthropic') ON CONFLICT DO NOTHING`);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('slugify', () => {
  test('lowercase + hyphenate', () => {
    expect(slugify('Alice Example')).toBe('alice-example');
  });
  test('collapses repeated separators', () => {
    expect(slugify('Y    Combinator')).toBe('y-combinator');
  });
  test('trims leading/trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });
  test('strips diacritics via NFKD', () => {
    expect(slugify('Crème Brûlée')).toBe('creme-brulee');
  });
  test('numeric mixed', () => {
    expect(slugify('YC W25')).toBe('yc-w25');
  });
  test('empty input → empty', () => {
    expect(slugify('')).toBe('');
    expect(slugify('   ')).toBe('');
  });
});

describe('resolveEntitySlug', () => {
  test('exact slug match returns the slug', async () => {
    const result = await resolveEntitySlug(engine, 'default', 'people/alice-example');
    expect(result).toBe('people/alice-example');
  });

  test('non-matching but slug-shaped → falls through to slugify', async () => {
    // Doesn't match a row but is slug-shaped: still goes through fuzzy
    // pipeline; without a match, slugify normalizes.
    const result = await resolveEntitySlug(engine, 'default', 'unknown-thing-xyz');
    expect(result).toBe('unknown-thing-xyz');
  });

  test('display name canonicalizes via slugify when no fuzzy match', async () => {
    const result = await resolveEntitySlug(engine, 'default', 'Some Random Person');
    expect(result).toBe('some-random-person');
  });

  test('null on empty', async () => {
    expect(await resolveEntitySlug(engine, 'default', '')).toBeNull();
    expect(await resolveEntitySlug(engine, 'default', '   ')).toBeNull();
  });
});
