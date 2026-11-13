/**
 * GBRA-150: `sources_resolve_path` / `gbrain sources resolve-path` answers what gbrain did with each file path by gbrain's
 * own rules. The three shapes a copied slug rule gets wrong: a path whose slug
 * gbrain folds (trailing hyphen), a deleted file whose case-folded twin owns the slug (checked by origin, never slug), and a
 * nested `index.md` sync skips as folder scaffolding. Plus the states a harness must tell apart: missing (a real gap),
 * held, not synced yet. Red on master: the module and the operation do not exist there.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveSourcePaths, RESOLVE_PATHS_MAX } from '../src/core/persistence/resolve-paths.ts';
import { operationsByName } from '../src/core/operations.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-resolve-path-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); return git(root, 'rev-parse', 'HEAD'); };
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation about ${title}.\n`;

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function unmanaged<T>(engine: BrainEngine, run: () => Promise<T>): Promise<T> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await run(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}

async function source(engine: BrainEngine, files: Record<string, string>) {
  const id = `rslv-${randomUUID().replace(/-/g, '').slice(0, 20)}`, repo = join(home, id);
  const write = (path: string, content: string) => { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), content); };
  mkdirSync(repo, { recursive: true }); git(repo, 'init', '-q');
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(repo);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, repo, '{}']);
  await claimWorktree(engine, id, repo);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = (extra: Partial<SyncOpts> = {}) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, ...extra });
  return { id, repo, write, sync, remove: (path: string) => unlinkSync(join(repo, path)),
    resolve: (...paths: string[]) => resolveSourcePaths(engine, id, paths),
    legacy: async (added: Record<string, string>) => {
      for (const [path, content] of Object.entries(added)) write(path, content);
      await unmanaged(engine, () => engine.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [id, commit(repo)]));
    } };
}

async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    for (const engine of engines) {
      try { await run(engine); } finally { await disposePersistenceConsumer(engine); }
    }
  });
}

const HYPHEN = 'articles/outlet-example/a-headline-.md';
const TWIN_LOWER = 'sources/meetings/2026-10-19-call-abcdefghxyz.md';
const TWIN_MIXED = 'sources/meetings/2026-10-19-call-AbCdEfGhXyZ.md';
const NESTED_INDEX = 'projects/acme-example/index.md';

test('a plain directory returns a typed refusal with a read-only next step', () => each(async engine => {
  const id = 'resolve-plain-directory';
  const dir = join(home, id);
  mkdirSync(dir, { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, dir]);

  await expect(resolveSourcePaths(engine, id, ['notes/example.md'])).rejects.toMatchObject({
    code: 'sync_not_applicable',
    reason: 'plain_directory',
    message: expect.stringContaining('without Git history'),
    suggestion: expect.stringContaining('choose a registered Git source'),
    fix: { argv: ['gbrain', 'sources', 'status', id, '--json'], consent: [] },
  });
}), 240_000);

test('an incomplete Git directory in an ancestor still reports the original Git failure', () => each(async engine => {
  const id = 'resolve-damaged-git';
  const root = join(home, id);
  const dir = join(root, 'notes');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, dir]);

  await expect(resolveSourcePaths(engine, id, ['example.md'])).rejects.toMatchObject({
    status: 128,
    stderr: expect.stringContaining('fatal: not a git repository'),
  });
}), 240_000);

test('a registered Git clone with missing metadata still reports the original Git failure before its first sync', () => each(async engine => {
  const id = 'resolve-missing-clone';
  const dir = join(home, id);
  mkdirSync(dir, { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)',
    [id, dir, JSON.stringify({ managed_clone: true, remote_url: 'https://example.invalid/repo.git' })]);

  await expect(resolveSourcePaths(engine, id, ['example.md'])).rejects.toMatchObject({
    status: 128,
    stderr: expect.stringContaining('fatal: not a git repository'),
  });
}), 240_000);

test('the slug gbrain folds a trailing hyphen into resolves to the indexed page, not a missing one', () => each(async engine => {
  const s = await source(engine, { [HYPHEN]: note('Headline') });
  await s.sync();
  const [p] = (await s.resolve(HYPHEN)).paths;
  expect(p).toMatchObject({ path: HYPHEN, slug: 'articles/outlet-example/a-headline', in_synced_commit: true, at_head: true, skipped: null, hold: null });
  expect(p!.page).toMatchObject({ slug: 'articles/outlet-example/a-headline', deleted: false });
  expect(p!.page!.chunks).toBeGreaterThan(0);
  expect(['searchable', 'pending_embedding']).toContain(p!.state);
  expect(p!.searchable).not.toBe(false);
}), 240_000);

test('a deleted mixed-case file whose lowercase twin owns the slug reads deleted, with the twin named, never as a failed delete', () => each(async engine => {
  const s = await source(engine, { [TWIN_LOWER]: note('Call') });
  await s.sync();
  const result = await s.resolve(TWIN_MIXED, TWIN_LOWER);
  const [mixed, lower] = result.paths;
  expect(mixed).toMatchObject({ path: TWIN_MIXED, slug: 'sources/meetings/2026-10-19-call-abcdefghxyz', state: 'deleted', in_synced_commit: false, page: null, fix: null,
    slug_owner: { slug: 'sources/meetings/2026-10-19-call-abcdefghxyz', source_path: TWIN_LOWER } });
  expect(mixed!.why).toContain(TWIN_LOWER);
  expect(lower).toMatchObject({ slug: mixed!.slug, slug_owner: null, in_synced_commit: true });
  expect(lower!.page).not.toBeNull();
}), 240_000);

test('a file deleted for real reads deleted once synced and stale_page before; a nested index.md reads skipped as a metafile with its typed frontmatter flagged', () => each(async engine => {
  const s = await source(engine, { 'notes/gone.md': note('Gone'), 'notes/keep.md': note('Keep'), [NESTED_INDEX]: '---\ntype: project\nstatus: active\n---\nA synthetic project hub.\n',
    'people/README.md': 'Folder notes.\n' });
  await engine.setConfig('sync.metafile_pages', 'off');
  try {
    await s.sync();
    s.remove('notes/gone.md');
    await s.legacy({});
    expect((await s.resolve('notes/gone.md')).paths[0]).toMatchObject({ state: 'stale_page', in_synced_commit: false });
    await s.sync();
    expect((await s.resolve('notes/gone.md')).paths[0]).toMatchObject({ state: 'deleted', page: { deleted: true }, slug_owner: null, fix: null });
    const [index, readme] = (await s.resolve(NESTED_INDEX, 'people/README.md')).paths;
    expect(index).toMatchObject({ state: 'skipped', searchable: false, page: null, skipped: { reason: 'metafile', typed_frontmatter: true }, fix: null });
    expect(readme).toMatchObject({ state: 'skipped', skipped: { reason: 'metafile', typed_frontmatter: false } });
  } finally { await engine.setConfig('sync.metafile_pages', ''); }
}), 240_000);

test('under the default sync.metafile_pages typed, a typed nested index.md resolves as its page; a bare nested README.md still reads skipped', () => each(async engine => {
  const s = await source(engine, { [NESTED_INDEX]: '---\ntype: project\nstatus: active\n---\nA synthetic project hub.\n', 'people/README.md': 'Folder notes.\n' });
  await s.sync();
  const [index, readme] = (await s.resolve(NESTED_INDEX, 'people/README.md')).paths;
  expect(index).toMatchObject({ path: NESTED_INDEX, slug: 'projects/acme-example/index', in_synced_commit: true, skipped: null, hold: null, page: { slug: 'projects/acme-example/index', deleted: false } });
  expect(['searchable', 'pending_embedding']).toContain(index!.state);
  expect(readme).toMatchObject({ state: 'skipped', page: null, skipped: { reason: 'metafile', typed_frontmatter: false } });
}), 240_000);

test('a committed eligible file with no page and no hold is missing (a real gap) with the re-screen fix; a held file and a not-yet-synced commit read as such', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A') });
  await s.sync();
  await s.legacy({ 'notes/lost.md': note('Lost') });
  const [lost] = (await s.resolve('notes/lost.md')).paths;
  expect(lost).toMatchObject({ state: 'missing', searchable: false, page: null, fix: { argv: ['gbrain', 'sources', 'retry-held', s.id, '--unindexed'],
    then: { argv: ['gbrain', 'sync', '--source', s.id, '--no-pull'] } } });
  s.write('investors/fund-a.md', '---\ntitle: Fund A\nslug: fund-a\n---\nA synthetic fund page.\n');
  commit(s.repo);
  const [early] = (await s.resolve('investors/fund-a.md')).paths;
  expect(early).toMatchObject({ state: 'not_synced_yet', in_synced_commit: false, at_head: true, fix: { argv: ['gbrain', 'sync', '--source', s.id, '--no-pull'] } });
  await s.sync();
  const [held] = (await s.resolve('investors/fund-a.md')).paths;
  expect(held).toMatchObject({ state: 'held', searchable: false, hold: { code: 'frontmatter_slug_conflict' }, frontmatter_slug: 'fund-a',
    fix: { argv: ['gbrain', 'sync', 'status', '--source', s.id, '--json'] } });
}), 240_000);

test('the operation is read-scoped, takes paths relative to the source root, and refuses an empty or oversized batch', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A') });
  await s.sync();
  const op = operationsByName.sources_resolve_path!;
  expect(op).toMatchObject({ scope: 'read', mutating: false });
  const out = await op.handler({ engine, remote: false } as never, { id: s.id, paths: ['./notes/a.md'] }) as Awaited<ReturnType<typeof resolveSourcePaths>>;
  expect(out.paths[0]).toMatchObject({ slug: 'notes/a', in_synced_commit: true });
  const remote = { engine, remote: true, sourceId: 'other-example', auth: { allowedSources: ['other-example'] } } as never;
  await expect(op.handler(remote, { id: s.id, paths: ['notes/a.md'] })).rejects.toMatchObject({ code: 'not_found' });
  await expect(s.resolve()).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(s.resolve(...Array.from({ length: RESOLVE_PATHS_MAX + 1 }, (_, i) => `notes/${i}.md`))).rejects.toMatchObject({ code: 'invalid_params' });
}), 240_000);

test('a large page whose embedding budget is held reads pending_embedding with the hold, never keyword_only (which means embed_skip)', () => each(async engine => {
  const { PAGE_INLINE_MAX_BYTES } = await import('../src/core/page-size-policy.ts');
  const body = 'Weekly notes from acme-example with alice-example. '.repeat(Math.ceil((PAGE_INLINE_MAX_BYTES + 4096) / 51));
  const s = await source(engine, { 'notes/large-example.md': `---\ntitle: Large\n---\n${body}\n`, 'notes/skip-example.md': '---\ntitle: Skip\nembed_skip:\n  reason: operator\n---\nSkipped by choice.\n' });
  await s.sync();
  const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [s.id, 'notes/large-example']);
  await engine.executeRaw(`INSERT INTO page_embedding_budget (page_id, state, reason) VALUES ($1, 'held', 'upgrade_backfill')
    ON CONFLICT (page_id) DO UPDATE SET state='held', reason='upgrade_backfill'`, [page!.id]);
  const { paths: [held, skipped] } = await s.resolve('notes/large-example.md', 'notes/skip-example.md');
  expect(held).toMatchObject({ state: 'pending_embedding', searchable: 'keyword', embedding_hold: { state: 'held', reason: 'upgrade_backfill' } });
  expect(held!.page!.unembedded).toBe(held!.page!.chunks);
  expect(held!.page!.chunks).toBeGreaterThan(0);
  expect(held!.fix!.argv).toEqual(['gbrain', 'embed', '--held', '--dry-run', '--source', s.id]);
  expect(skipped).toMatchObject({ state: 'keyword_only', searchable: 'keyword', embedding_hold: null });
}), 240_000);

