import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

// #5610 / #5398 (Linux residual): a source registered at a git subdirectory and
// pinned to slug_root_mode=source-root stores source-relative origins on sync.
// Write-through used to mint git-root-relative origins, so every page created by
// put_page wedged the next managed sync with page_identity_changed.

const home = mkdtempSync(join(tmpdir(), 'gbrain-subdir-origin-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'content') => {
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
};
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function fixture(engine: BrainEngine, files: Record<string, string>, opts: { managed?: boolean; scope?: string; pinned?: boolean } = {}) {
  const scope = opts.scope ?? 'brain';
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const id = `subdir-${randomUUID().slice(0, 12)}`, repo = join(home, id), root = join(repo, scope);
  mkdirSync(root, { recursive: true }); git(repo, 'init', '-q');
  writeFileSync(join(repo, 'README.md'), 'Repository outside the source.\n');
  for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
  commit(repo, 'seed');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)',
    [id, root, JSON.stringify(opts.pinned === false ? {} : { slug_root_mode: 'source-root' })]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [opts.managed !== false]);
  const registration = await registerLocalWriter(engine, 'cli');
  const ctx: OperationContext = { engine, remote: false, sourceId: id, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } };
  return { id, repo, root, registration, ctx };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const local = <T>(engine: BrainEngine, registration: LocalRegistration, fn: () => Promise<T>) => withVerifiedLocalRegistration(engine, registration, fn);
const isolated = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
  for (const engine of engines) await fn(engine);
});
async function put(engine: BrainEngine, f: Fixture, slug: string, body: string) {
  return local(engine, f.registration, () => operationsByName.put_page!.handler(f.ctx, { source_id: f.id, slug, request_id: randomUUID(),
    content: `---\ntype: note\ntitle: ${slug}\n---\n${body}\n` })) as Promise<Record<string, unknown>>;
}
const sourcePath = async (engine: BrainEngine, f: Fixture, slug: string) =>
  (await engine.executeRaw<{ source_path: string | null }>('SELECT source_path FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [f.id, slug]))[0]?.source_path;
const sync = (engine: BrainEngine, f: Fixture, full = false) => performManagedSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, full });

test('managed put_page mints the source-relative origin and the next sync succeeds', async () => isolated(async engine => {
  const f = await fixture(engine, { 'notes/existing.md': '---\ntitle: Existing\n---\nA synced observation.\n' });
  expect((await sync(engine, f)).status).toBe('first_sync');
  expect(await sourcePath(engine, f, 'notes/existing')).toBe('notes/existing.md');
  expect((await put(engine, f, 'notes/new-person', 'A new observation written through the coordinator.')).state).toBe('committed');
  expect(existsSync(join(f.root, 'notes/new-person.md'))).toBe(true);
  expect(await sourcePath(engine, f, 'notes/new-person')).toBe('notes/new-person.md');
  commit(f.repo, 'commit the written page');
  expect((await sync(engine, f)).status).toBe('synced');
  expect(await sourcePath(engine, f, 'notes/new-person')).toBe('notes/new-person.md');
  expect((await sync(engine, f, true)).status).not.toBe('failed');
  expect(await sourcePath(engine, f, 'notes/new-person')).toBe('notes/new-person.md');
}), 120_000);

