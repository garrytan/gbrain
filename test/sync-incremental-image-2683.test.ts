/**
 * #2683 — incremental sync must admit images when multimodal is enabled.
 *
 * Pre-fix, `isAllowedByStrategy` under the default 'markdown' strategy was
 * markdown-only (the FULL-sync walker admitted images via
 * isCollectibleForWalker, so images only ever landed through `sync --full`),
 * and the incremental import sites called importFile unconditionally — a
 * committed .png that DID slip through ('auto' strategy) went down the UTF-8
 * text path and failed.
 *
 * Coverage (PGLite performSync, real git repo):
 *   - default strategy: md first-sync, then a committed png imports
 *     incrementally, anchor advances, re-sync is up_to_date
 *   - 'auto' strategy: same, and no UTF-8 failure blocks the run
 *   - gate off: the png stays excluded (existing behavior preserved)
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { performSync } from '../src/commands/sync.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let repo: string;

function git(cmd: string) {
  execSync(cmd, { cwd: repo, stdio: 'pipe' });
}

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
  repo = mkdtempSync(join(tmpdir(), 'gbrain-2683-'));
  git('git init');
  git('git config user.email "t@t.com"');
  git('git config user.name "T"');
  writeFileSync(join(repo, 'note.md'), '---\ntype: concept\ntitle: Note\n---\n\nSeed body.\n');
  git('git add -A && git commit -m seed');
});

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

async function pageSlugs(): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE deleted_at IS NULL ORDER BY slug`,
  );
  return rows.map(r => r.slug);
}

async function syncOnce(extra: Record<string, unknown> = {}) {
  return performSync(engine, {
    repoPath: repo,
    sourceId: 'default',
    noEmbed: true,
    noPull: true,
    ...extra,
  });
}

for (const strategy of [undefined, 'auto'] as const) {
  const label = strategy ?? 'default (markdown)';
  test(`incremental png imports under ${label} strategy when multimodal is on`, async () => {
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      const strategyOpts = strategy ? { strategy } : {};

      const first = await syncOnce(strategyOpts);
      expect(['first_sync', 'synced']).toContain(first.status);
      expect(await pageSlugs()).toContain('note');

      // Commit an image AFTER the first sync — only the INCREMENTAL path sees it.
      copyFileSync('test/fixtures/images/tiny.avif', join(repo, 'photo.png'));
      git('git add -A && git commit -m add-image');

      const second = await syncOnce(strategyOpts);
      // Pre-fix: default strategy returned 'up_to_date'/'synced' with the image
      // silently excluded; 'auto' recorded a UTF-8 failure and blocked. Both are
      // wrong — the image page must land and the anchor must advance.
      expect(second.status).toBe('synced');
      expect(second.added).toBe(1);
      const slugs = await pageSlugs();
      expect(slugs.some(s => s.endsWith('photo.png'))).toBe(true);

      // Anchor advanced: a third sync has nothing to do.
      const third = await syncOnce(strategyOpts);
      expect(third.status).toBe('up_to_date');
    });
  }, 90_000);
}

test('gate off: a committed png stays excluded (no image page, no failure)', async () => {
  await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: undefined }, async () => {
    const first = await syncOnce();
    expect(['first_sync', 'synced']).toContain(first.status);

    copyFileSync('test/fixtures/images/tiny.avif', join(repo, 'photo.png'));
    git('git add -A && git commit -m add-image');

    const second = await syncOnce();
    // The png is filtered by strategy; nothing to import, no block.
    expect(['up_to_date', 'synced']).toContain(second.status);
    const slugs = await pageSlugs();
    expect(slugs.some(s => s.endsWith('photo.png'))).toBe(false);
  });
}, 90_000);
