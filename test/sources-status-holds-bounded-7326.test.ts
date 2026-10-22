import { describe, expect, test } from 'bun:test';
import { gitHoldStatusJson, HELD_STATUS_LIMIT, type GitHoldStatus } from '../src/core/persistence/connector-status.ts';
import type { GitHoldItem } from '../src/core/persistence/sync-holds.ts';

const item = (i: number, code: string): GitHoldItem => ({
  path: `notes/file-${String(i).padStart(4, '0')}.md`, code: code as GitHoldItem['code'], message: 'held: a location-only message '.repeat(20),
  slug: null, stale: false, held_since: '2026-01-01T00:00:00Z', docs: 'docs/guides/write-refusals.md',
  fix: { argv: ['gbrain', 'repair', 'frontmatter', '--source', 'source-a'], why: 'Previews the repair; read-only. '.repeat(10) } as unknown as GitHoldItem['fix'],
});

const holds = (n: number): GitHoldStatus => ({
  count: n,
  items: Array.from({ length: n }, (_, i) => item(n - i, i % 3 === 0 ? 'invalid_fence' : 'invalid_frontmatter')),
  sync_argv: ['gbrain', 'sync', '--source', 'source-a', '--no-pull'],
});

describe('#7326: sources status --json bounds git_holds', () => {
  test('the default lists counts per code with one example and at most HELD_STATUS_LIMIT items', () => {
    const out = gitHoldStatusJson('source-a', holds(500), { mode: 'summary' });
    expect(out.count).toBe(500);
    expect(out.items).toHaveLength(HELD_STATUS_LIMIT);
    expect(out).toMatchObject({ items_complete: false, items_command: ['gbrain', 'sources', 'status', 'source-a', '--json', '--holds'] });
    expect(out.by_code.map(g => [g.code, g.count])).toEqual([['invalid_frontmatter', 333], ['invalid_fence', 167]]);
    expect(out.by_code[0]!.example.fix).toBeDefined();
    expect(Object.keys(out).at(-1)).toBe('items');
    const full = JSON.stringify(gitHoldStatusJson('source-a', holds(500), { mode: 'all' }));
    expect(JSON.stringify(out).length).toBeLessThan(full.length / 10);
  });

  test('a source with few holds keeps every item and no paging fields', () => {
    const out = gitHoldStatusJson('source-a', holds(3), { mode: 'summary' });
    expect(out.items).toHaveLength(3);
    expect(out).not.toHaveProperty('items_complete');
    expect(out).not.toHaveProperty('items_command');
  });

  test('--holds lists every item read', () => {
    expect(gitHoldStatusJson('source-a', holds(500), { mode: 'all' }).items).toHaveLength(500);
  });

  test('--limit / --cursor page the items by path without skipping or repeating', () => {
    const status = holds(25);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = gitHoldStatusJson('source-a', status, { mode: 'page', request: { limit: 10, ...(cursor ? { cursor } : {}) } }) as ReturnType<typeof gitHoldStatusJson> & { next_cursor: string | null; next_command: string[] | null };
      seen.push(...page.items.map(i => i.path));
      if (!page.next_cursor) break;
      expect(page.next_command).toEqual(['gbrain', 'sources', 'status', 'source-a', '--json', '--limit', '10', '--cursor', page.next_cursor]);
      cursor = page.next_cursor;
    }
    expect(seen).toEqual(status.items.map(i => i.path).sort());
    expect(() => gitHoldStatusJson('source-b', status, { mode: 'page', request: { limit: 10, cursor } })).toThrow();
  });
});
