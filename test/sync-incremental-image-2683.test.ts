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

describe('#2683 residual — import status "error" feeds the failure gate, not the checkpoint', () => {
  test('an image whose decode fails blocks the bookmark and is re-attempted on the next sync', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      const seed = await syncOnce();
      expect(seed.status === 'first_sync' || seed.status === 'synced').toBeTruthy();

      // Garbage bytes under a .heic name: decodeIfNeeded throws, and
      // importImageFile reports it as { status: 'error' } WITHOUT throwing —
      // the branch this regression pins. Pre-fix that result fell into the
      // checkpoint else-branch: the run said 'synced', banked the path as
      // done, and the image was never re-attempted.
      writeFileSync(join(repo, 'broken.heic'), Buffer.from('not a real heic file'));
      git('git add -A && git commit -m broken-image');

      const r1 = await syncOnce();
      expect(r1.status).toBe('blocked_by_failures');
      expect(r1.failedFiles ?? 0).toBeGreaterThanOrEqual(1);
      expect((await pageSlugs()).some(s => s.endsWith('broken.heic'))).toBe(false);

      const r2 = await syncOnce();
      expect(r2.status).toBe('blocked_by_failures');
      expect(r2.failedFiles ?? 0).toBeGreaterThanOrEqual(1);
    });
  });

  test('a rename whose destination import errors is not checkpointed as done', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      const seed = await syncOnce();
      expect(seed.status === 'first_sync' || seed.status === 'synced').toBeTruthy();

      // git-rename the synced markdown to a .heic name: importImageFile gets
      // markdown bytes, decodeIfNeeded throws, the destination import reports
      // status 'error'. Pre-fix the rename arm recorded the failure but STILL
      // ran markCompleted(to) — the resume filter then skipped the rename
      // forever, leaving the target permanently unimported.
      git('git mv note.md renamed.heic && git commit -m rename-to-broken-image');

      const r1 = await syncOnce();
      expect(r1.status).toBe('blocked_by_failures');
      expect(r1.failedFiles ?? 0).toBeGreaterThanOrEqual(1);

      const r2 = await syncOnce();
      expect(r2.status).toBe('blocked_by_failures');
      expect(r2.failedFiles ?? 0).toBeGreaterThanOrEqual(1);
    });
  }, 30000);
});
