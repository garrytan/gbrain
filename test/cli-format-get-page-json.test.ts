import { describe, expect, test } from 'bun:test';
import { formatResult } from '../src/cli.ts';

describe('formatResult - get_page --json', () => {
  const page = {
    slug: 'ops/tasks',
    type: 'note',
    title: 'Tasks',
    compiled_truth: '# Tasks',
    timeline: '',
    frontmatter: { status: 'active' },
    tags: [],
    content_hash: 'a'.repeat(64),
    content: '---\nstatus: active\n---\n\n# Tasks\n',
  };

  test('returns the full machine-readable page including hash and content', () => {
    expect(JSON.parse(formatResult('get_page', page, { json: true }))).toEqual(page);
  });

  test('keeps markdown as the default human output', () => {
    const output = formatResult('get_page', page, {});
    expect(output).toContain('# Tasks');
    expect(output).not.toContain('content_hash');
  });
});
