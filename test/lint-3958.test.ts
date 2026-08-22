/**
 * issue #3958 — three lint honesty fixes:
 *
 * 1. The "Run with --fix" hint only prints when at least one finding is
 *    actually fixable (LintResult.total_fixable), so an all-unfixable report
 *    can't send the operator on a no-op --fix run.
 * 2. missing-created is FIXABLE when the page's own frontmatter carries a
 *    capture timestamp (captured_at / ingested_at) — fixContent promotes it
 *    to created.
 * 3. placeholder-date skips lines inside fenced code blocks: a page
 *    DOCUMENTING date formats (```\ncreated: YYYY-MM-DD\n```) is not a page
 *    with an unfilled placeholder.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  lintContent,
  fixContent,
  promoteCreatedFromCapture,
  runLintCore,
  runLint,
} from '../src/commands/lint.ts';

const SANITY_OFF = { disabled: true } as const;

describe('#3958 placeholder-date skips fenced code blocks', () => {
  test('YYYY-MM-DD inside a ``` fence is not a placeholder', () => {
    const content =
      '---\ntitle: Date docs\ntype: note\ncreated: 2026-01-05\n---\n\n# Formats\n\n' +
      '```\ncreated: YYYY-MM-DD\n```\n\nDone.\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    expect(issues.filter(i => i.rule === 'placeholder-date')).toHaveLength(0);
  });

  test('YYYY-MM-DD inside a ~~~ fence is not a placeholder', () => {
    const content =
      '---\ntitle: Date docs\ntype: note\ncreated: 2026-01-05\n---\n\n' +
      '~~~yaml\ndate: YYYY-MM-DD\n~~~\n\nDone.\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    expect(issues.filter(i => i.rule === 'placeholder-date')).toHaveLength(0);
  });

  test('placeholder OUTSIDE a fence still fires, with the right line', () => {
    const content =
      '---\ntitle: T\ntype: note\ncreated: 2026-01-05\n---\n\n' +
      '```\nexample: YYYY-MM-DD\n```\n\n- 2026-XX-XX | unfilled event\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    const hits = issues.filter(i => i.rule === 'placeholder-date');
    expect(hits).toHaveLength(1);
    // Line 11 is the "- 2026-XX-XX | ..." line (1-indexed).
    expect(hits[0].line).toBe(11);
  });

  test('placeholder in frontmatter still fires (frontmatter is not a fence)', () => {
    const content = '---\ntitle: T\ntype: note\ncreated: YYYY-MM-DD\n---\n\n# T\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    expect(issues.some(i => i.rule === 'placeholder-date')).toBe(true);
  });
});

describe('#3958 missing-created is fixable via capture-timestamp promotion', () => {
  test('captured_at present -> missing-created is fixable', () => {
    const content = '---\ntitle: T\ntype: note\ncaptured_at: 2026-01-05T10:00:00Z\n---\n\n# T\n\nBody.\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    const mc = issues.find(i => i.rule === 'missing-created');
    expect(mc).toBeDefined();
    expect(mc!.fixable).toBe(true);
  });

  test('no capture field -> missing-created stays unfixable', () => {
    const content = '---\ntitle: T\ntype: note\n---\n\n# T\n\nBody.\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    const mc = issues.find(i => i.rule === 'missing-created');
    expect(mc).toBeDefined();
    expect(mc!.fixable).toBe(false);
  });

  test('promoteCreatedFromCapture copies captured_at verbatim', () => {
    const content = '---\ntitle: T\ncaptured_at: 2026-01-05T10:00:00Z\n---\n\nBody.\n';
    const out = promoteCreatedFromCapture(content);
    expect(out).toContain('created: 2026-01-05T10:00:00Z');
    // Inserted inside the frontmatter block, directly after captured_at.
    expect(out.indexOf('created:')).toBeGreaterThan(out.indexOf('captured_at:'));
    expect(out.indexOf('created:')).toBeLessThan(out.indexOf('---', 3) + 4);
  });

  test('promoteCreatedFromCapture falls back to ingested_at', () => {
    const content = '---\ntitle: T\ningested_at: "2026-02-01"\n---\n\nBody.\n';
    const out = promoteCreatedFromCapture(content);
    expect(out).toContain('created: "2026-02-01"');
  });

  test('promoteCreatedFromCapture prefers captured_at over ingested_at', () => {
    const content = '---\ntitle: T\ningested_at: 2026-02-01\ncaptured_at: 2026-01-05\n---\n\nBody.\n';
    const out = promoteCreatedFromCapture(content);
    expect(out).toContain('created: 2026-01-05');
    expect(out).not.toContain('created: 2026-02-01');
  });

  test('promoteCreatedFromCapture is a no-op when created exists / no frontmatter', () => {
    const withCreated = '---\ntitle: T\ncreated: 2025-12-31\ncaptured_at: 2026-01-05\n---\n\nBody.\n';
    expect(promoteCreatedFromCapture(withCreated)).toBe(withCreated);
    const noFm = '# Just a heading\n\ncaptured_at: 2026-01-05\n';
    expect(promoteCreatedFromCapture(noFm)).toBe(noFm);
  });

  test('fixContent heals missing-created end-to-end (incl. fence-wrapped pages)', () => {
    const wrapped =
      '```markdown\n---\ntitle: T\ntype: note\ncaptured_at: 2026-01-05\n---\n\n# T\n\nBody.\n```';
    const fixed = fixContent(wrapped);
    expect(fixed.startsWith('---')).toBe(true);
    expect(fixed).toContain('created: 2026-01-05');
    const after = lintContent(fixed, 'test.md', { contentSanity: SANITY_OFF });
    expect(after.filter(i => i.rule === 'missing-created')).toHaveLength(0);
    expect(after.filter(i => i.rule === 'code-fence-wrap')).toHaveLength(0);
  });
});

describe('#3958 total_fixable + the --fix hint gate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-lint-3958-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('runLintCore reports total_fixable separately from total_issues', async () => {
    // One unfixable issue (placeholder-date in the body) + one fixable page
    // (missing-created promotable from captured_at).
    writeFileSync(
      join(dir, 'unfixable.md'),
      '---\ntitle: A\ntype: note\ncreated: 2026-01-05\n---\n\n- 2026-XX-XX | pending\n',
    );
    writeFileSync(
      join(dir, 'fixable.md'),
      '---\ntitle: B\ntype: note\ncaptured_at: 2026-01-05\n---\n\n# B\n\nBody.\n',
    );
    const result = await runLintCore({ target: dir, contentSanity: SANITY_OFF as never });
    expect(result.total_issues).toBe(2);
    expect(result.total_fixable).toBe(1);
  });

  test('runLintCore --fix writes the promoted created field', async () => {
    const page = join(dir, 'fixable.md');
    writeFileSync(page, '---\ntitle: B\ntype: note\ncaptured_at: 2026-01-05\n---\n\n# B\n\nBody.\n');
    const result = await runLintCore({ target: dir, fix: true, contentSanity: SANITY_OFF as never });
    expect(result.total_fixed).toBe(1);
    expect(readFileSync(page, 'utf-8')).toContain('created: 2026-01-05');
  });

  test('hint prints only when something is fixable', async () => {
    writeFileSync(
      join(dir, 'unfixable.md'),
      '---\ntitle: A\ntype: note\ncreated: 2026-01-05\n---\n\n- 2026-XX-XX | pending\n',
    );
    const logged: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
    try {
      await runLint([dir]);
    } finally {
      console.log = orig;
    }
    expect(logged.join('\n')).not.toContain('Run with --fix');

    // Add a fixable page: the hint appears.
    writeFileSync(
      join(dir, 'fixable.md'),
      '---\ntitle: B\ntype: note\ncaptured_at: 2026-01-05\n---\n\n# B\n\nBody.\n',
    );
    const logged2: string[] = [];
    console.log = (...a: unknown[]) => { logged2.push(a.join(' ')); };
    try {
      await runLint([dir]);
    } finally {
      console.log = orig;
    }
    expect(logged2.join('\n')).toContain('Run with --fix');
  });
});
