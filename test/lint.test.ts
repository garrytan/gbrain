import { afterEach, describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { lintContent, fixContent, runLint } from '../src/commands/lint.ts';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-lint-test-'));
  tempDirs.push(dir);
  return dir;
}

function captureConsoleLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('lintContent', () => {
  test('detects LLM preamble "Of course"', () => {
    const content = 'Of course. Here is a detailed brain page for Jane Doe.\n\n# Jane Doe\n\nContent.';
    const issues = lintContent(content, 'test.md');
    expect(issues.some(i => i.rule === 'llm-preamble')).toBe(true);
  });

  test('detects LLM preamble "I\'ve created"', () => {
    const content = "I've created a comprehensive brain page for the company.\n\n# Acme\n\nContent.";
    const issues = lintContent(content, 'test.md');
    expect(issues.some(i => i.rule === 'llm-preamble')).toBe(true);
  });

  test('detects LLM preamble "Certainly"', () => {
    const content = 'Certainly. Here is the brain page.\n\n# Page\n\nContent.';
    const issues = lintContent(content, 'test.md');
    expect(issues.some(i => i.rule === 'llm-preamble')).toBe(true);
  });

  test('no false positive on normal content', () => {
    const content = '---\ntitle: Test\ntype: person\ncreated: 2026-04-11\n---\n\n# Test\n\nNormal content.';
    const issues = lintContent(content, 'test.md');
    expect(issues.filter(i => i.rule === 'llm-preamble')).toHaveLength(0);
  });

  test('detects wrapping code fences', () => {
    const content = '```markdown\n---\ntitle: Test\n---\n\n# Test\n\nContent.\n```';
    const issues = lintContent(content, 'test.md');
    expect(issues.some(i => i.rule === 'code-fence-wrap')).toBe(true);
  });

  test('detects placeholder dates', () => {
    const content = '---\ntitle: Test\ntype: person\ncreated: YYYY-MM-DD\n---\n\n# Test';
    const issues = lintContent(content, 'test.md');
    expect(issues.some(i => i.rule === 'placeholder-date')).toBe(true);
  });

  test('detects XX-XX placeholder dates', () => {
    const content = '---\ntitle: Test\ntype: person\ncreated: 2026-04-11\n---\n\n# Test\n\n- 2026-XX-XX | Something happened';
    const issues = lintContent(content, 'test.md');
    expect(issues.some(i => i.rule === 'placeholder-date')).toBe(true);
  });

  test('detects missing frontmatter title', () => {
    const content = '---\ntype: person\ncreated: 2026-04-11\n---\n\n# Test';
    const issues = lintContent(content, 'test.md');
    expect(issues.some(i => i.rule === 'missing-title')).toBe(true);
  });

  test('detects missing frontmatter type', () => {
    const content = '---\ntitle: Test\ncreated: 2026-04-11\n---\n\n# Test';
    const issues = lintContent(content, 'test.md');
    expect(issues.some(i => i.rule === 'missing-type')).toBe(true);
  });

  test('detects no frontmatter at all', () => {
    const content = '# Test\n\nContent without frontmatter.';
    const issues = lintContent(content, 'test.md');
    expect(issues.some(i => i.rule === 'no-frontmatter')).toBe(true);
  });

  test('detects empty sections', () => {
    const content = '---\ntitle: Test\ntype: person\ncreated: 2026-04-11\n---\n\n# Test\n\n## What They Believe\n\n[No data yet]\n\n## State\n\nReal content here.';
    const issues = lintContent(content, 'test.md');
    expect(issues.some(i => i.rule === 'empty-section' && i.message.includes('What They Believe'))).toBe(true);
  });

  test('detects agent placeholder sections', () => {
    const content = '---\ntitle: Test\ntype: person\ncreated: 2026-04-11\n---\n\n# Test\n\n## Summary\n\n*[To be filled by agent]*\n\n## State\n\nContent.';
    const issues = lintContent(content, 'test.md');
    expect(issues.some(i => i.rule === 'empty-section' && i.message.includes('Summary'))).toBe(true);
  });

  test('clean page has no issues', () => {
    const content = '---\ntitle: Jane Doe\ntype: person\ncreated: 2026-04-11\n---\n\n# Jane Doe\n\n## State\n\nCTO of Acme Corp.\n\n## Timeline\n\n- **2026-04-11** | Met at event [Source: User]';
    const issues = lintContent(content, 'test.md');
    expect(issues).toHaveLength(0);
  });

  test('detects dangling superseded_by targets when a slug set is available', () => {
    const content = [
      '---',
      'title: Old Memory',
      'type: concept',
      'created: 2026-04-11',
      'superseded_by: concepts/new-memory',
      '---',
      '',
      '# Old Memory',
      '',
      'Content.',
    ].join('\n');
    const issues = lintContent(content, 'concepts/old-memory.md', 'concepts/old-memory.md', new Set([
      'concepts/old-memory',
    ]));

    expect(issues.some(i => i.rule === 'broken-superseded-by')).toBe(true);
  });

  test('accepts existing superseded_by targets when a slug set is available', () => {
    const content = [
      '---',
      'title: Old Memory',
      'type: concept',
      'created: 2026-04-11',
      'superseded_by: concepts/new-memory.md',
      '---',
      '',
      '# Old Memory',
      '',
      'Content.',
    ].join('\n');
    const issues = lintContent(content, 'concepts/old-memory.md', 'concepts/old-memory.md', new Set([
      'concepts/old-memory',
      'concepts/new-memory',
    ]));

    expect(issues.some(i => i.rule === 'broken-superseded-by')).toBe(false);
  });

  test('detects vague durable page slugs', () => {
    const content = '---\ntitle: Readme\ntype: concept\ncreated: 2026-04-25\n---\n\n# Readme\n\nContent.';
    const issues = lintContent(content, 'readme.md');
    expect(issues.some(i => i.rule === 'vague-slug')).toBe(true);
    expect(issues.find(i => i.rule === 'vague-slug')?.line).toBe(1);
  });

  test('does not apply durable slug diagnostics to README resolver files', () => {
    const content = '---\ntitle: Readme\ntype: concept\ncreated: 2026-04-25\n---\n\n# Readme\n\nContent.';
    const issues = lintContent(content, 'README.md');
    expect(issues.some(i => i.rule === 'vague-slug')).toBe(false);
  });

  test('detects global documentation bucket numeric slugs', () => {
    const content = '---\ntitle: 17\ntype: concept\ncreated: 2026-04-25\n---\n\n# 17\n\nContent.';
    const issues = lintContent(content, 'docs/reference/17.md');
    expect(issues.some(i => i.rule === 'global-docs-bucket')).toBe(true);
    expect(issues.some(i => i.rule === 'numeric-only-slug')).toBe(true);
  });

  test('detects global documentation bucket paths when linting an absolute file path', () => {
    const content = '---\ntitle: 17\ntype: concept\ncreated: 2026-04-25\n---\n\n# 17\n\nContent.';
    const issues = lintContent(content, '/tmp/brain/docs/archive/17.md');
    expect(issues.some(i => i.rule === 'global-docs-bucket')).toBe(true);
    expect(issues.some(i => i.rule === 'numeric-only-slug')).toBe(true);
  });

  test('detects numeric-only slugs outside global documentation bucket paths', () => {
    const content = '---\ntitle: 123\ntype: concept\ncreated: 2026-04-25\n---\n\n# 123\n\nContent.';
    const issues = lintContent(content, 'projects/mbrain/docs/123.md');
    expect(issues.some(i => i.rule === 'numeric-only-slug')).toBe(true);
    expect(issues.some(i => i.rule === 'global-docs-bucket')).toBe(false);
  });

  test('accepts project-scoped descriptive doc slugs', () => {
    const content = [
      '---',
      'title: Sync Pipeline',
      'type: concept',
      'created: 2026-04-25',
      '---',
      '',
      '# Sync Pipeline',
      '',
      'Content.',
    ].join('\n');
    const issues = lintContent(content, 'projects/mbrain/docs/manual/06-sync-pipeline.md');
    expect(issues.filter(i => ['vague-slug', 'global-docs-bucket', 'numeric-only-slug'].includes(i.rule))).toEqual([]);
  });
});

