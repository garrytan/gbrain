import { describe, test, expect } from 'bun:test';
import { lintContent, fixContent } from '../src/commands/lint.ts';

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
