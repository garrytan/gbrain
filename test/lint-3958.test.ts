/**
 * issue #3958 — three lint honesty fixes:
 *
 * 1. The "Run with --fix" hint only prints when at least one finding is
 *    actually fixable (LintResult.total_fixable), so an all-unfixable report
 *    can't send the operator on a no-op --fix run.
 * 2. (superseded by #5433) missing-created used to be FIXABLE when the
 *    page's own frontmatter carried a capture timestamp. Ingest time is not
 *    creation time, so the promotion is out of fixContent; the rule now
 *    accepts any parseable temporal key and is never fixable.
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
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import type { Page } from '../src/core/types.ts';

const SANITY_OFF = { disabled: true } as const;

// #6133: inline code spans (CommonMark backtick runs, double-backtick spans included) are code too.
describe('#6133 placeholder-date skips inline code spans', () => {
  test('inline, table-cell and double-backtick spans give no hits; prose and frontmatter still fire', () => {
    const content = [
      '---', 'title: Formats', 'type: note', 'created: YYYY-MM-DD', '---', '',
      'Use `YYYY-MM-DD` for dates.',
      '| field | format |', '|---|---|', '| created | `2026-XX-XX` |',
      'A span with a tick inside: `` `XX-XX` stays code ``.',
      'This event is still 2026-XX-XX in prose.',
    ].join('\n');
    const hits = lintContent(content, 'test.md', { contentSanity: SANITY_OFF }).filter(i => i.rule === 'placeholder-date');
    expect(hits.map(h => h.line)).toEqual([4, 12]);
  });
});

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

// #6257: `## ` lines inside code fences are code, not sections.
describe('#6257 empty-section ignores headings inside code fences', () => {
  const FM = ['---', 'title: Meeting template', 'type: note', 'created: 2026-01-05', '---', ''];
  const sections = (content: string) =>
    lintContent(content, 'test.md', { contentSanity: SANITY_OFF }).filter(i => i.rule === 'empty-section');

  test('a ```markdown template with `## ` lines gives no findings', () => {
    const content = [...FM,
      '## Template', '',
      '```markdown',
      '## One-line overview',
      '## Decisions',
      '## Action items',
      '```', '',
      'Copy it into each meeting note.',
    ].join('\n');
    expect(sections(content)).toEqual([]);
  });

  test('a real empty section after a fenced block still fires, with the right line and title', () => {
    const content = [...FM,
      '## Example', '',
      '~~~',
      '## not a heading',
      '~~~', '',
      '## Open `questions`', '',
      '## Notes', '', 'Some text.',
    ].join('\n');
    const hits = sections(content);
    expect(hits.map(h => [h.line, h.message])).toEqual([[13, 'Empty section: ## Open `questions`']]);
  });

  test('a section whose only body is a code block is not empty', () => {
    const content = [...FM, '## Example', '', '```bash', 'gbrain doctor', '```', '', '## Notes', '', 'Text.'].join('\n');
    expect(sections(content)).toEqual([]);
  });

  test('an unclosed fence masks every heading after it', () => {
    const content = [...FM, '## Usage', '', 'Run this:', '', '```', '## Empty one', '', '## Empty two', ''].join('\n');
    expect(sections(content)).toEqual([]);
  });
});

describe('#5433 missing-created accepts any temporal key and is never fixable', () => {
  const rule = (content: string) =>
    lintContent(content, 'test.md', { contentSanity: SANITY_OFF }).filter(i => i.rule === 'missing-created');

  test.each([
    ['created', 'created: 2026-01-05'],
    ['event_date', 'event_date: 2026-01-05'],
    ['date', 'date: 2026-01-05'],
    ['published', 'published: "2026-01-05"'],
    ['captured_at', 'captured_at: 2026-01-05T10:00:00Z'],
    ['ingested_at', "ingested_at: '2026-01-05T10:00:00.000Z'"],
  ])('%s alone satisfies the rule', (_key, line) => {
    expect(rule(`---\ntitle: T\ntype: note\n${line}\n---\n\n# T\n\nBody.\n`)).toEqual([]);
  });

  test('no temporal key -> missing-created, unfixable', () => {
    const hits = rule('---\ntitle: T\ntype: note\n---\n\n# T\n\nBody.\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].fixable).toBe(false);
    expect(hits[0].message).toContain('event_date');
  });

  test('an unparseable value does not count (placeholder, garbage)', () => {
    expect(rule('---\ntitle: T\ntype: note\ncreated: YYYY-MM-DD\n---\n\n# T\n')).toHaveLength(1);
    expect(rule('---\ntitle: T\ntype: note\ncreated: soonish\ncaptured_at: 2026-02-30\n---\n\n# T\n')).toHaveLength(1);
  });

  test('a page the native serializer emits (ingested_at only) is clean and fixContent leaves it byte-identical', () => {
    const page = {
      slug: 'notes/example', title: 'Example', type: 'note', compiled_truth: '# Example\n\nBody.', timeline: '',
      frontmatter: { ingested_at: '2026-01-05T10:00:00.000Z' },
    } as unknown as Page;
    const content = serializePageToMarkdown(page, []);
    expect(content).not.toContain('created:');
    const issues = lintContent(content, 'notes/example.md', { contentSanity: SANITY_OFF });
    expect(issues.filter(i => i.rule === 'missing-created')).toEqual([]);
    expect(issues.some(i => i.fixable)).toBe(false);
    expect(fixContent(content)).toBe(content);
    expect(fixContent(fixContent(content))).toBe(content);
  });

  test('fixContent no longer promotes a capture timestamp (fence unwrap still works)', () => {
    const wrapped = '```markdown\n---\ntitle: T\ntype: note\ncaptured_at: 2026-01-05\n---\n\n# T\n\nBody.\n```';
    const fixed = fixContent(wrapped);
    expect(fixed.startsWith('---')).toBe(true);
    expect(fixed).not.toContain('created:');
    const after = lintContent(fixed, 'test.md', { contentSanity: SANITY_OFF });
    expect(after.filter(i => i.rule === 'missing-created')).toHaveLength(0);
    expect(after.filter(i => i.rule === 'code-fence-wrap')).toHaveLength(0);
  });

  test('promoteCreatedFromCapture is still exported for explicit callers (deprecated)', () => {
    const content = '---\ntitle: T\ningested_at: 2026-02-01\ncaptured_at: 2026-01-05\n---\n\nBody.\n';
    const out = promoteCreatedFromCapture(content);
    expect(out).toContain('created: 2026-01-05');
    expect(out).not.toContain('created: 2026-02-01');
    const withCreated = '---\ntitle: T\ncreated: 2025-12-31\ncaptured_at: 2026-01-05\n---\n\nBody.\n';
    expect(promoteCreatedFromCapture(withCreated)).toBe(withCreated);
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
    // (an LLM preamble; #5433 took missing-created out of the fixable set).
    writeFileSync(
      join(dir, 'unfixable.md'),
      '---\ntitle: A\ntype: note\ncreated: 2026-01-05\n---\n\n- 2026-XX-XX | pending\n',
    );
    writeFileSync(
      join(dir, 'fixable.md'),
      '---\ntitle: B\ntype: note\ncaptured_at: 2026-01-05\n---\n\nOf course. Here is the page.\n\n# B\n\nBody.\n',
    );
    const result = await runLintCore({ target: dir, contentSanity: SANITY_OFF as never });
    expect(result.total_issues).toBe(2);
    expect(result.total_fixable).toBe(1);
  });

  test('runLintCore --fix strips the preamble and never writes created', async () => {
    const page = join(dir, 'fixable.md');
    writeFileSync(page, '---\ntitle: B\ntype: note\ncaptured_at: 2026-01-05\n---\n\nOf course. Here is the page.\n\n# B\n\nBody.\n');
    const result = await runLintCore({ target: dir, fix: true, contentSanity: SANITY_OFF as never });
    expect(result.total_fixed).toBe(1);
    const after = readFileSync(page, 'utf-8');
    expect(after).not.toContain('Of course');
    expect(after).not.toContain('created:');
  });

  test('#5433 repeated --fix runs leave a native (ingested_at-only) page byte-identical', async () => {
    const page = join(dir, 'native.md');
    const content = serializePageToMarkdown({
      slug: 'native', title: 'Native', type: 'note', compiled_truth: '# Native\n\nBody.', timeline: '',
      frontmatter: { ingested_at: '2026-01-05T10:00:00.000Z' },
    } as unknown as Page, ['alpha']);
    writeFileSync(page, content);
    for (let i = 0; i < 3; i++) {
      const result = await runLintCore({ target: dir, fix: true, contentSanity: SANITY_OFF as never });
      expect(result.total_fixed).toBe(0);
      expect(result.total_fixable).toBe(0);
      expect(readFileSync(page, 'utf-8')).toBe(content);
    }
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
      '---\ntitle: B\ntype: note\ncaptured_at: 2026-01-05\n---\n\nOf course. Here is the page.\n\n# B\n\nBody.\n',
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
