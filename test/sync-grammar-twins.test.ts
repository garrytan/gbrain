/**
 * Full-sync retirement of old-slug twins (ADR-0001 upgrade path), end to end on
 * PGLite + a temp git repo.
 *
 * A twin is a page the OLD slug grammar minted from a file that now slugs
 * differently: full sync retires it (soft-delete + slug redirect). A page that
 * merely shares a stale source_path with another page is NOT a twin when some
 * file still derives to its slug — e.g. after a cheap rename, whose live row
 * keeps the old path (#3583).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { SLUG_GRAMMAR_VERSION } from '../src/core/cjk.ts';

const SRC = 'twins-src';
let engine: PGLiteEngine;
let repo: string;

const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' });
function write(rel: string, body: string) {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), `---\ntype: concept\ntitle: ${body}\n---\n\n${body}\n`);
}
const sync = (full: boolean) => performSync(engine, { repoPath: repo, full, sourceId: SRC, noPull: true, noEmbed: true });
async function page(slug: string) {
  const [row] = await engine.executeRaw<{ slug: string; source_path: string | null; deleted: boolean; body: string }>(
    `SELECT slug, source_path, deleted_at IS NOT NULL AS deleted, compiled_truth AS body FROM pages WHERE source_id = $1 AND slug = $2`,
    [SRC, slug],
  );
  return row;
}
async function redirect(slug: string) {
  const [row] = await engine.executeRaw<{ canonical_slug: string }>(
    `SELECT canonical_slug FROM slug_aliases WHERE source_id = $1 AND alias_slug = $2`, [SRC, slug],
  );
  return row?.canonical_slug;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);
beforeEach(async () => {
  await resetPgliteState(engine);
  const have = await engine.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, [SRC]);
  if (have.length === 0) await runSources(engine, ['add', SRC, '--no-federated']);
  repo = mkdtempSync(join(tmpdir(), 'gbrain-twins-'));
  git('init');
  git('config user.email "t@t"');
  git('config user.name "t"');
});
afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

describe('full sync retires grammar twins, and only them', () => {
  test('after a cheap rename and a new file under the old name, the renamed page stays live', async () => {
    write('notes/A.md', 'alpha');
    git('add -A'); git('commit -m a');
    await sync(true);

    git('mv notes/A.md notes/B.md'); git('commit -m rename');
    await sync(false);
    // #3583: a cheap rename can leave the LIVE row on its OLD path (updateSlug
    // never rewrites source_path). A full sync that re-imports B.md heals it
    // (#4588) before the reconcile — but a run resuming from a same-grammar
    // checkpoint that already lists B.md does not. State both directly.
    await engine.executeRaw(`UPDATE pages SET source_path = 'notes/A.md' WHERE source_id = $1 AND slug = 'notes/b'`, [SRC]);

    write('notes/A.md', 'new alpha');
    git('add -A'); git('commit -m new-a');
    const home = mkdtempSync(join(tmpdir(), 'gbrain-twins-home-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'import-checkpoint.json'), JSON.stringify({
      schema_version: 1, owner: 'gbrain', kind: 'import', dir: realpathSync(repo),
      completedPaths: [join('notes', 'B.md')], timestamp: new Date().toISOString(), slug_grammar: SLUG_GRAMMAR_VERSION,
    }));
    try {
      await withEnv({ GBRAIN_HOME: home }, () => sync(true));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }

    expect(await page('notes/b')).toMatchObject({ deleted: false });
    expect(await redirect('notes/b')).toBeUndefined();
    expect((await page('notes/a'))?.body).toContain('new alpha');
  }, 60_000);

  test('a page minted by the old grammar from a file that now slugs differently is retired and redirected', async () => {
    write('wiki/Ёлка.md', 'tree');
    git('add -A'); git('commit -m tree');
    // What the old grammar left behind: the same file under the ё-less slug.
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, source_path)
       VALUES ($1, 'wiki/елка', 'concept', 'tree', 'tree', 'wiki/Ёлка.md')`, [SRC],
    );

    await sync(true);

    expect(await page('wiki/ёлка')).toMatchObject({ deleted: false });
    expect(await page('wiki/елка')).toMatchObject({ deleted: true });
    expect(await redirect('wiki/елка')).toBe('wiki/ёлка');
  }, 60_000);
});
