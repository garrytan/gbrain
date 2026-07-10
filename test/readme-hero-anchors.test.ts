/**
 * v0.36.0.0 (D9) — README hero anchor regression test.
 *
 * Pins load-bearing strings in the first ~50 lines of README.md so future
 * "cleanup" PRs can't silently drop the headline framing or the
 * PMBrain positioning and upstream credit. The anchors are intentionally
 * NARROW (substrings,
 * not full hero text) so legitimate voice/structure edits don't fight the
 * test.
 *
 * If this test fails, ask: did we deliberately rotate the headline?
 *   - If yes: update the anchors here AND in the corresponding plan/spec.
 *   - If no: the README rewrite dropped something it shouldn't have.
 *
 * PMBrain intentionally replaces the upstream marketing hero with a Chinese,
 * local-first project-management introduction. These checks pin that product
 * contract rather than upstream-only platform names and benchmark numbers.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('README hero anchors (D9 regression guard)', () => {
  const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
  // First 50 lines is enough headroom for hero + first sub-section.
  const hero = readme.split('\n').slice(0, 50).join('\n');

  test('leads with the PMBrain product name and category', () => {
    expect(hero).toContain('PMBrain');
    expect(hero).toContain('项目管理知识大脑');
  });

  test('credits the GBrain upstream project', () => {
    expect(hero).toContain('基于 GBrain');
  });

  test('keeps the local-first positioning', () => {
    expect(hero).toContain('纯本地');
    expect(hero).toContain('数据本地化');
  });

  test('names the hybrid search and knowledge graph capabilities', () => {
    expect(hero).toContain('混合搜索引擎');
    expect(hero).toContain('知识图谱');
  });

  test('shows the direct office-document import promise', () => {
    expect(hero).toContain('导入即用，无需转换格式');
    expect(hero).toContain('.docx');
    expect(hero).toContain('.pdf');
  });
});
