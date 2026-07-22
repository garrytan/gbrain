/**
 * Non-string frontmatter title/type/slug (#1883, #1658, #1556, #1948).
 *
 * A YAML scalar like `title: 123` parses to a NUMBER. Pre-fix the parser cast it
 * `as string`, so a non-string flowed downstream typed as string and crashed the
 * first `.toLowerCase()` in content-sanity — aborting the whole lint/sync run
 * brain-wide (root trigger behind the never-converging-sync reports #1794/#1939).
 *
 * Fix: coerce title to a string at the parser; for slug/type fall back to
 * inference (never fabricate a "123" slug); guard content-sanity defensively;
 * and surface the malformed frontmatter via a lint NON_STRING_FIELD finding.
 */
import { describe, test, expect } from 'bun:test';
import { parseMarkdown } from '../src/core/markdown.ts';
import { assessContentSanity } from '../src/core/content-sanity.ts';

const fm = (body: string) => `---\n${body}\n---\nbody text here\n`;

describe('parseMarkdown coerces/guards non-string frontmatter', () => {
  test('numeric title is coerced to a string (intent preserved)', () => {
    const p = parseMarkdown(fm('title: 123'), 'notes/thing.md');
    expect(typeof p.title).toBe('string');
    expect(p.title).toBe('123');
  });

  test('boolean title is coerced to a string', () => {
    const p = parseMarkdown(fm('title: false'), 'notes/thing.md');
    expect(p.title).toBe('false');
  });

  test('missing title falls back to inferred title (string)', () => {
    const p = parseMarkdown(fm('type: note'), 'notes/My Thing.md');
    expect(typeof p.title).toBe('string');
    expect(p.title.length).toBeGreaterThan(0);
  });

  test('non-string slug is coerced to a usable string (date slugs are legitimate)', () => {
    // YAML parses `2024-06-01` as a Date; coerceFrontmatterString → "2024-06-01".
    const p = parseMarkdown(fm('slug: 2024-06-01'), 'notes/real-slug.md');
    expect(typeof p.slug).toBe('string');
    expect(p.slug).toBe('2024-06-01');
  });

  test('numeric type is coerced to a string (never crashes downstream)', () => {
    const p = parseMarkdown(fm('type: 5\ntitle: ok'), 'notes/thing.md');
    expect(typeof p.type).toBe('string');
  });

  test('valid string fields pass through unchanged', () => {
    const p = parseMarkdown(fm('title: Real Title\ntype: concept\nslug: my-slug'), 'x.md');
    expect(p.title).toBe('Real Title');
    expect(p.type).toBe('concept');
    expect(p.slug).toBe('my-slug');
  });
});

describe('lint surfaces non-string frontmatter (NON_STRING_FIELD)', () => {
  test('numeric title produces a NON_STRING_FIELD validation error', () => {
    const p = parseMarkdown(fm('title: 123'), 'notes/thing.md', { validate: true });
    const codes = (p.errors ?? []).map(e => e.code);
    expect(codes).toContain('NON_STRING_FIELD');
  });

  test('all-string frontmatter produces no NON_STRING_FIELD error', () => {
    const p = parseMarkdown(fm('title: Fine\ntype: note'), 'notes/thing.md', { validate: true });
    const codes = (p.errors ?? []).map(e => e.code);
    expect(codes).not.toContain('NON_STRING_FIELD');
  });
});

describe('assessContentSanity never throws on a non-string title (belt-and-suspenders)', () => {
  test('numeric title does not crash the sanity pass', () => {
    expect(() =>
      assessContentSanity({ compiled_truth: 'hello world', timeline: '', title: 123 as unknown as string }),
    ).not.toThrow();
  });

  test('undefined title does not crash the sanity pass', () => {
    expect(() =>
      assessContentSanity({ compiled_truth: 'hello world', timeline: '', title: undefined as unknown as string }),
    ).not.toThrow();
  });
});
