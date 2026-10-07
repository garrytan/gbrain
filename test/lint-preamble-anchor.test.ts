/**
 * `llm-preamble` is anchored to the start of the page body, and a `lint --fix`
 * write the file refuses (EACCES/EPERM/EROFS) is contained per file.
 *
 * Protects: `lint --fix` (and the cycle's lint phase) never deletes a real
 * line further down a page that merely begins "Sure! Here is...", and one
 * read-only page cannot fail the run or stop later pages from being fixed.
 * Fails when the preamble patterns match at every line start again, or the
 * write error propagates. Existing lint tests only cover a preamble at the top.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fixContent, lintContent, runLintCore } from '../src/commands/lint.ts';
import { runPhaseLint } from '../src/core/cycle.ts';
import { permsEnforced } from './helpers/fs-perms.ts';

const FM = '---\ntitle: Notes\ntype: note\ncreated: 2026-04-11\n---\n\n';

function preambleIssues(content: string) {
  return lintContent(content, 'p.md').filter(i => i.rule === 'llm-preamble');
}

describe('llm-preamble is anchored to the start of the page body', () => {
  test('a mid-document line that starts like a preamble is neither flagged nor changed', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Line ${i}.`).join('\n');
    for (const line of [
      "Absolutely. Here's the clean version I'd propose.",
      'Sure! Here are the three options we discussed.',
      'Certainly. Here is what changed.',
    ]) {
      const content = `${FM}# Notes\n\n${filler}\n${line}\n${filler}\n`;
      expect(preambleIssues(content)).toHaveLength(0);
      expect(fixContent(content)).toBe(content);
    }
  });

  test('a preamble right after frontmatter is flagged at its own line and only it is stripped', () => {
    const content = `${FM}Of course. Here is the page for alice-example.\n\n# Alice\n\nSure! Here are her notes.\n`;
    const issues = preambleIssues(content);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBe(7);
    const fixed = fixContent(content);
    expect(fixed).not.toContain('Of course');
    expect(fixed).toContain('Sure! Here are her notes.');
    expect(fixed.startsWith(FM)).toBe(true);
  });

  test('leading blank lines, a preamble above the frontmatter and a ```markdown wrapper are still body starts', () => {
    const blank = '\n\nSure! Here is the page.\n# T\n\nBody.\n';
    expect(preambleIssues(blank).map(i => i.line)).toEqual([3]);
    expect(fixContent(blank)).not.toContain('Sure!');
    const above = `Certainly. Here is the brain page.\n\n${FM}# Page\n\nBody.\n`;
    expect(preambleIssues(above)).toHaveLength(1);
    expect(fixContent(above).startsWith('---\n')).toBe(true);
    const wrapped = '```markdown\nSure! Here is the page.\n# T\n\nBody.\n```';
    expect(preambleIssues(wrapped)).toHaveLength(1);
    expect(fixContent(wrapped)).not.toContain('Sure!');
  });

  test('CRLF frontmatter anchors the body start', () => {
    const content = '---\r\ntitle: Notes\r\n---\r\nSure! Here is the page.\r\n# T\r\n\r\nSure! Here are the notes.\r\n';
    expect(preambleIssues(content)).toHaveLength(1);
    const fixed = fixContent(content);
    expect(fixed).toContain('Sure! Here are the notes.');
    expect(fixed).not.toContain('Sure! Here is the page.');
  });

  test('stacked leading preambles are all stripped', () => {
    expect(fixContent('Sure! Here is the page.\nCertainly. Here is the brain page.\n\n# Title\n\nContent.')).toBe('# Title\n\nContent.\n');
  });
});

describe('lint --fix contains a page it cannot write', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) {
      try { chmodSync(join(r, 'readonly.md'), 0o644); } catch { /* absent */ }
      rmSync(r, { recursive: true, force: true });
    }
  });

  function brainWithReadOnlyPage(): string {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-lint-ro-'));
    roots.push(root);
    writeFileSync(join(root, 'readonly.md'), `${FM}Of course. Here is the brain page.\n\n# RO\n\nBody.\n`);
    chmodSync(join(root, 'readonly.md'), 0o444);
    writeFileSync(join(root, 'writable.md'), `${FM}Of course. Here is the brain page.\n\n# RW\n\nBody.\n`);
    return root;
  }

  test.skipIf(!permsEnforced())('the read-only page is reported with its code, reason and fix; the later page is still fixed', async () => {
    const root = brainWithReadOnlyPage();
    const result = await runLintCore({ target: root, fix: true, contentSanity: {}, typePack: null });
    expect(result.total_fixed).toBe(1);
    expect(result.fix_pending).toBe(1);
    expect(result.pending_issues).toHaveLength(1);
    const issue = result.pending_issues[0]!;
    expect(issue).toMatchObject({ file: 'readonly.md', rule: 'fix-not-writable', fixable: false, code: 'fix_not_writable', reason: 'eacces' });
    expect(issue.message).toBe('fix not applied: readonly.md is not writable (EACCES); the file was left unchanged.');
    expect(issue.fix).toMatchObject({ actor: 'user', next: 'report', user_message: 'Make readonly.md writable for gbrain, or exclude it from lint.' });
    expect(issue.docs).toContain('docs/guides/repair.md#fix-not-writable');
    expect(readFileSync(join(root, 'writable.md'), 'utf8')).not.toContain('Of course');
    expect(readFileSync(join(root, 'readonly.md'), 'utf8')).toContain('Of course');
  });

  test.skipIf(!permsEnforced())('the cycle lint phase warns instead of failing and lists the pending page', async () => {
    const root = brainWithReadOnlyPage();
    const result = await runPhaseLint(root, false, null);
    expect(result.status).toBe('warn');
    expect(result.error).toBeUndefined();
    expect(result.details).toMatchObject({ fixed: 1, fix_pending: 1 });
    expect((result.details.pending as Array<{ rule: string }>)[0]!.rule).toBe('fix-not-writable');
  });
});