test('legacy git-root origins sync, are repaired in place on import, survive full sync and delete cleanly', async () => isolated(async engine => {
  const f = await fixture(engine, { 'notes/edited.md': '---\ntitle: Edited\n---\nOriginal edited body.\n',
    'notes/kept.md': '---\ntitle: Kept\n---\nKept body.\n', 'notes/removed.md': '---\ntitle: Removed\n---\nRemoved body.\n' });
  expect((await sync(engine, f)).status).toBe('first_sync');
  for (const slug of ['notes/edited', 'notes/kept', 'notes/removed']) {
    await engine.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [f.id, slug, `brain/${slug}.md`]);
  }
  writeFileSync(join(f.root, 'notes/edited.md'), '---\ntitle: Edited\n---\nA newer committed body.\n');
  rmSync(join(f.root, 'notes/removed.md'));
  commit(f.repo, 'edit and remove');
  const result = await sync(engine, f);
  expect(result.status).toBe('synced');
  expect(await sourcePath(engine, f, 'notes/edited')).toBe('notes/edited.md');
  expect((await engine.getPage('notes/edited', { sourceId: f.id }))?.compiled_truth).toContain('A newer committed body.');
  expect(await engine.getPage('notes/removed', { sourceId: f.id })).toBeNull();
  expect(await sourcePath(engine, f, 'notes/kept')).toBe('brain/notes/kept.md');
  expect((await sync(engine, f, true)).status).not.toBe('failed');
  expect(await engine.getPage('notes/kept', { sourceId: f.id })).not.toBeNull();
  expect(readFileSync(join(f.root, 'notes/kept.md'), 'utf8')).toContain('Kept body.');
}), 120_000);

test('a legacy origin that could name two files refuses with a reason id instead of guessing', async () => isolated(async engine => {
  const f = await fixture(engine, { 'a.md': '---\ntitle: A\n---\nRoot body.\n', 'sub/a.md': '---\ntitle: Nested\n---\nNested body.\n' }, { scope: 'sub' });
  expect((await sync(engine, f)).status).toBe('first_sync');
  await engine.executeRaw("UPDATE pages SET source_path='sub/a.md' WHERE source_id=$1 AND slug='a'", [f.id]);
  await engine.executeRaw("UPDATE pages SET source_path=NULL WHERE source_id=$1 AND slug='sub/a'", [f.id]);
  writeFileSync(join(f.root, 'a.md'), '---\ntitle: A\n---\nChanged root body.\n');
  commit(f.repo, 'change root file');
  const refused = await sync(engine, f).then(() => null, (error: unknown) => error as { code?: string; detail?: string });
  expect(refused).toMatchObject({ code: 'page_identity_changed', detail: 'ambiguous_source_path' });
  expect((await engine.getPage('a', { sourceId: f.id }))?.compiled_truth).toContain('Root body.');
}), 120_000);

test.each([true, false])('write-through put_page on an unmanaged subdirectory source binds the source-relative origin (pinned=%p)', async pinned => isolated(async engine => {
  const f = await fixture(engine, { 'notes/existing.md': '---\ntitle: Existing\n---\nA synced observation.\n' }, { managed: false, pinned });
  await put(engine, f, 'notes/unmanaged-new', 'A new observation written through write-through.');
  expect(existsSync(join(f.root, 'notes/unmanaged-new.md'))).toBe(true);
  expect(await sourcePath(engine, f, 'notes/unmanaged-new')).toBe('notes/unmanaged-new.md');
}), 120_000);

test('an unpinned subdirectory source whose pages carry the Git prefix keeps minting the Git-root origin', async () => isolated(async engine => {
  const f = await fixture(engine, {}, { managed: false, pinned: false });
  await engine.putPage('brain/notes/prefixed', { type: 'note', title: 'Prefixed', compiled_truth: 'Legacy prefixed page.' }, { sourceId: f.id });
  await put(engine, f, 'notes/git-root-new', 'A new observation in a Git-root namespace.');
  expect(await sourcePath(engine, f, 'notes/git-root-new')).toBe('brain/notes/git-root-new.md');
}), 120_000);

