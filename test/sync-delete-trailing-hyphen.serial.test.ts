/**
 * #3942 — sync delete path: removing a file whose path has a trailing-hyphen
 * segment must never delete a DIFFERENT page.
 *
 * `slugifySegment()` strips trailing hyphens, so the delete lane's
 * re-slugified fallback maps `extracts/propose-/round-single.md` to the SAME
 * slug as `extracts/propose/round-single.md`. When the exact `source_path`
 * lookup misses (the removed file is not any page's recorded origin), the
 * pre-fix fallback deleted whatever page sat at the hyphen-stripped slug —
 * a different, legitimate page whose own file was still on disk. In the wild
 * this silently hard-deleted 9 pages.
 *
 * The fix routes every sync delete/rename-from resolution through
 * `resolveSlugsForRemovedPaths` (src/core/sync-git.ts): exact source_path
 * match first (the import side's own record), and a fallback that REFUSES
 * to act when the derived slug names a page that records a DIFFERENT origin
 * file. Refusals are logged, never silently dropped.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resolveSlugsForRemovedPaths } from '../src/core/sync-git.ts';

let engine: PGLiteEngine;
const repos: string[] = [];
// GBRAIN_HOME isolation: sync reads/writes operator-home state (failure
// ledger, nag state); keep it away from the real home. Serial-file suffix
// because we mutate process.env.GBRAIN_HOME.
let tmpHome: string;
const originalGbrainHome = process.env.GBRAIN_HOME;

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
  process.env.GBRAIN_HOME = tmpHome;
  await resetPgliteState(engine);
});

afterEach(() => {
  if (originalGbrainHome !== undefined) process.env.GBRAIN_HOME = originalGbrainHome;
  else delete process.env.GBRAIN_HOME;
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

function commitAll(dir: string, msg: string): void {
  execSync(`git add -A && git commit -m "${msg}"`, { cwd: dir, stdio: 'pipe' });
}

const SYNC_OPTS = { noPull: true, noEmbed: true, noExtract: true, sourceId: 'default' } as const;

async function sourcePathOf(slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ source_path: string | null }>(
    `SELECT source_path FROM pages WHERE source_id = 'default' AND slug = $1`,
    [slug],
  );
  return rows.length > 0 ? rows[0].source_path : null;
}

async function seedPage(slug: string, sourcePath: string | null, sourceId = 'default'): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter)
     VALUES ($1, $2, $3, 'note', $2, 'body', '', '{}'::jsonb)
     ON CONFLICT (source_id, slug) DO UPDATE SET source_path = EXCLUDED.source_path`,
    [sourceId, slug, sourcePath],
  );
}

describe('#3942: deleting a trailing-hyphen path must not delete a different page', () => {
  test('e2e: rm of legacy `propose-` file leaves the clean `propose` page intact', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    // Sync 1: only the legacy trailing-hyphen file exists. slugifyPath strips
    // the hyphen, so it imports AT the clean slug (that collision is the
    // import side's own long-standing behavior, not under test here).
    const repo = mkRepo({
      'extracts/propose-/round-single.md': '# Legacy take\n\nlegacy body\n',
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('extracts/propose/round-single')).not.toBeNull();
    expect(await sourcePathOf('extracts/propose/round-single'))
      .toBe('extracts/propose-/round-single.md');

    // Sync 2: the clean file lands (post-#2482 world). Same slug, different
    // body — the reimport re-records source_path to the clean file, which is
    // exactly the wild state: no page's source_path points at the legacy file.
    mkdirSync(join(repo, 'extracts/propose'), { recursive: true });
    writeFileSync(join(repo, 'extracts/propose/round-single.md'), '# Clean take\n\nclean body\n');
    commitAll(repo, 'add clean variant');
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await sourcePathOf('extracts/propose/round-single'))
      .toBe('extracts/propose/round-single.md');

    // Sync 3: the operator removes ONLY the legacy trailing-hyphen file. The
    // clean file is untouched and still on disk. Pre-fix, the delete lane's
    // re-slugified fallback resolved the legacy path to the CLEAN slug and
    // hard-deleted the clean page (the #3942 data loss).
    unlinkSync(join(repo, 'extracts/propose-/round-single.md'));
    commitAll(repo, 'remove legacy trailing-hyphen file');
    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // The clean page — whose own file still exists — must survive.
    expect(await engine.getPage('extracts/propose/round-single')).not.toBeNull();
    expect(result.pagesAffected).not.toContain('extracts/propose/round-single');
  });

  test('e2e: normal delete of a page whose file is removed still works', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'notes/keep.md': '# Keep\n\nkeep body\n',
      'notes/drop.md': '# Drop\n\ndrop body\n',
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('notes/drop')).not.toBeNull();

    unlinkSync(join(repo, 'notes/drop.md'));
    commitAll(repo, 'remove drop');
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    expect(await engine.getPage('notes/drop')).toBeNull();
    expect(await engine.getPage('notes/keep')).not.toBeNull();
  });
});

describe('resolveSlugsForRemovedPaths (shared delete-side resolver, #3942)', () => {
  test('exact source_path match wins (import-side record, no re-slugification)', async () => {
    await seedPage('frontmatter-slug', 'ทดสอบ.md');
    const res = await resolveSlugsForRemovedPaths(engine, ['ทดสอบ.md'], 'default');
    expect(res.slugs.get('ทดสอบ.md')).toBe('frontmatter-slug');
    expect(res.refused).toEqual([]);
  });

  test('fallback naming a page with a DIFFERENT recorded origin is refused', async () => {
    // The clean page records its own file as origin.
    await seedPage('extracts/propose/round-single', 'extracts/propose/round-single.md');
    const res = await resolveSlugsForRemovedPaths(
      engine,
      ['extracts/propose-/round-single.md'],
      'default',
    );
    expect(res.slugs.has('extracts/propose-/round-single.md')).toBe(false);
    expect(res.refused).toEqual([
      {
        path: 'extracts/propose-/round-single.md',
        slug: 'extracts/propose/round-single',
        originPath: 'extracts/propose/round-single.md',
      },
    ]);
  });

  test('fallback onto a page with NULL source_path stays deletable (legacy pre-source_path brains)', async () => {
    await seedPage('legacy/note', null);
    const res = await resolveSlugsForRemovedPaths(engine, ['Legacy/Note.md'], 'default');
    expect(res.slugs.get('Legacy/Note.md')).toBe('legacy/note');
    expect(res.refused).toEqual([]);
  });

  test('fallback with no page at the derived slug passes through (harmless no-op delete)', async () => {
    const res = await resolveSlugsForRemovedPaths(engine, ['ghost/never-existed.md'], 'default');
    expect(res.slugs.get('ghost/never-existed.md')).toBe('ghost/never-existed');
    expect(res.refused).toEqual([]);
  });

  test('unscoped (sourceId undefined) legacy lane also refuses foreign-origin fallbacks', async () => {
    await seedPage('extracts/propose/round-single', 'extracts/propose/round-single.md');
    const res = await resolveSlugsForRemovedPaths(
      engine,
      ['extracts/propose-/round-single.md'],
      undefined,
    );
    expect(res.slugs.has('extracts/propose-/round-single.md')).toBe(false);
    expect(res.refused.length).toBe(1);
    expect(res.refused[0].originPath).toBe('extracts/propose/round-single.md');
  });

  test('mixed batch: exact hits, safe fallbacks, and refusals resolve independently', async () => {
    await seedPage('wiki/alpha', 'wiki/alpha.md');
    await seedPage('extracts/propose/round-single', 'extracts/propose/round-single.md');
    const res = await resolveSlugsForRemovedPaths(
      engine,
      ['wiki/alpha.md', 'extracts/propose-/round-single.md', 'ghost/gone.md'],
      'default',
    );
    expect(res.slugs.get('wiki/alpha.md')).toBe('wiki/alpha');
    expect(res.slugs.get('ghost/gone.md')).toBe('ghost/gone');
    expect(res.slugs.has('extracts/propose-/round-single.md')).toBe(false);
    expect(res.refused.length).toBe(1);
  });
});

describe('unscoped lane on multi-source brains: refuse-vs-allow is deterministic (wave-C review)', () => {
  const REMOVED = 'extracts/propose-/round-single.md';
  const DERIVED = 'extracts/propose/round-single';

  async function addSource(id: string): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      [id],
    );
  }

  async function softDelete(slug: string, sourceId = 'default'): Promise<void> {
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() WHERE source_id = $1 AND slug = $2`,
      [sourceId, slug],
    );
  }

  test('mixed NULL + foreign origins across sources → allow, regardless of row order', async () => {
    await addSource('src2');
    // NULL-origin (legacy) row seeded FIRST so a last-row-wins lookup would
    // land on the foreign-origin row and refuse — the outcome must not
    // depend on which source's row the query happened to return.
    await seedPage(DERIVED, null, 'src2');
    await seedPage(DERIVED, 'extracts/propose/round-single.md', 'default');
    const res = await resolveSlugsForRemovedPaths(engine, [REMOVED], undefined);
    expect(res.slugs.get(REMOVED)).toBe(DERIVED);
    expect(res.refused).toEqual([]);
  });

  test('ANY live row whose origin matches (after separator normalization) allows', async () => {
    await addSource('src2');
    // Backslash-separator origin: misses the phase-1 exact-string match but
    // IS the removed file after normalization. Seeded first so a
    // last-row-wins collection would see only the foreign origin and refuse.
    await seedPage(DERIVED, 'extracts\\propose-\\round-single.md', 'src2');
    await seedPage(DERIVED, 'extracts/propose/round-single.md', 'default');
    const res = await resolveSlugsForRemovedPaths(engine, [REMOVED], undefined);
    expect(res.slugs.get(REMOVED)).toBe(DERIVED);
    expect(res.refused).toEqual([]);
  });

  test('every live row records a foreign origin → refused, with a deterministic originPath', async () => {
    await addSource('src2');
    await seedPage(DERIVED, 'somewhere/else.md', 'src2');
    await seedPage(DERIVED, 'extracts/propose/round-single.md', 'default');
    const res = await resolveSlugsForRemovedPaths(engine, [REMOVED], undefined);
    expect(res.slugs.has(REMOVED)).toBe(false);
    // source_id-ordered collection: the reported origin is always the
    // 'default' row's, never whichever row the engine returned last.
    expect(res.refused).toEqual([
      { path: REMOVED, slug: DERIVED, originPath: 'extracts/propose/round-single.md' },
    ]);
  });

  test('a soft-deleted foreign-origin row no longer vetoes the fallback', async () => {
    await seedPage(DERIVED, 'extracts/propose/round-single.md');
    await softDelete(DERIVED);
    const res = await resolveSlugsForRemovedPaths(engine, [REMOVED], undefined);
    // No LIVE row at the derived slug → harmless no-op delete passes through.
    expect(res.slugs.get(REMOVED)).toBe(DERIVED);
    expect(res.refused).toEqual([]);
  });

  test("a soft-deleted row's exact source_path match no longer drives unscoped resolution", async () => {
    await seedPage('legacy-dead', REMOVED);
    await softDelete('legacy-dead');
    // A live page sits at the derived slug and records its own (different)
    // file — the dead row must not resolve the removed path onto anything.
    await seedPage(DERIVED, 'extracts/propose/round-single.md');
    const res = await resolveSlugsForRemovedPaths(engine, [REMOVED], undefined);
    expect(res.slugs.has(REMOVED)).toBe(false);
    expect(res.refused.length).toBe(1);
    expect(res.refused[0].originPath).toBe('extracts/propose/round-single.md');
  });
});
