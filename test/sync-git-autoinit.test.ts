/**
 * #2964 — sync phase self-heals a never-git-initialized default brain dir.
 *
 * A legacy `sync.repo_path`-anchored default brain (no `sources` row, no
 * `--source`) can reach `performSync` pointed at a directory that was never
 * `git init`-ed (predates git-backed sync, or was rsync'd from another
 * machine without its `.git`). Before this fix, `discoverGitRoot` threw
 * unconditionally and the dream cycle's sync phase failed every night with
 * no self-recovery, even though `doctor`'s sync checks reported "ok" (for
 * an unrelated reason — they only look at the `sources` table, which has
 * no rows for this kind of brain).
 *
 * gbrain owns this directory outright, so the fix self-heals by
 * `git init`-ing it and capturing the current on-disk state as the sync
 * baseline — but ONLY for the default/no-`sourceId` path. A registered
 * local source (`sources add --path`, no `--url`) is the user's own
 * external directory and must keep failing loudly rather than being
 * silently git-initialized without consent.
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
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('default (no sourceId) sync on a non-git dir auto-inits git and imports files', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    expect(existsSync(join(dir, '.git'))).toBe(false);

    const result = await performSync(engine, {
      repoPath: dir,
      noPull: true,
      noEmbed: true,
      full: true,
    });

    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(2);
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(await engine.getPage('page1')).not.toBeNull();
    expect(await engine.getPage('page2')).not.toBeNull();
  });

  test('a second sync after auto-init sees no changes (baseline commit captured current on-disk state)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const first = await performSync(engine, {
      repoPath: dir,
      noPull: true,
      noEmbed: true,
      full: true,
    });
    expect(first.added).toBe(2);

    // No new files, no explicit `full` — a real incremental sync against the
    // auto-init baseline. Before this fix there was no baseline to diff
    // against (sync errored outright); a naive fix that skipped the initial
    // commit would make this call re-report both files as "added" again.
    const second = await performSync(engine, {
      repoPath: dir,
      noPull: true,
      noEmbed: true,
    });
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
});