test('a page whose source-relative path repeats the scope directory is edited and deleted in its own file', async () => isolated(async engine => {
  const f = await fixture(engine, { 'notes/existing.md': '---\ntitle: Existing\n---\nA synced observation.\n' }, { scope: 'docs' });
  expect((await sync(engine, f)).status).toBe('first_sync');
  const sibling = join(f.root, 'a.md');
  expect((await put(engine, f, 'docs/a', 'The nested page body.')).state).toBe('committed');
  expect(await sourcePath(engine, f, 'docs/a')).toBe('docs/a.md');
  const nested = join(f.root, 'docs/a.md');
  writeFileSync(sibling, readFileSync(nested, 'utf8'));
  const siblingBytes = readFileSync(sibling, 'utf8');
  const snapshot = (await engine.readPageSnapshot('docs/a', { sourceId: f.id }))!;
  const edited = await local(engine, f.registration, () => operationsByName.put_page!.handler(f.ctx, { source_id: f.id, slug: 'docs/a',
    request_id: randomUUID(), expected_revision: snapshot.revision, content: '---\ntype: note\ntitle: docs/a\n---\nAn edited nested body.\n' })) as Record<string, unknown>;
  expect(edited.state).toBe('committed');
  expect(readFileSync(nested, 'utf8')).toContain('An edited nested body.');
  expect(readFileSync(sibling, 'utf8')).toBe(siblingBytes);
  const current = (await engine.readPageSnapshot('docs/a', { sourceId: f.id }))!;
  const deleted = await local(engine, f.registration, () => operationsByName.delete_page!.handler(f.ctx, { source_id: f.id, slug: 'docs/a',
    request_id: randomUUID(), expected_revision: current.revision })) as Record<string, unknown>;
  expect(deleted.state).toBe('committed');
  expect(existsSync(nested)).toBe(false);
  expect(readFileSync(sibling, 'utf8')).toBe(siblingBytes);
}), 120_000);

test.each([false, true])('renaming a nested scope-named file out of the scope directory is a delete plus a new page (full=%p)', async full => isolated(async engine => {
  const f = await fixture(engine, { 'sub/a.md': '---\ntitle: Nested\n---\nNested body.\n' }, { scope: 'sub' });
  expect((await sync(engine, f)).status).toBe('first_sync');
  expect(await sourcePath(engine, f, 'sub/a')).toBe('sub/a.md');
  git(f.repo, 'mv', 'sub/sub/a.md', 'sub/a.md'); commit(f.repo, 'rename');
  expect((await sync(engine, f, full)).status).toBe('synced');
  expect(await engine.getPage('sub/a', { sourceId: f.id })).toBeNull();
  expect((await engine.getPage('a', { sourceId: f.id }))?.compiled_truth).toContain('Nested body.');
  expect(await sourcePath(engine, f, 'a')).toBe('a.md');
}), 120_000);

test('an unpinned subdirectory source pins its inferred mode with the first origin, so a scope-named slug keeps its file', async () => isolated(async engine => {
  const f = await fixture(engine, {}, { scope: 'docs', pinned: false });
  expect((await put(engine, f, 'docs/a', 'The first nested page body.')).state).toBe('committed');
  expect(await sourcePath(engine, f, 'docs/a')).toBe('docs/a.md');
  expect((await engine.executeRaw<{ mode: string | null }>("SELECT config->>'slug_root_mode' AS mode FROM sources WHERE id=$1", [f.id]))[0].mode).toBe('source-root');
  const nested = join(f.root, 'docs/a.md'), sibling = join(f.root, 'a.md');
  writeFileSync(sibling, readFileSync(nested, 'utf8'));
  const snapshot = (await engine.readPageSnapshot('docs/a', { sourceId: f.id }))!;
  const edited = await local(engine, f.registration, () => operationsByName.put_page!.handler(f.ctx, { source_id: f.id, slug: 'docs/a',
    request_id: randomUUID(), expected_revision: snapshot.revision, content: '---\ntype: note\ntitle: docs/a\n---\nAn edited nested body.\n' })) as Record<string, unknown>;
  expect(edited.state).toBe('committed');
  expect(readFileSync(nested, 'utf8')).toContain('An edited nested body.');
  expect(readFileSync(sibling, 'utf8')).not.toContain('An edited nested body.');
}), 120_000);
