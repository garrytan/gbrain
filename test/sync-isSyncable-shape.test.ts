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
  isPoisonedPath,
  unsyncableReason,
  sanitizePathForDisplay,
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
    { path: 'RESOLVER.md', expected: 'metafile', note: 'top-level master routing config (closes #345)' },
    { path: 'brain/RESOLVER.md', expected: 'metafile', note: 'RESOLVER.md anywhere is metafile (closes #345)' },
    { path: 'people/alice.txt', expected: 'strategy', note: '.txt rejected by markdown strategy' },
    { path: 'ops/scratch/note.md', expected: null, note: 'ops/ is ordinary content, not pruned (#2404)' },
    { path: 'vendor/pkg/note.md', expected: 'pruned-dir', note: 'vendor/ is pruned' },
    { path: '.git/notes.md', expected: 'pruned-dir', note: 'hidden dir pruned' },
    { path: 'node_modules/foo/README.md', expected: 'pruned-dir', note: 'node_modules pruned' },
    // Poisoned-path incident class: markdown-link syntax as a literal filename.
    { path: '[atoms/foo.md](https:/example).md', expected: 'malformed-path', note: 'markdown-link-shaped junk filename rejected' },
    { path: 'notes/[wip] draft.md', expected: 'malformed-path', note: 'bare bracket in MARKDOWN filename rejected' },
    { path: 'notes/bell' + '\x07' + '.md', expected: 'malformed-path', note: 'control character in filename rejected' },
    { path: 'docs/[locale]/guide.md', expected: 'malformed-path', note: 'bracket DIRECTORY segment above a markdown file rejected' },
    { path: 'notes/meeting (1).md', expected: null, note: 'parens are legitimate filename characters — deliberately allowed' },
    { path: 'people/alice.txt](x', expected: 'strategy', note: 'strategy check wins before malformed-path (classifier ordering keeps reconcile strategy-safe)' },
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

  test('SYNC_SKIP_FILES export contains the canonical structural metafiles', () => {
    expect([...SYNC_SKIP_FILES]).toEqual(['schema.md', 'index.md', 'log.md', 'README.md', 'RESOLVER.md']);
  });

  test('isSyncable(p) === (unsyncableReason(p) === null) — duality holds for all canonical cases', () => {
    for (const c of cases) {
      expect(isSyncable(c.path)).toBe(unsyncableReason(c.path) === null);
    }
  });

  test('brackets are markdown-scoped: code-strategy framework paths stay syncable', () => {
    // Cross-model adversarial finding: a blanket bracket rejection would have
    // rejected ubiquitous Next.js/Nuxt dynamic-route layouts in code lanes
    // AND reconcile-deleted their previously indexed rows.
    expect(unsyncableReason('app/[id]/page.tsx', { strategy: 'code' })).toBeNull();
    expect(unsyncableReason('app/[...slug]/route.ts', { strategy: 'code' })).toBeNull();
    // Same path under the default markdown strategy is a STRATEGY rejection
    // (ordering: strategy classifies first), never malformed-path.
    expect(unsyncableReason('app/[id]/page.tsx')).toBe('strategy');
    // A markdown file under a bracket dir is malformed even in code/auto lanes.
    expect(unsyncableReason('app/[id]/README.md', { strategy: 'auto' })).toBe('malformed-path');
  });

  test('isPoisonedPath: only the injection signature is sweepable', () => {
    expect(isPoisonedPath('[atoms/foo.md](https:/example).md')).toBe(true); // `](`
    expect(isPoisonedPath('notes/bell' + '\x07' + '.md')).toBe(true); // control char
    expect(isPoisonedPath('notes [draft].md')).toBe(false); // bare brackets: rows survive
    expect(isPoisonedPath('docs/[locale]/guide.md')).toBe(false);
  });

  test('sanitizePathForDisplay: control bytes → U+FFFD, DEL included, brackets kept, 200-char cap', () => {
    expect(sanitizePathForDisplay('notes/bell' + '\x07' + '.md')).toBe('notes/bell�.md');
    expect(sanitizePathForDisplay('esc' + '\x1b' + '[31mred')).toBe('esc�[31mred'); // ANSI CSI neutered
    expect(sanitizePathForDisplay('del' + '\x7f' + '.md')).toBe('del�.md');
    expect(sanitizePathForDisplay('[foo.md](https-example).md')).toBe('[foo.md](https-example).md');
    const long = 'a'.repeat(250);
    const capped = sanitizePathForDisplay(long);
    expect(capped.length).toBe(200);
    expect(capped.endsWith('...')).toBe(true);
  });
});
