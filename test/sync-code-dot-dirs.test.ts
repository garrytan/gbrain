/**
 * A code source must see its dot-DIRECTORIES.
 *
 * `classifySync` ran every path segment through `pruneDir`, which refuses any
 * name starting with `.`. That rule is right for the brain repo — `.sources/`
 * is a reserved prefix that depends on it — and wrong for a code source, where
 * `.github/workflows/`, `.claude/` and `.vscode/` are versioned content. The
 * cost was not merely absence: those files ARE reachable by `git ls-files`, so
 * pages for them existed from older walks and then read as ghosts against an
 * expected-set that could not contain them. Deleting a "ghost" whose file is
 * alive on disk is the failure this prevents.
 *
 * The relaxation applies to DIRECTORY segments only. A dot-FILE (`.gitignore`)
 * still goes through `pruneDir` unchanged, which keeps the blast radius to the
 * one thing being fixed.
 */
import { describe, test, expect } from 'bun:test';
import { isSyncable, unsyncableReason } from '../src/core/sync.ts';

describe('code strategy sees dot-directories', () => {
  test('versioned dot-dirs are syncable under code', () => {
    expect(isSyncable('.github/workflows/ci.yml', { strategy: 'code' })).toBe(true);
    expect(isSyncable('.claude/scripts/statusline.py', { strategy: 'code' })).toBe(true);
    expect(isSyncable('.vscode/settings.json', { strategy: 'code' })).toBe(true);
    expect(isSyncable('.github/actions/setup/action.yml', { strategy: 'auto' })).toBe(true);
  });

  test('machinery dot-dirs stay excluded', () => {
    expect(isSyncable('.git/config', { strategy: 'code' })).toBe(false);
    expect(unsyncableReason('.git/hooks/pre-commit.py', { strategy: 'code' })).toBe('pruned-dir');
    expect(isSyncable('.gbrain/state.json', { strategy: 'code' })).toBe(false);
    expect(unsyncableReason('.gbrain/x.ts', { strategy: 'code' })).toBe('pruned-dir');
  });

  test('the .raw sidecar convention survives', () => {
    expect(isSyncable('people/pedro.raw/notes.ts', { strategy: 'code' })).toBe(false);
  });

  test('non-dot pruning is untouched', () => {
    expect(isSyncable('node_modules/pkg/index.js', { strategy: 'code' })).toBe(false);
  });

  // CONTROL: must be green before AND after. The brain repo keeps the old rule,
  // so `.sources/` stays reserved and no markdown walker changes behaviour.
  test('markdown strategy still refuses dot-dirs', () => {
    expect(isSyncable('.github/README.md', { strategy: 'markdown' })).toBe(false);
    expect(unsyncableReason('.sources/other/page.md', { strategy: 'markdown' })).toBe('pruned-dir');
    expect(isSyncable('docs/guide.md', { strategy: 'markdown' })).toBe(true);
  });
});
