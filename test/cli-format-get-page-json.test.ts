import { describe, expect, test } from 'bun:test';
import { formatResult } from '../src/cli.ts';

/**
 * `gbrain get <slug> --json` accepted `--json` and silently printed the
 * markdown serialization anyway (same class as the get_versions fix).
 */
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

  test('--json on an ambiguous slug emits the error envelope, not human text', () => {
    const r = { error: 'ambiguous_slug', candidates: ['alice-example', 'alice-example-2'] };
    expect(JSON.parse(formatResult('get_page', r, { json: true }))).toEqual(r);
  });

  test('keeps markdown as the default human output', () => {
    const output = formatResult('get_page', page, {});
    expect(output).toContain('# Tasks');
    expect(output).not.toContain('content_hash');
  });

  test('--json=false stays on the human path', () => {
    expect(() => JSON.parse(formatResult('get_page', page, { json: false }))).toThrow();
  });
});
