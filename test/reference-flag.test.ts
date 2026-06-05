import { describe, expect, test } from 'bun:test';
import { referenceExclusionSql, REFERENCE_FRONTMATTER_KEY } from '../src/core/reference-flag.ts';
import { applyReferenceFrontmatter } from '../src/commands/reference.ts';

describe('referenceExclusionSql', () => {
  test('bare pages (no alias)', () => {
    expect(referenceExclusionSql()).toBe(`(frontmatter->>'reference') IS DISTINCT FROM 'true'`);
  });
  test('aliased', () => {
    expect(referenceExclusionSql('p')).toBe(`(p.frontmatter->>'reference') IS DISTINCT FROM 'true'`);
  });
  test('key constant', () => {
    expect(REFERENCE_FRONTMATTER_KEY).toBe('reference');
  });
});

describe('applyReferenceFrontmatter', () => {
  const page = `---\ntitle: Andy Grove\ntype: person\ntags: []\n---\n\n# Andy Grove\n\nBody.`;

  test('adds reference: true to an existing frontmatter block', () => {
    const out = applyReferenceFrontmatter(page, true);
    expect(out).toContain('reference: true');
    expect(out).toContain('type: person');   // other keys preserved
    expect(out).toContain('# Andy Grove');    // body preserved
  });

  test('is idempotent — does not duplicate the key', () => {
    const once = applyReferenceFrontmatter(page, true);
    const twice = applyReferenceFrontmatter(once, true);
    expect(twice).toBe(once);
    expect(twice.match(/reference: true/g)).toHaveLength(1);
  });

  test('replaces a stale reference: false with true', () => {
    const off = `---\ntype: person\nreference: false\n---\n\nBody.`;
    const out = applyReferenceFrontmatter(off, true);
    expect(out).toContain('reference: true');
    expect(out).not.toContain('reference: false');
  });

  test('--unset removes the key', () => {
    const on = applyReferenceFrontmatter(page, true);
    const off = applyReferenceFrontmatter(on, false);
    expect(off).not.toContain('reference:');
    expect(off).toContain('type: person');
  });

  test('--unset on a page without the key is a no-op', () => {
    expect(applyReferenceFrontmatter(page, false)).toBe(page);
  });

  test('setting on a frontmatter-less page prepends a block', () => {
    const raw = '# Just a heading\n\nNo frontmatter here.';
    const out = applyReferenceFrontmatter(raw, true);
    expect(out.startsWith('---\nreference: true\n---\n')).toBe(true);
    expect(out).toContain('# Just a heading');
  });

  test('preserves body containing YAML-special chars', () => {
    const tricky = `---\ntype: person\n---\n\nText with $& and $1 literals.`;
    const out = applyReferenceFrontmatter(tricky, true);
    expect(out).toContain('Text with $& and $1 literals.');
    expect(out).toContain('reference: true');
  });
});
