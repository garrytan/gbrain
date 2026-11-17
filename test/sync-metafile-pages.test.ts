/**
 * GBRA-150: `sync.metafile_pages` (default `typed`). A nested file named like folder scaffolding (index.md,
 * README.md, schema.md, log.md, RESOLVER.md) whose frontmatter has a type: or title: is an ordinary page for classic
 * sync (incremental, --full and the bulk import walker); bare scaffolding at any depth and every root-level metafile
 * stay skipped, and off restores the skip-every-metafile behavior. A deleted typed nested metafile soft-deletes its
 * page, a legacy page at a typed path refreshes on edit, and the first sync after the upgrade imports existing typed files.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { DEFAULT_METAFILE_PAGES_MODE, isSyncable, metafileIsPage, SYNC_METAFILE_PAGES_KEY, unsyncableReason } from '../src/core/sync.ts';
import { metafilePagePredicate } from '../src/core/sync-metafile-pages.ts';
import { collectSyncableFiles } from '../src/commands/import.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const TYPED_INDEX = '---\ntype: project\ntitle: Acme Example\n---\n\nThe project hub for acme-example.\n';
const TITLED_README = '---\ntitle: Widgets overview\n---\n\nWhat lives in this folder.\n';
const BARE_README = '# Notes\n\nScaffolding that lists the folder.\n';

describe('metafileIsPage', () => {
  test('nested SYNC_SKIP_FILES names with a typed or titled closed frontmatter are pages under typed', () => {
    expect(DEFAULT_METAFILE_PAGES_MODE).toBe('typed');
    expect(SYNC_METAFILE_PAGES_KEY).toBe('sync.metafile_pages');
    for (const path of ['projects/acme-example/index.md', 'a/README.md', 'a/b/schema.md', 'a/log.md', 'a/RESOLVER.md']) {
      expect(metafileIsPage(path, TYPED_INDEX, 'typed')).toBe(true);
      expect(metafileIsPage(path, TITLED_README, 'typed')).toBe(true);
      expect(metafileIsPage(path, TYPED_INDEX, 'off')).toBe(false);
    }
    expect(metafileIsPage('a/index.md', '\n\n---\r\ntype: hub\r\n---\r\nbody', 'typed')).toBe(true);
    expect(metafileIsPage('a/index.md', '\uFEFF---\n"title": Quoted\n---\n', 'typed')).toBe(true);
  });

  test('bare, unclosed, empty-valued, nested-key and root metafiles are not pages', () => {
    expect(metafileIsPage('a/README.md', BARE_README, 'typed')).toBe(false);
    expect(metafileIsPage('a/README.md', undefined, 'typed')).toBe(false);
    expect(metafileIsPage('a/README.md', '---\ntype: hub\n', 'typed')).toBe(false);
    expect(metafileIsPage('a/README.md', '---\ntype:\ntitle: ~\n---\n', 'typed')).toBe(false);
    expect(metafileIsPage('a/README.md', '---\ntype: # comment\n---\n', 'typed')).toBe(false);
    expect(metafileIsPage('a/README.md', '---\nmeta:\n  type: hub\n---\n', 'typed')).toBe(false);
    expect(metafileIsPage('a/README.md', '# Title\n---\ntype: hub\n---\n', 'typed')).toBe(false);
    expect(metafileIsPage('index.md', TYPED_INDEX, 'typed')).toBe(false);
    expect(metafileIsPage('README.md', TYPED_INDEX, 'typed')).toBe(false);
    expect(metafileIsPage('AGENTS.md', TYPED_INDEX, 'typed')).toBe(false);
    expect(metafileIsPage('docs/AGENTS.md', TYPED_INDEX, 'typed')).toBe(false);
    expect(metafileIsPage('a/notes.md', TYPED_INDEX, 'typed')).toBe(false);
  });

  test('isSyncable consults the predicate for metafile names only', () => {
    const heads: Record<string, string> = { 'a/index.md': TYPED_INDEX, 'a/README.md': BARE_README, 'index.md': TYPED_INDEX };
    const read: string[] = [];
    const metafilePage = metafilePagePredicate('typed', path => { read.push(path); return heads[path]; });
    expect(isSyncable('a/index.md', { metafilePage })).toBe(true);
    expect(unsyncableReason('a/README.md', { metafilePage })).toBe('metafile');
    expect(unsyncableReason('index.md', { metafilePage })).toBe('metafile');
    expect(isSyncable('a/notes.md', { metafilePage })).toBe(true);
    expect(isSyncable('a/index.md')).toBe(false);
    expect(read.sort()).toEqual(['a/README.md', 'a/index.md']);
    expect(isSyncable('a/index.md', { metafilePage: metafilePagePredicate('off', path => heads[path]) })).toBe(false);
  });
});

let engine: PGLiteEngine;
let repoPath: string;
const commit = (message: string) => execSync('git add -A && git commit -qm "' + message + '"', { cwd: repoPath, stdio: 'pipe' });
const write = (path: string, content: string) => { mkdirSync(join(repoPath, path, '..'), { recursive: true }); writeFileSync(join(repoPath, path), content); };
const sync = async (extra: Record<string, unknown> = {}) => (await import('../src/commands/sync.ts')).performSync(engine, { repoPath, noPull: true, noEmbed: true, ...extra });
const page = (slug: string) => engine.getPage(slug);
const live = async (slug: string) => (await engine.executeRaw<{ deleted_at: string | null }>('SELECT deleted_at FROM pages WHERE slug=$1', [slug]))[0];
const relativeFiles = (opts: Parameters<typeof collectSyncableFiles>[1]) => collectSyncableFiles(repoPath, opts).map(path => path.slice(repoPath.length + 1)).sort();

describe('classic sync imports typed nested metafiles', () => {
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
  afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);
  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-metafile-pages-'));
    execSync('git init -q && git config user.email "test@example.invalid" && git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    write('topics/foo.md', '---\ntype: concept\ntitle: Foo\n---\n\nBaseline content.\n');
    write('index.md', TYPED_INDEX);
    commit('initial');
  });
  afterEach(() => { if (repoPath) rmSync(repoPath, { recursive: true, force: true }); });

  test('incremental sync imports a typed nested index.md and README.md; bare nested README.md and a typed root index.md stay skipped', async () => {
    await sync({ full: true });
    write('projects/acme-example/index.md', TYPED_INDEX);
    write('widgets/README.md', TITLED_README);
    write('notes/README.md', BARE_README);
    write('index.md', TYPED_INDEX.replace('hub', 'hub, edited'));
    commit('metafiles');
    const result = await sync();
    expect(result.status).toBe('synced');
    expect((await page('projects/acme-example/index'))?.title).toBe('Acme Example');
    expect((await page('widgets/readme'))?.title).toBe('Widgets overview');
    expect(await page('notes/readme')).toBeNull();
    expect(await page('index')).toBeNull();
    expect(await page('topics/foo')).not.toBeNull();
  }, 60_000);

  test('the bulk import walker and sync --full agree with incremental sync', async () => {
    write('projects/acme-example/index.md', TYPED_INDEX);
    write('notes/README.md', BARE_README);
    commit('metafiles');
    expect(relativeFiles({ strategy: 'markdown' })).toEqual(['projects/acme-example/index.md', 'topics/foo.md']);
    expect(relativeFiles({ strategy: 'markdown', includeGitignored: true })).toEqual(['projects/acme-example/index.md', 'topics/foo.md']);
    expect(relativeFiles({ strategy: 'markdown', metafilePages: 'off' })).toEqual(['topics/foo.md']);
    const first = await sync({ full: true });
    expect(['first_sync', 'synced']).toContain(first.status);
    expect(await page('projects/acme-example/index')).not.toBeNull();
    expect(await page('notes/readme')).toBeNull();
    expect(await page('index')).toBeNull();
    // A second full sync keeps the typed page (its reconcile reads the file) and the bare one stays out.
    await sync({ full: true });
    expect((await live('projects/acme-example/index'))?.deleted_at).toBeNull();
  }, 60_000);

  test('sync.metafile_pages off restores the skip for every metafile', async () => {
    await engine.setConfig(SYNC_METAFILE_PAGES_KEY, 'off');
    await sync({ full: true });
    write('projects/acme-example/index.md', TYPED_INDEX);
    commit('typed');
    await sync();
    expect(await page('projects/acme-example/index')).toBeNull();
    await sync({ full: true });
    expect(await page('projects/acme-example/index')).toBeNull();
  }, 60_000);

  test('deleting a typed nested metafile soft-deletes its page; a bare legacy metafile page is kept (#1433)', async () => {
    write('projects/acme-example/index.md', TYPED_INDEX);
    write('notes/README.md', BARE_README);
    commit('metafiles');
    await sync({ full: true });
    expect(await page('projects/acme-example/index')).not.toBeNull();
    await engine.putPage('notes/readme', { type: 'concept', title: 'Notes', compiled_truth: 'Indexed by an older foresights.', timeline: '', frontmatter: { type: 'concept' } });
    unlinkSync(join(repoPath, 'projects/acme-example/index.md'));
    unlinkSync(join(repoPath, 'notes/README.md'));
    commit('remove metafiles');
    const result = await sync();
    expect(result.status).toBe('synced');
    expect((await live('projects/acme-example/index'))?.deleted_at).not.toBeNull();
    expect((await live('notes/readme'))?.deleted_at).toBeNull();
  }, 60_000);

  test('a legacy page at a typed nested metafile path refreshes when its file is edited', async () => {
    write('projects/acme-example/index.md', TYPED_INDEX);
    commit('typed');
    await engine.setConfig(SYNC_METAFILE_PAGES_KEY, 'off');
    await sync({ full: true });
    await engine.putPage('projects/acme-example/index', { type: 'project', title: 'Acme Example', compiled_truth: 'Stale text an older foresights indexed.', timeline: '',
      frontmatter: { type: 'project', title: 'Acme Example' } });
    await engine.executeRaw("UPDATE pages SET source_path='projects/acme-example/index.md' WHERE slug='projects/acme-example/index'");
    await engine.setConfig(SYNC_METAFILE_PAGES_KEY, 'typed');
    write('projects/acme-example/index.md', TYPED_INDEX.replace('The project hub', 'The edited project hub'));
    commit('edit typed');
    await sync();
    expect((await page('projects/acme-example/index'))?.compiled_truth).toContain('The edited project hub');
  }, 60_000);

  test('the first sync after the upgrade imports existing typed files and rewrites nothing else', async () => {
    write('projects/acme-example/index.md', TYPED_INDEX);
    write('notes/README.md', BARE_README);
    commit('metafiles');
    // The brain synced under the old behavior: every metafile skipped.
    await engine.setConfig(SYNC_METAFILE_PAGES_KEY, 'off');
    await sync({ full: true });
    expect(await page('projects/acme-example/index')).toBeNull();
    const before = await engine.executeRaw<{ updated_at: string }>("SELECT updated_at::text FROM pages WHERE slug='topics/foo'");
    await engine.executeRaw('DELETE FROM config WHERE key=$1', [SYNC_METAFILE_PAGES_KEY]);
    // No new commit: the upgrade alone makes the typed file a page.
    const upgraded = await sync();
    expect(upgraded.status).toBe('synced');
    expect(upgraded.deleted).toBe(0);
    expect(await page('projects/acme-example/index')).not.toBeNull();
    expect(await page('notes/readme')).toBeNull();
    expect(await engine.executeRaw<{ updated_at: string }>("SELECT updated_at::text FROM pages WHERE slug='topics/foo'")).toEqual(before);
    // Once applied, a quiet sync is up to date again.
    expect((await sync()).status).toBe('up_to_date');
  }, 60_000);
});
