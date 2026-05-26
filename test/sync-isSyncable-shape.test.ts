/**
 * v0.41.13 (#1433) — isSyncable / unsyncableReason classifier shape.
 *
 * The two public APIs route through the same internal `classifySync`
 * helper so they cannot drift. These tests pin the contract that
 * `isSyncable` returns true iff `unsyncableReason` returns null, AND
 * pin the canonical SYNC_SKIP_FILES list (since the cleanup-loop guard
 * at commands/sync.ts:772 keys on `unsyncableReason === 'metafile'`).
 */

import { describe, test, expect } from 'bun:test';
import {
  isSyncable,
  unsyncableReason,
  SYNC_SKIP_FILES,
  type SyncableReason,
} from '../src/core/sync.ts';

describe('#1433 — isSyncable / unsyncableReason are duals of one classifier', () => {
  const cases: Array<{ path: string; expected: SyncableReason | null; note: string }> = [
    { path: 'people/alice.md', expected: null, note: 'normal markdown page' },
    { path: 'docs/guide.mdx', expected: null, note: 'mdx accepted by markdown strategy' },
    { path: 'learning-and-strategy/log.md', expected: 'metafile', note: 'log.md anywhere is metafile' },
    { path: 'wiki/schema.md', expected: 'metafile', note: 'schema.md anywhere is metafile' },
    { path: 'index.md', expected: 'metafile', note: 'top-level index.md' },
    { path: 'README.md', expected: 'metafile', note: 'top-level README' },
    { path: 'docs/README.md', expected: 'metafile', note: 'nested README' },
    { path: 'people/alice.txt', expected: 'strategy', note: '.txt rejected by markdown strategy' },
    { path: 'ops/scratch/note.md', expected: 'pruned-dir', note: 'ops/ is pruned' },
    { path: '.git/notes.md', expected: 'pruned-dir', note: 'hidden dir pruned' },
    { path: 'node_modules/foo/README.md', expected: 'pruned-dir', note: 'node_modules pruned' },
  ];

  for (const c of cases) {
    test(`${c.path} → ${c.expected ?? 'syncable'} (${c.note})`, () => {
      const reason = unsyncableReason(c.path);
      const sync = isSyncable(c.path);
      expect(reason).toBe(c.expected);
      expect(sync).toBe(c.expected === null);
    });
  }

  test('include glob: path not matching include returns include-glob-miss', () => {
    expect(unsyncableReason('docs/guide.md', { include: ['people/**'] })).toBe('include-glob-miss');
    expect(isSyncable('docs/guide.md', { include: ['people/**'] })).toBe(false);
  });

  test('exclude glob: matching path returns exclude-glob-hit', () => {
    expect(unsyncableReason('drafts/wip.md', { exclude: ['drafts/**'] })).toBe('exclude-glob-hit');
    expect(isSyncable('drafts/wip.md', { exclude: ['drafts/**'] })).toBe(false);
  });

  test('SYNC_SKIP_FILES export contains the canonical four basenames', () => {
    expect([...SYNC_SKIP_FILES]).toEqual(['schema.md', 'index.md', 'log.md', 'README.md']);
  });

  test('isSyncable(p) === (unsyncableReason(p) === null) — duality holds for all canonical cases', () => {
    for (const c of cases) {
      expect(isSyncable(c.path)).toBe(unsyncableReason(c.path) === null);
    }
  });
});
