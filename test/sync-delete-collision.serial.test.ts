/**
 * #3942 — sync delete path: removing a file whose path has a trailing-hyphen
 * segment must not hard-delete a DIFFERENT page.
 *
 * Bug class: when a deleted path has no `pages.source_path` row (DB-born
 * pages from pre-#2482 writers never populate it), the delete loop falls
 * back to re-slugifying the path — and `slugifySegment` strips trailing
 * hyphens, so `wiki/propose-/note.md` and `wiki/propose/note.md` collapse
 * onto the SAME slug. `engine.deletePages` then hard-deletes the colliding,
 * unrelated page. On a production brain this silently destroyed 9 clean
 * pages while the rows the operator actually targeted survived.
 *
 * Fix: before deleting, fallback-derived slugs are verified against the
 * candidate row's stored `source_path` (same no-slug-guess-deletes rail as
 * the #3252 rename reconcile). A verified mismatch is REFUSED with a stderr
 * warning and checkpointed (deterministic refusal — retrying can never
 * converge; the source_path-keyed full-sync reconcile is the durable
 * cleanup). Rows with NULL source_path or no row at all keep the pre-fix
 * delete-by-path behavior (code-strategy pages and pre-migration brains
 * depend on it).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
// Type-only: erased at compile, so the sync module still loads lazily via
// the dynamic imports inside each test.
import type { SyncResult } from '../src/commands/sync.ts';

let engine: PGLiteEngine;
const repos: string[] = [];
// Serial-file requirement: performSync reads config + the sync-failure
// ledger under the gbrain home — isolate it per test (GBRAIN_HOME is the
// isolation lever; process.env.HOME does not redirect Bun's os.homedir()).
let tmpHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-3942-home-'));
  await resetPgliteState(engine);
});

afterEach(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  while (repos.length) {
    const d = repos.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** Create a temp git repo seeded with the given files + an initial commit. */
function mkRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-3942-'));
  repos.push(dir);
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

const SYNC_OPTS = { noPull: true, noEmbed: true, noExtract: true, sourceId: 'default' } as const;

/**
 * Seed a DB-born page the way pre-#2482 writers did: directly, with NULL
 * source_path (put_page/extract lanes never populated it), so the delete
 * loop's Phase-A source_path resolution can never find it.
 */
async function seedDbBornPage(slug: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter)
     VALUES ('default', $1, NULL, 'note', $1, 'db-born body', '', '{}'::jsonb)`,
    [slug],
  );
}

async function pageExists(slug: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id = 'default' AND slug = $1`,
    [slug],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Run performSync while capturing serr (console.error) lines. */
async function syncCapturingStderr(
  repo: string,
): Promise<{ result: SyncResult; stderr: string }> {
  const { performSync } = await import('../src/commands/sync.ts');
  const captured: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  try {
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    return { result, stderr: captured.join('\n') };
  } finally {
    console.error = origErr;
  }
}

describe('#3942: fallback re-slugify collision on the delete path', () => {
  test('deleting a trailing-hyphen path with no source_path row must not hard-delete the colliding clean page', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const { performSync } = await import('../src/commands/sync.ts');

      // The clean, file-backed page: source_path = 'wiki/propose/note.md'.
      const repo = mkRepo({ 'wiki/propose/note.md': '# Clean note\n\nThe clean page body.\n' });
      await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(await pageExists('wiki/propose/note')).toBe(true);

      // Commit B: the trailing-hyphen twin file lands. It is never imported
      // by sync — the anchor is pinned to B below so the next incremental
      // diff contains ONLY its deletion (importing it would collide at the
      // same slug and corrupt the fixture).
      mkdirSync(join(repo, 'wiki/propose-'), { recursive: true });
      writeFileSync(join(repo, 'wiki/propose-/note.md'), '# Legacy twin\n\nDB-born twin body.\n');
      execSync('git add -A && git commit -m "add trailing-hyphen file"', { cwd: repo, stdio: 'pipe' });
      const commitB = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();

      // Its page is DB-born (pre-#2482 writer): trailing-hyphen slug, NULL
      // source_path — invisible to Phase-A slug resolution.
      await seedDbBornPage('wiki/propose-/note');

      // Commit C: the trailing-hyphen file is deleted.
      execSync('git rm -q "wiki/propose-/note.md" && git commit -m "rm trailing-hyphen file"', {
        cwd: repo, stdio: 'pipe',
      });

      // Pin the sync anchor to the pre-delete commit so the incremental diff
      // is exactly [delete wiki/propose-/note.md].
      await engine.executeRaw(`UPDATE sources SET last_commit = $1 WHERE id = 'default'`, [commitB]);

      const { result, stderr } = await syncCapturingStderr(repo);
      expect(result.status).toBe('synced');

      // THE REGRESSION: pre-fix, the fallback re-slugify collapses
      // 'wiki/propose-/note.md' onto 'wiki/propose/note' and hard-deletes
      // the unrelated clean page.
      expect(await pageExists('wiki/propose/note')).toBe(true);

      // The refusal is loud, and the refused slug never reaches pagesAffected.
      expect(stderr).toContain("refusing to delete 'wiki/propose/note'");
      expect(stderr).toContain('wiki/propose-/note.md');
      expect(result.pagesAffected).not.toContain('wiki/propose/note');

      // Documented residual: the DB-born trailing-hyphen row persists (it was
      // never resolvable from the deleted path); the full-sync reconcile is
      // the durable cleanup surface, never a guessed hard-delete.
      expect(await pageExists('wiki/propose-/note')).toBe(true);

      // The refusal is deterministic and checkpointed: the next run converges
      // instead of re-warning the same delete forever.
      const again = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
      expect(again.status).toBe('up_to_date');
    });
  });

  test('back-compat: a deleted path whose own page is NULL-source_path at the fallback slug still deletes', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const { performSync } = await import('../src/commands/sync.ts');

      const repo = mkRepo({ 'wiki/other.md': '# Other\n\nUnrelated page.\n' });
      await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

      // Commit B: a file whose page exists only as a DB-born row (NULL
      // source_path) AT the path-derived slug — the pre-migration /
      // code-strategy shape that must stay deletable by path.
      mkdirSync(join(repo, 'wiki/legacy'), { recursive: true });
      writeFileSync(join(repo, 'wiki/legacy/entry.md'), '# Legacy entry\n\nBody.\n');
      execSync('git add -A && git commit -m "add legacy entry"', { cwd: repo, stdio: 'pipe' });
      const commitB = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
      await seedDbBornPage('wiki/legacy/entry');

      execSync('git rm -q "wiki/legacy/entry.md" && git commit -m "rm legacy entry"', {
        cwd: repo, stdio: 'pipe',
      });
      await engine.executeRaw(`UPDATE sources SET last_commit = $1 WHERE id = 'default'`, [commitB]);

      const { result, stderr } = await syncCapturingStderr(repo);
      expect(result.status).toBe('synced');

      // NULL source_path keeps the pre-fix behavior: deleted by fallback slug.
      expect(await pageExists('wiki/legacy/entry')).toBe(false);
      expect(result.pagesAffected).toContain('wiki/legacy/entry');
      expect(stderr).not.toContain('refusing to delete');
    });
  });
});
