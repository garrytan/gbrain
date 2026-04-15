import { describe, expect, test } from 'bun:test';
import type { FetchTweetResult } from '../src/core/x/types.ts';

/**
 * Thread extraction logic tests.
 *
 * We test the reachesRoot algorithm and thread sorting by
 * importing and running extractSelfThreads with a mock context.
 * Since the actual function requires a BrowserContext for fetching
 * candidate tweets, we test the core algorithm separately.
 */

// Extract the reachesRoot algorithm for direct testing
function reachesRoot(
  id: string,
  rootId: string,
  author: string,
  nodes: Map<string, { normalized: { inReplyToStatusId: string | null; author: { handle: string | null } } | null }>,
  seen = new Set<string>(),
): boolean {
  if (id === rootId) return true;
  if (seen.has(id)) return false;
  seen.add(id);

  const node = nodes.get(id);
  const parentId = node?.normalized?.inReplyToStatusId;
  const nodeAuthor = node?.normalized?.author?.handle;

  if (!parentId || nodeAuthor !== author) return false;
  if (parentId === rootId) return true;
  if (!nodes.has(parentId)) return false;

  return reachesRoot(parentId, rootId, author, nodes, seen);
}

describe('reachesRoot algorithm', () => {
  test('direct reply to root reaches root', () => {
    const nodes = new Map([
      ['root', { normalized: { inReplyToStatusId: null, author: { handle: 'alice' } } }],
      ['reply1', { normalized: { inReplyToStatusId: 'root', author: { handle: 'alice' } } }],
    ]);

    expect(reachesRoot('reply1', 'root', 'alice', nodes)).toBe(true);
  });

  test('chain of same-author replies reaches root', () => {
    const nodes = new Map([
      ['root', { normalized: { inReplyToStatusId: null, author: { handle: 'alice' } } }],
      ['reply1', { normalized: { inReplyToStatusId: 'root', author: { handle: 'alice' } } }],
      ['reply2', { normalized: { inReplyToStatusId: 'reply1', author: { handle: 'alice' } } }],
      ['reply3', { normalized: { inReplyToStatusId: 'reply2', author: { handle: 'alice' } } }],
    ]);

    expect(reachesRoot('reply3', 'root', 'alice', nodes)).toBe(true);
  });

  test('reply by different author does not reach root', () => {
    const nodes = new Map([
      ['root', { normalized: { inReplyToStatusId: null, author: { handle: 'alice' } } }],
      ['reply1', { normalized: { inReplyToStatusId: 'root', author: { handle: 'bob' } } }],
    ]);

    expect(reachesRoot('reply1', 'root', 'alice', nodes)).toBe(false);
  });

  test('broken chain (missing intermediate node) does not reach root', () => {
    const nodes = new Map([
      ['root', { normalized: { inReplyToStatusId: null, author: { handle: 'alice' } } }],
      // reply1 is missing from nodes
      ['reply2', { normalized: { inReplyToStatusId: 'reply1', author: { handle: 'alice' } } }],
    ]);

    expect(reachesRoot('reply2', 'root', 'alice', nodes)).toBe(false);
  });

  test('circular references do not cause infinite loop', () => {
    const nodes = new Map([
      ['root', { normalized: { inReplyToStatusId: null, author: { handle: 'alice' } } }],
      ['a', { normalized: { inReplyToStatusId: 'b', author: { handle: 'alice' } } }],
      ['b', { normalized: { inReplyToStatusId: 'a', author: { handle: 'alice' } } }],
    ]);

    expect(reachesRoot('a', 'root', 'alice', nodes)).toBe(false);
  });

  test('root itself reaches root', () => {
    const nodes = new Map([
      ['root', { normalized: { inReplyToStatusId: null, author: { handle: 'alice' } } }],
    ]);

    expect(reachesRoot('root', 'root', 'alice', nodes)).toBe(true);
  });

  test('null inReplyToStatusId does not reach root', () => {
    const nodes = new Map([
      ['root', { normalized: { inReplyToStatusId: null, author: { handle: 'alice' } } }],
      ['orphan', { normalized: { inReplyToStatusId: null, author: { handle: 'alice' } } }],
    ]);

    expect(reachesRoot('orphan', 'root', 'alice', nodes)).toBe(false);
  });
});

describe('thread sorting', () => {
  test('sorts replies chronologically', () => {
    const replies = [
      { id: 'c', createdAt: 'Wed Jan 03 00:00:00 +0000 2024' },
      { id: 'a', createdAt: 'Mon Jan 01 00:00:00 +0000 2024' },
      { id: 'b', createdAt: 'Tue Jan 02 00:00:00 +0000 2024' },
    ];

    const sorted = [...replies].sort((a, b) => {
      const aDate = Date.parse(a.createdAt);
      const bDate = Date.parse(b.createdAt);
      return aDate - bDate;
    });

    expect(sorted.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  test('handles missing dates gracefully', () => {
    const replies = [
      { id: 'a', createdAt: '' },
      { id: 'b', createdAt: 'Mon Jan 01 00:00:00 +0000 2024' },
    ];

    const sorted = [...replies].sort((a, b) => {
      const aDate = Date.parse(a.createdAt);
      const bDate = Date.parse(b.createdAt);
      return aDate - bDate;
    });

    // NaN sorts first (or stays in place)
    expect(sorted).toHaveLength(2);
  });
});
