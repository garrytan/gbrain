import { afterEach, describe, expect, test } from 'bun:test';
import { gitHoldStatusJson } from '../src/core/persistence/connector-status.ts';
import { gitHoldFix, type GitHoldItem } from '../src/core/persistence/sync-holds.ts';
import { __resetCliRoutingForTests, installCliRouting } from '../src/core/fix-routing.ts';

afterEach(() => __resetCliRoutingForTests());

const hold = { source_id: 'source-a', path: 'notes/alice-example.md', code: 'concurrent_write' as const, slug: 'notes/alice-example', meta: {} };
const item: GitHoldItem = {
  path: hold.path, code: hold.code, message: 'held', slug: hold.slug, stale: true, held_since: '2026-01-01T00:00:00Z',
  docs: 'docs/guides/write-refusals.md', fix: gitHoldFix(hold as Parameters<typeof gitHoldFix>[0]),
};

describe('#9319: sources status --json renders hold fixes with the routing pin', () => {
  test('a concurrent_write fix names the brain the status call read, in items and by_code', () => {
    installCliRouting(() => ({ brain: 'host' }));
    const out = gitHoldStatusJson('source-a', { count: 1, items: [item], sync_argv: ['gbrain', 'sync', '--source', 'source-a', '--no-pull'] }, { mode: 'summary' });
    const pinned = ['gbrain', 'sources', 'reconcile', 'source-a', 'notes/alice-example', '--preview', '--brain', 'host'];
    expect(out.items[0]!.fix.argv).toEqual(pinned);
    expect(out.by_code[0]!.example.fix.argv).toEqual(pinned);
  });
});
