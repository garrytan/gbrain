import { describe, test, expect } from 'bun:test';
import {
  QUARANTINE_KEY,
  QUARANTINE_FILTER_FRAGMENT,
  quarantineFilterFragment,
  buildQuarantineMarker,
  isQuarantined,
  filterOutQuarantined,
  CONTENT_FLAG_KEY,
  buildContentFlagMarker,
  getContentFlag,
  hasContentFlag,
} from '../src/core/quarantine.ts';

describe('quarantine marker (hides)', () => {
  test('buildQuarantineMarker shape', () => {
    const m = buildQuarantineMarker('junk_pattern', 'cloudflare_ray_id', { bytes: 1234, now: new Date('2026-06-01T00:00:00Z') });
    expect(m.reason).toBe('junk_pattern');
    expect(m.detail).toBe('cloudflare_ray_id');
    expect(m.bytes).toBe(1234);
    expect(m.assessed_at).toBe('2026-06-01T00:00:00.000Z');
  });

  test('isQuarantined: true only when key present + non-null', () => {
    expect(isQuarantined({ [QUARANTINE_KEY]: { reason: 'junk_pattern' } })).toBe(true);
    expect(isQuarantined({})).toBe(false);
    expect(isQuarantined(null)).toBe(false);
    expect(isQuarantined(undefined)).toBe(false);
    expect(isQuarantined({ [QUARANTINE_KEY]: null })).toBe(false);
  });

  test('filterOutQuarantined drops quarantined pages', () => {
    const pages = [
      { slug: 'a', frontmatter: {} },
      { slug: 'b', frontmatter: { [QUARANTINE_KEY]: { reason: 'junk_pattern' } } },
      { slug: 'c', frontmatter: null },
    ];
    expect(filterOutQuarantined(pages).map((p) => p.slug)).toEqual(['a', 'c']);
  });

  test('QUARANTINE_FILTER_FRAGMENT is a negated JSONB existence check on p', () => {
    expect(QUARANTINE_FILTER_FRAGMENT).toContain("p.frontmatter");
    expect(QUARANTINE_FILTER_FRAGMENT).toContain("? 'quarantine'");
    expect(QUARANTINE_FILTER_FRAGMENT.startsWith('NOT (')).toBe(true);
  });

  test('quarantineFilterFragment(alias) parameterizes the page alias; constant is the p-instance', () => {
    expect(quarantineFilterFragment('p')).toBe(QUARANTINE_FILTER_FRAGMENT);
    expect(quarantineFilterFragment('xx')).toContain('xx.frontmatter');
    expect(quarantineFilterFragment('xx')).toContain("? 'quarantine'");
  });
});

describe('content_flag marker (warns, does NOT hide)', () => {
  test('buildContentFlagMarker shape (markup_heavy)', () => {
    const m = buildContentFlagMarker('markup_heavy', 'ratio 0.91', { markup_ratio: 0.91, now: new Date('2026-06-01T00:00:00Z') });
    expect(m.reason).toBe('markup_heavy');
    expect(m.markup_ratio).toBe(0.91);
    expect(m.bytes).toBeUndefined();
  });

  test('getContentFlag returns reason+detail or null', () => {
    expect(getContentFlag({ [CONTENT_FLAG_KEY]: { reason: 'oversized', detail: 'big' } })).toEqual({ reason: 'oversized', detail: 'big' });
    expect(getContentFlag({ [CONTENT_FLAG_KEY]: { detail: 'no reason' } })).toBeNull();
    expect(getContentFlag({})).toBeNull();
    expect(getContentFlag(null)).toBeNull();
  });

  test('hasContentFlag mirrors getContentFlag presence', () => {
    expect(hasContentFlag({ [CONTENT_FLAG_KEY]: { reason: 'markup_heavy' } })).toBe(true);
    expect(hasContentFlag({})).toBe(false);
  });

  test('there is deliberately NO content_flag SQL filter fragment exported', async () => {
    // Flagged pages stay searchable by design — the module must not export a
    // QUARANTINE_FILTER_FRAGMENT analog for content_flag.
    const mod = await import('../src/core/quarantine.ts');
    expect('CONTENT_FLAG_FILTER_FRAGMENT' in mod).toBe(false);
  });
});
