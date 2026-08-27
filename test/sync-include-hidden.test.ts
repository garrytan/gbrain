/**
 * `--include-hidden <glob>` — waives `pruneDir`'s leading-dot heuristic for
 * paths matching a user-supplied glob, without touching the default (which
 * must keep pruning `.git`, `.obsidian`, and every other dot-prefixed
 * directory unconditionally).
 *
 * Motivating case: a ledger convention (kazi-org/dira) that stores its
 * schema'd entries under `.dira/entries/`. Before this change no CLI flag,
 * `--include`/`--exclude` glob, or per-source config reached past the
 * dot-prefix prune — `classifySync` (drives `sync`) and
 * `isCollectibleForWalker` (drives `import`'s git-ls-files fast path, the
 * one every git-tracked source actually uses) both hard-excluded any path
 * with a dot-prefixed segment before any include/exclude glob was even
 * checked. `.dira/entries/*.md` was silently unsyncable and unimportable on
 * every git-tracked source, with no workaround.
 *
 * `isPathPruned` is the single function both classifiers now route through
 * (see its doc comment in core/sync.ts) — testing it directly here is
 * equivalent to testing both call sites without duplicating fixtures for
 * each, since a fix to one and not the other is exactly the drift bug this
 * refactor closes.
 */

import { describe, test, expect } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isSyncable, unsyncableReason, isPathPruned } from '../src/core/sync.ts';
import { collectSyncableFiles } from '../src/commands/import.ts';

function gitInit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
}

function gitCommitAll(dir: string): void {
  execSync('git add -A', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
}

describe('isPathPruned — pure classifier used by both sync and import', () => {
  test('include-hidden-waives-dot-prune-when-glob-matches (fails on pre-fix main: includeHidden did not exist and every dot-segment path was unconditionally pruned)', () => {
    expect(isPathPruned('.dira/entries/cst-0001.md')).toBe(true);
    expect(isPathPruned('.dira/entries/cst-0001.md', ['.dira/**'])).toBe(false);
    expect(unsyncableReason('.dira/entries/cst-0001.md', { includeHidden: ['.dira/**'] })).toBe(null);
    expect(isSyncable('.dira/entries/cst-0001.md', { includeHidden: ['.dira/**'] })).toBe(true);
  });

  test('default-still-prunes-dot-dirs-without-include-hidden (regression guard: .git stays pruned when no flag is given)', () => {
    expect(isPathPruned('.git/notes.md')).toBe(true);
    expect(unsyncableReason('.git/notes.md')).toBe('pruned-dir');
    expect(isSyncable('.git/notes.md')).toBe(false);
    // Also unaffected by an unrelated --include-hidden pattern that doesn't match it.
    expect(unsyncableReason('.git/notes.md', { includeHidden: ['.dira/**'] })).toBe('pruned-dir');
  });

  test('a matching include-hidden glob does not waive generated/vendored exclusions', () => {
    // PRUNE_DIR_NAMES / *.raw are a different exclusion class from the
    // leading-dot heuristic and are never waivable by this flag.
    expect(isPathPruned('node_modules/foo/README.md', ['node_modules/**'])).toBe(true);
    expect(isPathPruned('vendor/pkg/note.md', ['vendor/**'])).toBe(true);
    expect(isPathPruned('people/pedro.raw/source.md', ['people/**'])).toBe(true);
  });

  test('include-hidden only waives the specific matching path, not every dot-dir', () => {
    expect(isPathPruned('.dira/entries/cst-0001.md', ['.dira/entries/**'])).toBe(false);
    expect(isPathPruned('.obsidian/workspace.md', ['.dira/entries/**'])).toBe(true);
  });
});

describe('collectSyncableFiles — import.ts entry point (git-ls-files fast path)', () => {
  let dir: string;

  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-include-hidden-'));
    gitInit(dir);
    mkdirSync(join(dir, '.dira', 'entries'), { recursive: true });
    writeFileSync(join(dir, '.dira', 'entries', 'dec-0001.md'), '---\ntype: note\ntitle: A\n---\n\nbody');
    mkdirSync(join(dir, 'brain'), { recursive: true });
    writeFileSync(join(dir, 'brain', 'plan.md'), '---\ntype: note\ntitle: B\n---\n\nbody');
    gitCommitAll(dir);
  }

  function teardown(): void {
    rmSync(dir, { recursive: true, force: true });
  }

  test('default: hidden-dir page absent, ordinary page present', () => {
    setup();
    try {
      const files = collectSyncableFiles(dir, { strategy: 'markdown' });
      expect(files.some((f) => f.endsWith('.dira/entries/dec-0001.md'))).toBe(false);
      expect(files.some((f) => f.endsWith('brain/plan.md'))).toBe(true);
    } finally {
      teardown();
    }
  });

  test('--include-hidden .dira/**: hidden-dir page now present, ordinary page still present', () => {
    setup();
    try {
      const files = collectSyncableFiles(dir, { strategy: 'markdown', includeHidden: ['.dira/**'] });
      expect(files.some((f) => f.endsWith('.dira/entries/dec-0001.md'))).toBe(true);
      expect(files.some((f) => f.endsWith('brain/plan.md'))).toBe(true);
    } finally {
      teardown();
    }
  });
});

describe('sync.ts delta path threads includeHidden (#4027 merge guard)', () => {
  // The hoisted syncOpts in src/commands/sync.ts is shared by the delta-path
  // isSyncable() filters AND the #3974 working-tree drift counter. It is also
  // where a master-merge can silently drop the flag: every
  // `isSyncable(path, syncOpts)` call keeps compiling and every
  // classifier-level test above stays green while --include-hidden parses and
  // does nothing. Pin the threading structurally (the classifier tests above
  // cover behavior; this covers the wiring the classifier can't see).
  test('the hoisted syncOpts literal carries includeHidden', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'sync.ts'), 'utf8');
    expect(src).toMatch(/const syncOpts = \{ strategy: opts\.strategy, includeHidden: opts\.includeHidden \}/);
    // The strategy-only form is the regression shape (pre-#4027 master): its
    // reappearance means a merge resolved the hoist without the threading.
    expect(src).not.toMatch(/const syncOpts = opts\.strategy \? \{ strategy: opts\.strategy \} : undefined/);
  });
});
