/**
 * #9945: the page a first remember creates for a member or the shared scope carries the request's capture date,
 * so a content lint finds temporal provenance. Fails when the generated frontmatter has no captured_at.
 */
import { describe, expect, test } from 'bun:test';
import { lintContent } from '../src/commands/lint.ts';
import { memberPageFrontmatter, scopePageFrontmatter } from '../src/core/access/member-facts.ts';

const AT = '2026-05-01T12:00:00.000Z';
const body = '# Memory\n\n## Facts\n\n';
const missing = (c: string) => lintContent(c, 'p.md').filter(i => i.rule === 'missing-created');

describe('first memory page capture date (#9945)', () => {
  test('member page frontmatter passes missing-created and keeps its reader', () => {
    const c = memberPageFrontmatter('alice', AT) + body;
    expect(missing(c)).toEqual([]);
    expect(c).toContain(`captured_at: ${AT}`);
    expect(c).toContain('  - member:alice');
  });
  test('scope page frontmatter passes missing-created and names no readers', () => {
    const c = scopePageFrontmatter(AT) + body;
    expect(missing(c)).toEqual([]);
    expect(c).not.toContain('readable_by');
  });
});
