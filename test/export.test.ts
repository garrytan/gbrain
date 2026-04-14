import { describe, test, expect } from 'bun:test';
import { normalizeInternalLinks } from '../src/commands/export.ts';

describe('normalizeInternalLinks', () => {
  // ─────────────────────────────────────────────────────────────────
  // The bug this fixes:
  //
  // GBrain stores internal references in slug form, e.g. `[小龙](./小龙)`.
  // Inside GBrain that resolves correctly because the slug is the canonical
  // identifier. But when exported as `.md` files on disk, markdown viewers
  // (Obsidian, VS Code preview, GitHub web view) look for a literal file at
  // `./小龙` — which doesn't exist (the file is `./小龙.md`). All internal
  // links are silently broken on disk.
  //
  // normalizeInternalLinks rewrites `[label](slug)` -> `[label](slug.md)`
  // for internal references during export, leaving external URLs and links
  // that already have a file extension untouched.
  // ─────────────────────────────────────────────────────────────────

  describe('appends .md to internal slug-form links', () => {
    test('appends to same-directory slug', () => {
      expect(normalizeInternalLinks('See [Alice](./alice) for context.'))
        .toBe('See [Alice](./alice.md) for context.');
    });

    test('appends to bare slug (no ./ prefix)', () => {
      expect(normalizeInternalLinks('See [Alice](alice).'))
        .toBe('See [Alice](alice.md).');
    });

    test('appends to parent-directory slug', () => {
      expect(normalizeInternalLinks('See [Alice](../people/alice).'))
        .toBe('See [Alice](../people/alice.md).');
    });

    test('appends to deeply nested slug', () => {
      expect(normalizeInternalLinks('See [Decision](../../decisions/2026/q2/alpha).'))
        .toBe('See [Decision](../../decisions/2026/q2/alpha.md).');
    });

    test('handles CJK slugs (the actual real-world case)', () => {
      const input = '在 一洋 和 [小龙](../people/小龙) 的对话中形成的概念。';
      const expected = '在 一洋 和 [小龙](../people/小龙.md) 的对话中形成的概念。';
      expect(normalizeInternalLinks(input)).toBe(expected);
    });

    test('handles multiple links in the same line', () => {
      const input = 'Discussed by [Alice](./alice) and [Bob](./bob).';
      const expected = 'Discussed by [Alice](./alice.md) and [Bob](./bob.md).';
      expect(normalizeInternalLinks(input)).toBe(expected);
    });

    test('handles links across multi-line markdown', () => {
      const input = `## Related
- [Alice](./alice) — co-author
- [Bob](../people/bob) — reviewer
- [Concept X](concepts/x) — origin`;
      const expected = `## Related
- [Alice](./alice.md) — co-author
- [Bob](../people/bob.md) — reviewer
- [Concept X](concepts/x.md) — origin`;
      expect(normalizeInternalLinks(input)).toBe(expected);
    });
  });

  describe('leaves external links untouched', () => {
    test('https URL', () => {
      const input = 'See [docs](https://example.com/path/to/doc).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });

    test('http URL', () => {
      const input = 'See [old site](http://example.com).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });

    test('mailto', () => {
      const input = 'Email [me](mailto:user@example.com).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });

    test('file scheme', () => {
      const input = 'See [local](file:///etc/hosts).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });

    test('ftp scheme', () => {
      const input = 'Get [data](ftp://example.com/data).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });

    test('tel scheme', () => {
      const input = 'Call [me](tel:+1234567890).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });
  });

  describe('leaves links that already have an extension untouched', () => {
    test('already .md', () => {
      const input = 'See [Alice](./alice.md).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });

    test('image .png', () => {
      const input = 'Logo: [img](./logo.png).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });

    test('document .pdf', () => {
      const input = 'Report: [pdf](../docs/report.pdf).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });

    test('uppercase extension', () => {
      const input = 'See [doc](./alice.MD).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });

    test('no extension change for files like v1.0.0 (treated as already-extended)', () => {
      // `v1.0.0` ends with `.0` which matches the extension regex. We accept this
      // false-positive: better to under-rewrite than to break a versioned filename.
      const input = 'See [v1](./v1.0.0).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });
  });

  describe('leaves anchors and special targets alone', () => {
    test('pure anchor', () => {
      const input = 'Jump to [top](#top).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });

    test('empty target', () => {
      const input = 'Empty [link]().';
      expect(normalizeInternalLinks(input)).toBe(input);
    });

    test('trailing slash (directory reference)', () => {
      const input = 'See [folder](./people/).';
      expect(normalizeInternalLinks(input)).toBe(input);
    });
  });

  describe('preserves query strings and anchors', () => {
    test('preserves anchor on internal link', () => {
      expect(normalizeInternalLinks('See [Section](./alice#bio).'))
        .toBe('See [Section](./alice.md#bio).');
    });

    test('preserves query on internal link', () => {
      expect(normalizeInternalLinks('See [Search](./alice?q=test).'))
        .toBe('See [Search](./alice.md?q=test).');
    });
  });

  describe('handles edge cases gracefully', () => {
    test('empty content', () => {
      expect(normalizeInternalLinks('')).toBe('');
    });

    test('content with no links', () => {
      const input = '# Title\n\nJust some text. No links here.';
      expect(normalizeInternalLinks(input)).toBe(input);
    });

    test('label with brackets is not confused with link', () => {
      // markdown spec: `[text]` alone (no parens) is a reference, not inline link
      const input = 'See [Alice] for details.';
      expect(normalizeInternalLinks(input)).toBe(input);
    });
  });
});
