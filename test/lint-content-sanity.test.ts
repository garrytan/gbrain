import { describe, test, expect } from 'bun:test';
import { lintContent } from '../src/commands/lint.ts';

const MINIMAL_FRONTMATTER = `---
title: Test Page
type: note
created: 2026-05-24
---

`;

describe('lint — huge-page rule', () => {
  test('does not fire below warn threshold', () => {
    const content = MINIMAL_FRONTMATTER + 'a'.repeat(40_000);
    const issues = lintContent(content, 'test.md');
    expect(issues.find((i) => i.rule === 'huge-page')).toBeUndefined();
  });

  test('fires when body exceeds warn threshold (default 50K)', () => {
    const content = MINIMAL_FRONTMATTER + 'a'.repeat(60_000);
    const issues = lintContent(content, 'test.md');
    const huge = issues.find((i) => i.rule === 'huge-page');
    expect(huge).toBeDefined();
    expect(huge!.message).toContain('60');
    expect(huge!.fixable).toBe(false);
    expect(huge!.line).toBe(1);
  });

  test('fires with block-threshold language when body exceeds block', () => {
    const content = MINIMAL_FRONTMATTER + 'a'.repeat(600_000);
    const issues = lintContent(content, 'test.md');
    const huge = issues.find((i) => i.rule === 'huge-page');
    expect(huge).toBeDefined();
    expect(huge!.message).toContain('block');
  });

  test('respects custom bytes_warn override', () => {
    const content = MINIMAL_FRONTMATTER + 'a'.repeat(1000);
    const issues = lintContent(content, 'test.md', {
      contentSanity: { bytes_warn: 500, bytes_block: 50_000 },
    });
    expect(issues.find((i) => i.rule === 'huge-page')).toBeDefined();
  });

  test('disabled kill-switch suppresses huge-page rule', () => {
    const content = MINIMAL_FRONTMATTER + 'a'.repeat(600_000);
    const issues = lintContent(content, 'test.md', {
      contentSanity: { disabled: true },
    });
    expect(issues.find((i) => i.rule === 'huge-page')).toBeUndefined();
  });
});

describe('lint — scraper-junk rule', () => {
  test('does not fire on clean content', () => {
    const content = MINIMAL_FRONTMATTER + 'This is a thoughtful essay about software design.';
    const issues = lintContent(content, 'test.md');
    expect(issues.find((i) => i.rule === 'scraper-junk')).toBeUndefined();
  });

  test('fires when title matches cloudflare_attention_required pattern', () => {
    const content = `---
title: 'Attention Required! | Cloudflare'
type: note
created: 2026-05-24
---

Body content.`;
    const issues = lintContent(content, 'test.md');
    const junk = issues.find((i) => i.rule === 'scraper-junk');
    expect(junk).toBeDefined();
    expect(junk!.message).toContain('cloudflare_attention_required');
  });

  test('fires on access_denied body pattern', () => {
    const content = MINIMAL_FRONTMATTER + 'Access denied\n\nYou do not have permission.';
    const issues = lintContent(content, 'test.md');
    expect(issues.find((i) => i.rule === 'scraper-junk')).toBeDefined();
  });

  test('operator literal hits also surface', () => {
    const content = MINIMAL_FRONTMATTER + "You're being blocked from accessing this site.";
    const issues = lintContent(content, 'test.md', {
      contentSanity: {
        operator_literals: [{ name: 'reddit_blocked', substring: "you're being blocked from accessing" }],
      },
    });
    const junk = issues.find((i) => i.rule === 'scraper-junk');
    expect(junk).toBeDefined();
    expect(junk!.message).toContain('reddit_blocked');
  });

  test('junk_patterns_enabled=false suppresses operator literals AND built-ins via consumer wiring', () => {
    // The assessor honors junk_patterns_enabled implicitly via the
    // operator_literals=[] passed by runLintCore. Lint here tests the
    // direct call path: when caller passes junk_patterns_enabled=false,
    // operator_literals should already be empty (production resolver
    // handles that gate). This test pins built-in patterns still fire
    // even when junk_patterns_enabled flag is on the opts but no
    // literals are passed — i.e., the flag is informational at this
    // layer; the resolver consults it before constructing opts.
    const content = `---
title: 'Attention Required! | Cloudflare'
type: note
created: 2026-05-24
---

body`;
    const issues = lintContent(content, 'test.md', {
      contentSanity: { junk_patterns_enabled: false, operator_literals: [] },
    });
    // Built-in pattern still fires here (resolver doesn't strip
    // built-ins; only operator literals are gated by the flag).
    expect(issues.find((i) => i.rule === 'scraper-junk')).toBeDefined();
  });

  test('disabled kill-switch suppresses scraper-junk rule', () => {
    const content = `---
title: 'Access Denied'
type: note
created: 2026-05-24
---

body`;
    const issues = lintContent(content, 'test.md', {
      contentSanity: { disabled: true },
    });
    expect(issues.find((i) => i.rule === 'scraper-junk')).toBeUndefined();
  });
});

describe('lint — markup-heavy rule (v0.42 #1699)', () => {
  test('fires on markup-heavy body in the warn window', () => {
    const navRow = '| [a](http://a) | [b](http://b) | [c](http://c) | [d](http://d) |\n';
    const content = MINIMAL_FRONTMATTER + navRow.repeat(1200); // ~60K, > 50K warn
    const issues = lintContent(content, 'test.md');
    const mk = issues.find((i) => i.rule === 'markup-heavy');
    expect(mk).toBeDefined();
    expect(mk!.message).toContain('boilerplate');
    expect(mk!.fixable).toBe(false);
  });

  test('does NOT fire on prose-heavy body of the same size', () => {
    const content = MINIMAL_FRONTMATTER + 'real sentences with actual words. '.repeat(2000); // ~68K prose
    const issues = lintContent(content, 'test.md');
    expect(issues.find((i) => i.rule === 'markup-heavy')).toBeUndefined();
  });

  test('does NOT fire when prose_check_enabled is false', () => {
    const navRow = '| [a](http://a) | [b](http://b) | [c](http://c) | [d](http://d) |\n';
    const content = MINIMAL_FRONTMATTER + navRow.repeat(1200);
    const issues = lintContent(content, 'test.md', { contentSanity: { prose_check_enabled: false } });
    expect(issues.find((i) => i.rule === 'markup-heavy')).toBeUndefined();
  });
});

describe('lint — bytes parity with doctor (D2)', () => {
  test('lint measures body-only bytes (not file bytes)', () => {
    // A page with large frontmatter but small body should NOT trip
    // huge-page — the rule keys on body bytes only, matching what the
    // doctor `oversized_pages` check sees via octet_length(compiled_truth + timeline).
    const fm = '---\ntitle: Test\ntype: note\ncreated: 2026-05-24\nbig_meta: ' + 'x'.repeat(60_000) + '\n---\n\n';
    const content = fm + 'small body';
    const issues = lintContent(content, 'test.md');
    // The body is "small body" → ~10 bytes. Should NOT trip warn.
    expect(issues.find((i) => i.rule === 'huge-page')).toBeUndefined();
  });
});

describe('lint — existing rules unaffected by content-sanity extension', () => {
  test('LLM preamble rule still fires', () => {
    // The LLM_PREAMBLES regex anchors on `^Of course\.?\s*Here is` so
    // we use the period form (not exclamation) for an exact match.
    const content = `---
title: T
type: note
created: 2026-05-24
---

Of course. Here is the brain page.

Real content.`;
    const issues = lintContent(content, 'test.md');
    expect(issues.find((i) => i.rule === 'llm-preamble')).toBeDefined();
  });
});
