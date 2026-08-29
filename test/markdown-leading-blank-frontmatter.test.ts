/**
 * #4526 — a leading blank line before the `---` fence made parseMarkdown
 * miss the entire frontmatter block: gray-matter only recognizes a fence at
 * byte 0, while the rest of the pipeline (frontmatterBodyOffset,
 * collectValidationErrors' MISSING_OPEN check) tolerates leading blanks.
 * Result: empty frontmatter, the block left embedded in the body, and the
 * title humanized from the slug — a raw UUID for `fact/<uuid>` session-digest
 * pages ("2bcdd03c Bffd 4452 A6b8 25294c969c78" in every listing).
 *
 * Second arm: pages already corrupted by the pre-fix parse carry the real
 * frontmatter EMBEDDED at the top of the body (double-frontmatter after a
 * get→put round-trip). When the title would otherwise merely humanize the
 * slug/filename, the embedded block's `title:` is promoted instead.
 */

import { describe, test, expect } from 'bun:test';
import { parseMarkdown } from '../src/core/markdown.ts';

describe('parseMarkdown — leading blank line before frontmatter (#4526)', () => {
  test('a single leading newline no longer hides the frontmatter block', () => {
    const content = '\n---\ntitle: Real Title\ntype: note\n---\nbody text here\n';
    const parsed = parseMarkdown(content, 'fact/2bcdd03c-bffd-4452-a6b8-25294c969c78.md');
    expect(parsed.title).toBe('Real Title');
    expect(parsed.type).toBe('note');
    // The block must be LIFTED out of the body, not left embedded.
    expect(parsed.compiled_truth).toBe('body text here');
  });

  test('multiple blank lines + CRLF endings also parse', () => {
    const content = '\r\n\r\n---\r\ntitle: CRLF Title\r\ntype: note\r\n---\r\nbody\r\n';
    const parsed = parseMarkdown(content, 'fact/uuid-here.md');
    expect(parsed.title).toBe('CRLF Title');
    expect(parsed.compiled_truth).not.toContain('---');
  });

  test('no-frontmatter files are untouched (first non-empty line is not a fence)', () => {
    const content = '\nJust some body text\nwith lines\n';
    const parsed = parseMarkdown(content, 'notes/plain-file.md');
    expect(parsed.title).toBe('Plain File');
    expect(parsed.compiled_truth).toBe('Just some body text\nwith lines');
  });

  test('valid frontmatter at byte 0 still parses exactly as before', () => {
    const content = '---\ntitle: Normal\ntype: note\n---\nbody\n';
    const parsed = parseMarkdown(content, 'notes/normal.md');
    expect(parsed.title).toBe('Normal');
    expect(parsed.compiled_truth).toBe('body');
  });
});

describe('parseMarkdown — embedded-frontmatter title promotion (#4526)', () => {
  test('double-frontmatter round-trip promotes the embedded title over slug humanization', () => {
    // A pre-fix corrupted page round-tripped through get→put: real (titleless)
    // frontmatter, then the original block embedded at the top of the body.
    const content = '---\ntype: note\n---\n---\ntitle: tg-comment-guard dashboard\nkind: session-digest\n---\nreal body\n';
    const parsed = parseMarkdown(content, 'fact/2bcdd03c-bffd-4452-a6b8-25294c969c78.md');
    expect(parsed.title).toBe('tg-comment-guard dashboard');
  });

  test('a frontmatter title still wins over an embedded block', () => {
    const content = '---\ntitle: Outer Title\n---\n---\ntitle: Inner Title\n---\nbody\n';
    const parsed = parseMarkdown(content, 'fact/uuid.md');
    expect(parsed.title).toBe('Outer Title');
  });

  test('a body H1 still wins over an embedded block', () => {
    const content = '---\ntype: note\n---\n---\ntitle: Inner Title\n---\n# Heading Title\nbody\n';
    const parsed = parseMarkdown(content, 'fact/uuid.md');
    expect(parsed.title).toBe('Heading Title');
  });

  test('an embedded block without title: falls back to filename humanization', () => {
    const content = '---\ntype: note\n---\n---\nkind: session-digest\n---\nbody\n';
    const parsed = parseMarkdown(content, 'notes/some-file.md');
    expect(parsed.title).toBe('Some File');
  });
});
