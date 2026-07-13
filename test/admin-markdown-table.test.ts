import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdownTable } from '../admin/src/lib/markdown-table.ts';

describe('Admin Markdown table preview', () => {
  test('parses a standard Markdown table into headers and rows', () => {
    const lines = [
      '| 时间 | 事件 / 阶段 | 来源 |',
      '| --- | :--- | ---: |',
      '| 2025-09 | 开始跑步 | 月记 |',
      '| 2025-11 | 热爱运动 | 日常随笔 |',
      '',
      '后续正文',
    ];
    expect(parseMarkdownTable(lines, 0)).toEqual({
      headers: ['时间', '事件 / 阶段', '来源'],
      rows: [
        ['2025-09', '开始跑步', '月记'],
        ['2025-11', '热爱运动', '日常随笔'],
      ],
      endIndex: 4,
    });
  });

  test('does not treat ordinary pipe text as a table', () => {
    expect(parseMarkdownTable(['A | B', '普通正文'], 0)).toBeNull();
  });

  test('renders parsed tables with preview styling and horizontal overflow', () => {
    const consolePage = readFileSync(join(process.cwd(), 'admin/src/pages/Console.tsx'), 'utf8');
    const styles = readFileSync(join(process.cwd(), 'admin/src/index.css'), 'utf8');
    expect(consolePage).toContain('className="markdown-table-wrap"');
    expect(styles).toContain('.docs-markdown .markdown-table-wrap');
    expect(styles).toContain('overflow-x: auto');
    expect(consolePage).toContain('<table className="brain-page-table">');
    expect(styles).not.toContain('.brain-data-page table th:nth-child(n+2)');
  });
});
