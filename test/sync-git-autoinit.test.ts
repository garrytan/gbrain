/**
 * #2964 — sync phase self-heals a never-git-initialized default brain dir.
 *
 * A legacy `sync.repo_path`-anchored default brain (no `sources` row) can
 * reach `performSync` pointed at a directory that was never `git init`-ed
 * (predates git-backed sync, or was rsync'd from another machine without
 * its `.git`). Before this fix, `discoverGitRoot` threw unconditionally and
 * the dream cycle's sync phase failed every night with no self-recovery,
 * even though `doctor`'s sync checks reported "ok" (for an unrelated
 * reason — they only look at the `sources` table, which has no rows for
 * this kind of brain).
 *
 * gbrain owns that directory outright, so the fix self-heals by `git
 * init`-ing it and capturing the current on-disk state as the sync
 * baseline. Ownership is proven by VALUE — the resolved `repoPath` must
 * equal gbrain's own persisted `sync.repo_path` anchor — not by whether
 * `opts.repoPath`/`opts.sourceId` happen to be set. That distinction
 * matters because the real production caller (`runPhaseSync` in
 * cycle.ts, i.e. `gbrain dream`'s sync phase) always passes the resolved
 * anchor through explicitly as `opts.repoPath`; gating on
 * `!opts.repoPath` (an earlier, insufficiently-reviewed version of this
 * fix) would have made the self-heal never fire on the exact path it was
 * written to repair (Codex review round 3 caught this). A caller-supplied
 * path that does NOT match the anchor (a registered local source, or an
 * admin-scope `submit_job({name:'sync', data:{repoPath}})` MCP call with
 * an unrelated path) must keep failing loudly rather than being silently
 * git-initialized without consent.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

function mdPage(title: string, body = 'Content.'): string {
  return `---\ntype: note\ntitle: ${title}\n---\n\n${body}`;
}

describe('#2964: sync auto-inits a never-git-initialized default brain dir', () => {
  let engine: PGLiteEngine;
  let dir: string;

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
    dir = mkdtempSync(join(tmpdir(), 'gbrain-2964-'));
    writeFileSync(join(dir, 'page1.md'), mdPage('Page 1'));
    writeFileSync(join(dir, 'page2.md'), mdPage('Page 2'));
    // The self-heal-eligible anchor: gbrain's own persisted config, not a
    // caller-supplied --repo / job.data.repoPath (those are proven by
    // VALUE against this anchor, not by mere absence — see file docstring).
    await engine.setConfig('sync.repo_path', dir);
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('anchor-resolved sync (no repoPath, no sourceId) on a non-git dir auto-inits git and imports files', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    expect(existsSync(join(dir, '.git'))).toBe(false);

    const result = await performSync(engine, { noPull: true, noEmbed: true, full: true });

    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(2);
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(await engine.getPage('page1')).not.toBeNull();
    expect(await engine.getPage('page2')).not.toBeNull();
  });

  test('explicit repoPath matching the anchor still auto-inits (mirrors gbrain dream\'s sync phase)', async () => {
    // cycle.ts's runPhaseSync (the actual dream-cycle call site this bug
    // was filed against) always passes `repoPath: brainDir` explicitly —
    // it already resolved the anchor itself upstream and threads it
    // through. Gating self-heal on `!opts.repoPath` would silently never
    // fire here; ownership must be proven by matching the anchor's VALUE.
    const { performSync } = await import('../src/commands/sync.ts');
    expect(existsSync(join(dir, '.git'))).toBe(false);

    const result = await performSync(engine, { repoPath: dir, noPull: true, noEmbed: true, full: true });

    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(2);
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });

  test('a second sync after auto-init sees no changes (baseline commit captured current on-disk state)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const first = await performSync(engine, { noPull: true, noEmbed: true, full: true });
    expect(first.added).toBe(2);

    // No new files, no explicit `full` — a real incremental sync against the
    // auto-init baseline. Before this fix there was no baseline to diff
    // against (sync errored outright); a naive fix that skipped the initial
    // commit would make this call re-report both files as "added" again.
    const second = await performSync(engine, { noPull: true, noEmbed: true });
    expect(second.status).not.toBe('first_sync');
    expect(second.added).toBe(0);
    expect(second.modified).toBe(0);
  });

  test('a registered local source (sourceId set, no remote_url) on a non-git dir still throws — not auto-inited', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await expect(
      performSync(engine, {
        repoPath: dir,
        sourceId: 'default',
        noPull: true,
        noEmbed: true,
        full: true,
      }),
    ).rejects.toThrow(/git repository/i);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  test('a caller-supplied repoPath that does NOT match the anchor still throws (P1: MCP submit_job arbitrary-path guard)', async () => {
    // Mirrors jobs.ts: submit_job({name:'sync', data:{repoPath}}) reaches
    // performSyncInner with sourceId left undefined whenever repoPath
    // doesn't match a registered source's local_path. Self-heal must not
    // fire for a path that isn't gbrain's own anchor, even with no
    // sourceId set — only exact anchor-value equality (the previous test)
    // is eligible.
    const other = mkdtempSync(join(tmpdir(), 'gbrain-2964-other-'));
    writeFileSync(join(other, 'unrelated.md'), mdPage('Unrelated'));
    try {
      const { performSync } = await import('../src/commands/sync.ts');
      await expect(
        performSync(engine, { repoPath: other, noPull: true, noEmbed: true, full: true }),
      ).rejects.toThrow(/git repository/i);
      expect(existsSync(join(other, '.git'))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test('--src-subpath on the anchor-resolved path still throws — not auto-inited (P2: subpath scope guard)', async () => {
    // A self-heal baseline commit runs `git add -A` at the git root before
    // any subpath-scoped file collection happens, so it would capture
    // sibling directories a --src-subpath sync never intended to touch.
    const { performSync } = await import('../src/commands/sync.ts');
    await expect(
      performSync(engine, {
        srcSubpath: 'wiki',
        noPull: true,
        noEmbed: true,
        full: true,
      }),
    ).rejects.toThrow(/git repository/i);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  test('--dry-run on the anchor-resolved path throws without writing anything to disk', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await expect(
      performSync(engine, { repoPath: dir, dryRun: true, noPull: true, noEmbed: true, full: true }),
    ).rejects.toThrow(/git repository/i);
    // The whole point of --dry-run is "preview only" — it must never git-init
    // or commit on our behalf, even though this is otherwise self-heal-eligible.
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  test('unborn-HEAD recovery: a bare `git init` with zero commits (interrupted prior self-heal) still completes', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { execSync } = await import('child_process');
    // Simulate a self-heal that ran `git init` but died before the baseline
    // commit landed (process killed, disk full, etc.) — `.git` exists so
    // discoverGitRoot succeeds, but `git rev-parse HEAD` still fails.
    execSync('git init -q', { cwd: dir });

    const result = await performSync(engine, { repoPath: dir, noPull: true, noEmbed: true, full: true });

    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(2);
    expect(execSync('git rev-parse HEAD', { cwd: dir }).toString().trim()).not.toBe('');
  });

  test('db_only paths are excluded from the baseline commit even without gbrain.yml write support (P2: fail-closed exclusion)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const { mkdirSync } = await import('fs');
    const { execSync } = await import('child_process');
    mkdirSync(join(dir, 'private-cache'));
    writeFileSync(join(dir, 'private-cache', 'secret.bin'), 'binary-ish content');
    writeFileSync(
      join(dir, 'gbrain.yml'),
      'storage:\n  db_only:\n    - private-cache\n',
    );

    await performSync(engine, { noPull: true, noEmbed: true, full: true });

    expect(existsSync(join(dir, '.git'))).toBe(true);
    const tracked = execSync('git ls-files', { cwd: dir }).toString();
    expect(tracked).not.toContain('private-cache');
  });
});
