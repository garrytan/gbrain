/**
 * #753/#774 — --src-subpath + --exclude monorepo subdir-source support.
 *
 * A single git repo can hold N logical sources at subdirectories (wiki/,
 * memory/, ...). `gbrain sync --src-subpath wiki` (or passing the subdir
 * directly as the repo path) scopes file walking + imports to the subdir
 * while git operations (pull, rev-parse, diff) run at the discovered repo
 * root. Slugs stay git-root-relative (`wiki/page1`) so full and incremental
 * syncs of the same scope agree.
 *
 * Security pins (the point of the feature's guards):
 *   NAV-1/NAV-2 — `--src-subpath ../escape` and a symlinked subdir pointing
 *   outside the repo are realpath-checked and rejected before any git op.
 *   NAV-1 TOCTOU — per-file realpath checks during the incremental import
 *   drain (see the isPathSafe guard in sync.ts's importOnePath).
 *   NAV-4 — an --exclude set that filters out everything warns loudly.
 *
 * Regression note: against pre-#774 master every subdir test fails with
 * "Not a git repository".
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

// Helper: create a minimal valid markdown file
function mdPage(title: string, body = 'Content.'): string {
  return `---\ntype: note\ntitle: ${title}\n---\n\n${body}`;
}

// Helper: init a git repo with author identity
function gitInit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
}

// Helper: stage + commit everything in a git repo
function gitCommit(dir: string, msg = 'initial'): void {
  execSync('git add -A', { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: dir, stdio: 'pipe' });
}

describe('sync monorepo subdir-source support (#753/#774)', () => {
  let engine: PGLiteEngine;
  let repoPath: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-monorepo-'));
    gitInit(repoPath);
    mkdirSync(join(repoPath, 'wiki'), { recursive: true });
    mkdirSync(join(repoPath, 'memory'), { recursive: true });
    writeFileSync(join(repoPath, 'wiki', 'page1.md'), mdPage('Wiki Page 1'));
    writeFileSync(join(repoPath, 'wiki', 'page2.md'), mdPage('Wiki Page 2'));
    writeFileSync(join(repoPath, 'memory', 'note1.md'), mdPage('Memory Note 1'));
    writeFileSync(join(repoPath, 'memory', 'note2.md'), mdPage('Memory Note 2'));
    gitCommit(repoPath);
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Back-compat: sync at git root (no srcSubpath) still works
  // ─────────────────────────────────────────────────────────────────────────

  test('back-compat: sync at git root without srcSubpath imports all files', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      full: true,
    });
    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(4); // wiki/page1 + wiki/page2 + memory/note1 + memory/note2
    // Slug shape unchanged for git-root syncs.
    expect(await engine.getPage('wiki/page1')).not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Auto-discovery: repoPath IS a non-git-root subdir
  // ─────────────────────────────────────────────────────────────────────────

  test('auto-discovery: repoPath is a git subdir — discoverGitRoot succeeds', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Pass the wiki/ subdir directly as repoPath (no explicit srcSubpath).
    // Pre-#774: throws "Not a git repository".
    // Post-#774: gitContextRoot = repo root, syncScopeRoot = wiki/.
    const result = await performSync(engine, {
      repoPath: join(repoPath, 'wiki'),
      noPull: true,
      noEmbed: true,
      full: true,
    });
    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(2); // only wiki/page1 + wiki/page2
    // Slugs are git-root-relative in BOTH spellings (subdir repoPath and
    // --src-subpath) so full and incremental syncs of the same scope agree.
    expect(await engine.getPage('wiki/page1')).not.toBeNull();
    expect(await engine.getPage('page1')).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // srcSubpath explicit flag: scope to subdir from git root
  // ─────────────────────────────────────────────────────────────────────────

  test('--src-subpath wiki: only wiki/ files are imported', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      srcSubpath: 'wiki',
      noPull: true,
      noEmbed: true,
      full: true,
    });
    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(2);
    // Verify the imported slugs are from wiki/ only (git-root-relative)
    const wikiPage = await engine.getPage('wiki/page1');
    expect(wikiPage).not.toBeNull();
    const memoryPage = await engine.getPage('memory/note1');
    expect(memoryPage).toBeNull();
  });

  test('--src-subpath memory: only memory/ files are imported', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      srcSubpath: 'memory',
      noPull: true,
      noEmbed: true,
      full: true,
    });
    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(2);
    const memoryPage = await engine.getPage('memory/note1');
    expect(memoryPage).not.toBeNull();
    const wikiPage = await engine.getPage('wiki/page1');
    expect(wikiPage).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Two sources in one repo, scoped independently
  // ─────────────────────────────────────────────────────────────────────────

  test('2 sources in 1 repo: sync each scope independently, no cross-contamination', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    const wikiResult = await performSync(engine, {
      repoPath,
      srcSubpath: 'wiki',
      noPull: true,
      noEmbed: true,
      full: true,
    });
    expect(wikiResult.status).toBe('first_sync');
    expect(wikiResult.added).toBe(2);

    // Reset only page state, keep the engine connected for second sync
    await resetPgliteState(engine);

    const memResult = await performSync(engine, {
      repoPath,
      srcSubpath: 'memory',
      noPull: true,
      noEmbed: true,
      full: true,
    });
    expect(memResult.status).toBe('first_sync');
    expect(memResult.added).toBe(2);

    // After memory sync, memory pages exist and wiki pages don't
    expect(await engine.getPage('memory/note1')).not.toBeNull();
    expect(await engine.getPage('wiki/page1')).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Incremental sync respects the scope (the gap #774 left untested)
  // ─────────────────────────────────────────────────────────────────────────

  test('incremental --src-subpath: only in-scope diff paths are processed', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    const first = await performSync(engine, {
      repoPath,
      srcSubpath: 'wiki',
      noPull: true,
      noEmbed: true,
      full: true,
    });
    expect(first.status).toBe('first_sync');

    // Commit 2: touch one file in each scope + add one wiki file.
    writeFileSync(join(repoPath, 'wiki', 'page1.md'), mdPage('Wiki Page 1', 'Updated.'));
    writeFileSync(join(repoPath, 'memory', 'note1.md'), mdPage('Memory Note 1', 'Updated.'));
    writeFileSync(join(repoPath, 'wiki', 'page3.md'), mdPage('Wiki Page 3'));
    gitCommit(repoPath, 'second');

    const second = await performSync(engine, {
      repoPath,
      srcSubpath: 'wiki',
      noPull: true,
      noEmbed: true,
    });
    expect(second.status).toBe('synced');
    expect(second.added).toBe(1);    // wiki/page3 only — memory change filtered by scope
    expect(second.modified).toBe(1); // wiki/page1
    expect(await engine.getPage('wiki/page3')).not.toBeNull();
    expect(await engine.getPage('memory/note1')).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Path-traversal sanitization (NAV-1 + NAV-2)
  // ─────────────────────────────────────────────────────────────────────────

  test('path-traversal: --src-subpath ../escape is rejected before any git op', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'gbrain-escape-'));
    try {
      const { performSync } = await import('../src/commands/sync.ts');
      await expect(
        performSync(engine, {
          repoPath,
          srcSubpath: '../' + outsideDir.split('/').pop(),
          noPull: true,
          noEmbed: true,
          full: true,
        }),
      ).rejects.toThrow(/outside git repo|does not exist/i);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('path-traversal: symlink subdir pointing outside repo is rejected (NAV-1 TOCTOU)', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'gbrain-sym-target-'));
    writeFileSync(join(outsideDir, 'secret.md'), mdPage('Secret'));
    const symlinkPath = join(repoPath, 'symlink-escape');
    try {
      symlinkSync(outsideDir, symlinkPath);
      const { performSync } = await import('../src/commands/sync.ts');
      await expect(
        performSync(engine, {
          repoPath,
          srcSubpath: 'symlink-escape',
          noPull: true,
          noEmbed: true,
          full: true,
        }),
      ).rejects.toThrow(/outside git repo/i);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('path-traversal: absolute --src-subpath outside the repo is rejected', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'gbrain-abs-escape-'));
    writeFileSync(join(outsideDir, 'secret.md'), mdPage('Secret'));
    try {
      const { performSync } = await import('../src/commands/sync.ts');
      // path.join(repoPath, '/abs/path') keeps the traversal relative, but a
      // crafted subpath can still resolve outside via ..-segments; both are
      // caught by the same realpath containment check.
      await expect(
        performSync(engine, {
          repoPath,
          srcSubpath: join('..', '..', outsideDir.slice(1)),
          noPull: true,
          noEmbed: true,
          full: true,
        }),
      ).rejects.toThrow(/outside git repo|does not exist/i);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // --exclude: repeatable glob pattern flag
  // ─────────────────────────────────────────────────────────────────────────

  test('--exclude: single pattern excludes matching files from full sync', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Sync wiki/ but exclude page2.md (patterns are scope-relative)
    const result = await performSync(engine, {
      repoPath,
      srcSubpath: 'wiki',
      exclude: ['page2.md'],
      noPull: true,
      noEmbed: true,
      full: true,
    });
    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(1); // only page1 (page2 excluded)
    expect(await engine.getPage('wiki/page1')).not.toBeNull();
    expect(await engine.getPage('wiki/page2')).toBeNull();
  });

  test('--exclude: glob pattern with wildcard', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Exclude all files matching *2.md
    const result = await performSync(engine, {
      repoPath,
      srcSubpath: 'wiki',
      exclude: ['*2.md'],
      noPull: true,
      noEmbed: true,
      full: true,
    });
    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(1); // only page1 (page2 excluded by *2.md)
  });

  test('--exclude applies to the incremental path too', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const first = await performSync(engine, {
      repoPath,
      srcSubpath: 'wiki',
      noPull: true,
      noEmbed: true,
      full: true,
    });
    expect(first.status).toBe('first_sync');

    writeFileSync(join(repoPath, 'wiki', 'draft-a.md'), mdPage('Draft A'));
    writeFileSync(join(repoPath, 'wiki', 'page3.md'), mdPage('Wiki Page 3'));
    gitCommit(repoPath, 'drafts');

    const second = await performSync(engine, {
      repoPath,
      srcSubpath: 'wiki',
      exclude: ['draft-*.md'],
      noPull: true,
      noEmbed: true,
    });
    expect(second.status).toBe('synced');
    expect(second.added).toBe(1); // page3 only; draft-a excluded
    expect(await engine.getPage('wiki/page3')).not.toBeNull();
    expect(await engine.getPage('wiki/draft-a')).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // --exclude '**/*' emits warning (NAV-4)
  // ─────────────────────────────────────────────────────────────────────────

  test('--exclude **/* emits warning when all files are excluded (NAV-4)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '));
      origWarn(...args);
    };
    try {
      await performSync(engine, {
        repoPath,
        srcSubpath: 'wiki',
        exclude: ['**/*'],
        noPull: true,
        noEmbed: true,
        full: true,
      });
    } finally {
      console.warn = origWarn;
    }
    const hasExcludeWarn = warnMessages.some(m => m.includes('--exclude') || m.includes('No files matched'));
    expect(hasExcludeWarn).toBe(true);
  });
});
