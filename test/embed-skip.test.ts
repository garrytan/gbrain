import { describe, test, expect } from 'bun:test';
import {
  isEmbedSkipped,
  filterOutEmbedSkipped,
  buildEmbedSkipMarker,
  EMBED_SKIP_KEY,
  EMBED_SKIP_FILTER_FRAGMENT,
} from '../src/core/embed-skip.ts';

describe('isEmbedSkipped', () => {
  test('false on null', () => {
    expect(isEmbedSkipped(null)).toBe(false);
  });
  test('false on undefined', () => {
    expect(isEmbedSkipped(undefined)).toBe(false);
  });
  test('false on empty object', () => {
    expect(isEmbedSkipped({})).toBe(false);
  });
  test('false when key is undefined', () => {
    expect(isEmbedSkipped({ other_key: true })).toBe(false);
  });
  test('false when key value is null', () => {
    // Explicit null = "not skipped" (key existence != truthy).
    expect(isEmbedSkipped({ embed_skip: null })).toBe(false);
  });
  test('true on full marker object (canonical write shape)', () => {
    expect(isEmbedSkipped({ embed_skip: { reason: 'oversized', bytes: 100, assessed_at: 'iso' } })).toBe(true);
  });
  test('true on bare boolean (future flexibility)', () => {
    expect(isEmbedSkipped({ embed_skip: true })).toBe(true);
  });
  test('true on any non-null/undefined value (key-existence semantics)', () => {
    // Mirrors the SQL fragment's JSONB `?` existence operator —
    // contents are diagnostic, not functional.
    expect(isEmbedSkipped({ embed_skip: 'string-marker' })).toBe(true);
    expect(isEmbedSkipped({ embed_skip: 0 })).toBe(true);
  });
  test('EMBED_SKIP_KEY constant is stable contract', () => {
    expect(EMBED_SKIP_KEY).toBe('embed_skip');
  });
});

describe('filterOutEmbedSkipped', () => {
  test('empty array passes through', () => {
    expect(filterOutEmbedSkipped([])).toEqual([]);
  });
  test('keeps pages without frontmatter', () => {
    const pages = [{ id: 1 }, { id: 2, frontmatter: null }];
    expect(filterOutEmbedSkipped(pages).length).toBe(2);
  });
  test('excludes pages with embed_skip set', () => {
    const pages = [
      { id: 1, frontmatter: {} },
      { id: 2, frontmatter: { embed_skip: { reason: 'oversized', bytes: 100, assessed_at: '' } } },
      { id: 3, frontmatter: { other: true } },
    ];
    const kept = filterOutEmbedSkipped(pages);
    expect(kept.length).toBe(2);
    expect(kept.map((p) => p.id)).toEqual([1, 3]);
  });
  test('preserves order of kept pages', () => {
    const pages = [
      { id: 1 },
      { id: 2, frontmatter: { embed_skip: true } },
      { id: 3 },
      { id: 4, frontmatter: { embed_skip: true } },
      { id: 5 },
    ];
    expect(filterOutEmbedSkipped(pages).map((p) => p.id)).toEqual([1, 3, 5]);
  });
});

describe('buildEmbedSkipMarker', () => {
  test('returns canonical marker shape', () => {
    const marker = buildEmbedSkipMarker(123456);
    expect(marker.reason).toBe('oversized');
    expect(marker.bytes).toBe(123456);
    expect(typeof marker.assessed_at).toBe('string');
    expect(() => new Date(marker.assessed_at)).not.toThrow();
  });
  test('uses injected Date for deterministic tests', () => {
    const d = new Date('2026-05-24T07:00:00Z');
    const m = buildEmbedSkipMarker(100, d);
    expect(m.assessed_at).toBe('2026-05-24T07:00:00.000Z');
  });
});

describe('EMBED_SKIP_FILTER_FRAGMENT', () => {
  test('fragment references the canonical key name', () => {
    expect(EMBED_SKIP_FILTER_FRAGMENT).toContain(`'${EMBED_SKIP_KEY}'`);
  });
  test('fragment negates (NOT) so kept rows are without the marker', () => {
    expect(EMBED_SKIP_FILTER_FRAGMENT.trim().startsWith('NOT')).toBe(true);
  });
  test('fragment uses JSONB `?` existence operator (works on Postgres + PGLite)', () => {
    expect(EMBED_SKIP_FILTER_FRAGMENT).toContain(' ? ');
  });
  test('fragment COALESCEs null frontmatter so pages without one are not filtered', () => {
    expect(EMBED_SKIP_FILTER_FRAGMENT).toContain('COALESCE');
  });
  test('fragment assumes pages alias is `p` (engine-call-site contract)', () => {
    expect(EMBED_SKIP_FILTER_FRAGMENT).toContain('p.frontmatter');
  });
});