describe('fixContent', () => {
  test('removes LLM preamble', () => {
    const input = 'Of course. Here is a detailed brain page for Jane.\n\n# Jane Doe\n\nContent.';
    const fixed = fixContent(input);
    expect(fixed).not.toContain('Of course');
    expect(fixed).toContain('# Jane Doe');
    expect(fixed).toContain('Content.');
  });

  test('removes wrapping code fences', () => {
    const input = '```markdown\n# Title\n\nContent.\n```';
    const fixed = fixContent(input);
    expect(fixed).not.toContain('```');
    expect(fixed).toContain('# Title');
  });

  test('cleans up excessive blank lines after fix', () => {
    const input = 'Of course. Here is the brain page.\n\n\n\n# Title\n\nContent.';
    const fixed = fixContent(input);
    expect(fixed).not.toMatch(/\n{3,}/);
  });

  test('preserves content that needs no fixing', () => {
    const input = '# Normal Title\n\nNormal content.\n';
    expect(fixContent(input)).toBe(input);
  });

  test('handles multiple preambles', () => {
    const input = 'Sure! Here is the page.\nCertainly. Here is the brain page.\n\n# Title\n\nContent.';
    const fixed = fixContent(input);
    expect(fixed).not.toContain('Sure');
    expect(fixed).not.toContain('Certainly');
    expect(fixed).toContain('# Title');
  });
});

describe('runLint', () => {
  test('keeps project namespace when linting a project subtree', async () => {
    const root = createTempDir();
    const pageDir = join(root, 'projects/mbrain/docs/manual');
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, '06-sync-pipeline.md'), [
      '---',
      'title: Sync Pipeline',
      'type: concept',
      'created: 2026-04-25',
      '---',
      '',
      '# Sync Pipeline',
      '',
      'Content.',
    ].join('\n'));

    const captured = captureConsoleLog();
    try {
      await runLint([join(root, 'projects/mbrain')]);
    } finally {
      captured.restore();
    }

    expect(captured.lines.join('\n')).not.toContain('global-docs-bucket');
  });

  test('keeps global docs namespace when linting a docs subtree', async () => {
    const root = createTempDir();
    const pageDir = join(root, 'docs/archive');
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, 'sync-pipeline.md'), [
      '---',
      'title: Sync Pipeline',
      'type: concept',
      'created: 2026-04-25',
      '---',
      '',
      '# Sync Pipeline',
      '',
      'Content.',
    ].join('\n'));

    const captured = captureConsoleLog();
    try {
      await runLint([join(root, 'docs')]);
    } finally {
      captured.restore();
    }

    expect(captured.lines.join('\n')).toContain('global-docs-bucket');
  });
});
