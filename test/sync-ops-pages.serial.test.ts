/**
 * #2404 — `ops/` is ordinary content: sync imports `ops/*` files and never
 * deletes `ops/*` pages.
 *
 * Bug class: `'ops'` was hardcoded in PRUNE_DIR_NAMES (a v0.2.0-era carve-out),
 * so `classifySync` treated ANY path with an `ops` segment as 'pruned-dir':
 *   - committed `ops/*.md` files were never imported (even by `sync --full`);
 *   - a modified `ops/*` file fell into the unsyncableModified delete loop,
 *     whose #1433 guard only skipped 'metafile' — so put-created `ops/*` pages
 *     (e.g. the bundled daily-task-manager's canonical `ops/tasks`) were
 *     silently deleted on every sync.
 *
 * Fix: remove `'ops'` from PRUNE_DIR_NAMES, and harden the delete loop to also
 * skip 'pruned-dir' classifications (a page under a genuinely-pruned dir can
 * only exist via a deliberate put_page — never delete it on a file edit).
 *
 * Modeled on test/sync-metafile-skip.serial.test.ts (the #1433 iron rule).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;

function gitInit(repo: string): void {
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
}

describe('#2404 — ops/ pages sync like any other content', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-ops-'));
    gitInit(repoPath);
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/foo.md'), [
      '---', 'type: concept', 'title: Foo', '---', '', 'Baseline content.',
    ].join('\n'));
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('a committed ops/*.md file is imported by sync', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    mkdirSync(join(repoPath, 'ops'), { recursive: true });
    writeFileSync(join(repoPath, 'ops/tasks.md'), [
      '---', 'type: concept', 'title: Tasks', '---', '', 'Open tasks live here.',
    ].join('\n'));
    execSync('git add -A && git commit -m "add ops/tasks"', { cwd: repoPath, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    expect(['first_sync', 'synced']).toContain(result.status);

    // Pre-fix: ops/* was 'pruned-dir' → imported=0 for it, even on --full.
    const page = await engine.getPage('ops/tasks');
    expect(page).not.toBeNull();
    expect(page?.compiled_truth).toContain('Open tasks');
  }, 60_000);

  test('an edited ops/*.md updates its page instead of deleting it', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    mkdirSync(join(repoPath, 'ops'), { recursive: true });
    writeFileSync(join(repoPath, 'ops/tasks.md'), [
      '---', 'type: concept', 'title: Tasks', '---', '', 'v1',
    ].join('\n'));
    execSync('git add -A && git commit -m "add ops/tasks"', { cwd: repoPath, stdio: 'pipe' });
    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });

    writeFileSync(join(repoPath, 'ops/tasks.md'), [
      '---', 'type: concept', 'title: Tasks', '---', '', 'v2 with a new task',
    ].join('\n'));
    execSync('git add -A && git commit -m "edit ops/tasks"', { cwd: repoPath, stdio: 'pipe' });

    // Pre-fix: this incremental sync hit the unsyncableModified delete loop
    // ("Deleted un-syncable page: ops/tasks" — the autopilot kill-loop).
    const second = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(['synced', 'up_to_date', 'first_sync']).toContain(second.status);

    const page = await engine.getPage('ops/tasks');
    expect(page).not.toBeNull();
    expect(page?.compiled_truth).toContain('v2');
  }, 60_000);

  test('hardening: a put-created page under a STILL-pruned dir survives a file edit (pruned-dir delete guard)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // node_modules stays in PRUNE_DIR_NAMES. Commit a file there, then seed a
    // same-path page via putPage — the deliberate-put precondition.
    mkdirSync(join(repoPath, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(repoPath, 'node_modules/pkg/notes.md'), 'v1\n');
    execSync('git add -A -f && git commit -m "vendor file"', { cwd: repoPath, stdio: 'pipe' });
    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });

    await engine.putPage('node_modules/pkg/notes', {
      type: 'concept',
      title: 'Deliberate put page',
      compiled_truth: 'Created via put_page; must survive sync.',
      timeline: '',
      frontmatter: { type: 'concept' },
    });

    writeFileSync(join(repoPath, 'node_modules/pkg/notes.md'), 'v2\n');
    execSync('git add -A -f && git commit -m "edit vendor file"', { cwd: repoPath, stdio: 'pipe' });
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });

    // Pre-fix: reason 'pruned-dir' was not guarded → page deleted.
    const survivor = await engine.getPage('node_modules/pkg/notes');
    expect(survivor).not.toBeNull();
  }, 60_000);
});
