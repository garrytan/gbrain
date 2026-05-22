import { describe, expect, test } from 'bun:test';
import { lintContent } from '../src/commands/lint.ts';

const fence = '---';

describe('lintContent: frontmatter validation rules (B2)', () => {
  test('frontmatter-missing-close fires when heading inside YAML zone', () => {
    const md = `${fence}\ntype: concept\ntitle: ok\n# A heading\n\nbody`;
    const issues = lintContent(md, 'pages/test.md');
    expect(issues.some(i => i.rule === 'frontmatter-missing-close')).toBe(true);
  });

  test('frontmatter-missing-close fires when no closing --- and no heading', () => {
    const md = `${fence}\ntype: concept\ntitle: ok\nstray`;
    const issues = lintContent(md, 'pages/test.md');
    expect(issues.some(i => i.rule === 'frontmatter-missing-close')).toBe(true);
  });

  test('frontmatter-nested-quotes fires on title with 3+ unescaped quotes', () => {
    const md = `${fence}\ntype: concept\ntitle: "Phil "Nick" Last"\n${fence}\n\nbody`;
    const issues = lintContent(md, 'pages/test.md');
    expect(issues.some(i => i.rule === 'frontmatter-nested-quotes')).toBe(true);
  });

  test('frontmatter-null-bytes fires on null byte', () => {
    const md = `${fence}\ntype: concept\ntitle: ok\n${fence}\n\nbody\x00`;
    const issues = lintContent(md, 'pages/test.md');
    expect(issues.some(i => i.rule === 'frontmatter-null-bytes')).toBe(true);
  });

  test('frontmatter-empty fires on --- --- with nothing between', () => {
    const md = `${fence}\n${fence}\n\nbody`;
    const issues = lintContent(md, 'pages/test.md');
    expect(issues.some(i => i.rule === 'frontmatter-empty')).toBe(true);
  });

  test('does NOT double-report frontmatter-missing-open when no-frontmatter fires', () => {
    const md = '# Test\n\nContent without frontmatter.';
    const issues = lintContent(md, 'pages/test.md');
    // Legacy rule survives.
    expect(issues.some(i => i.rule === 'no-frontmatter')).toBe(true);
    // New rule for the same case is suppressed.
    expect(issues.some(i => i.rule === 'frontmatter-missing-open')).toBe(false);
  });

  test('clean page produces no frontmatter-rule issues', () => {
    const md = `${fence}\ntitle: Hello\ntype: concept\ncreated: 2026-04-25\n${fence}\n\nbody content`;
    const issues = lintContent(md, 'pages/test.md');
    const fmIssues = issues.filter(i => i.rule.startsWith('frontmatter-'));
    expect(fmIssues).toEqual([]);
  });

  test('fixable flag set correctly for fixable codes', () => {
    const md = `${fence}\ntype: concept\ntitle: "Phil "Nick" Last"\n${fence}\n\nbody`;
    const issues = lintContent(md, 'pages/test.md');
    const nq = issues.find(i => i.rule === 'frontmatter-nested-quotes');
    expect(nq?.fixable).toBe(true);
  });
});
