/**
 * #7848: a file whose frontmatter asks for `visibility: private` in a spelling page privacy does not read
 * (`Visibility: private`, `visibility: Private`, a block scalar, a flow list, a merge key, a flow-mapping block) is held
 * `visibility_noncanonical` by Git sync and `gbrain import`, as `invalid_frontmatter` is, and is never stored
 * world-readable. #7844 refuses the same request on put_page, edit_page and capture (`visibility_not_applied`); file
 * ingestion never ran that check, so such a file synced or imported as a world page.
 *
 * Protects:
 * - repo-less `gbrain import` of a plain directory (no Git checkout), unmanaged and managed: each such file is refused
 *   and listed as a failure, no page is written; `visibility: private` (any quoting) and pages that do not ask for
 *   private import unchanged;
 * - classic (unmanaged) Git sync and managed Git sync: each such file is held `visibility_noncanonical`, the rest of
 *   the source syncs, an existing world page keeps its content, and the file imports private once it says
 *   `visibility: private`;
 * - doctor `git_held_files` counts the held files and the stored pages whose frontmatter asks for private in a
 *   spelling page privacy does not read (pages written before this release), on a brain with no Git source too.
 *
 * PGLite here; Postgres through test/e2e/visibility-noncanonical-hold-7848-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import { performSync } from '../src/commands/sync.ts';
import { importFile } from '../src/core/import-file.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { isPrivatePage } from '../src/core/search/private-visibility.ts';
import { screenImportContent } from '../src/core/import-screen.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { noncanonicalPrivateRequest } from '../src/core/persistence/visibility-request.ts';
import { gitHeldFilesCheck } from '../src/commands/doctor/checks/git-holds.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const home = mkdtempSync(join(tmpdir(), 'gbrain-7848-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };

beforeAll(async () => {
  if (backends.includes('pglite')) { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engines.push(pglite); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  for (const each of engines) await each.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
}, 120_000);

afterAll(async () => {
  for (const each of engines) if (each.kind === 'pglite') await each.disconnect();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, extra = '') => `---\ntitle: ${title}\ntype: note\n${extra}---\nA note about acme-example.\n`;

/** Spellings that ask for private but would not store exactly `visibility: private`. */
const NONCANONICAL: Record<string, string> = {
  'notes/upper-key.md': note('Upper key', 'Visibility: private\n'),
  'notes/upper-value.md': note('Upper value', 'visibility: Private\n'),
  'notes/block-scalar.md': note('Block scalar', 'visibility: |\n  private\n'),
  'notes/flow-list.md': note('Flow list', 'visibility: [private]\n'),
  'notes/merge-key.md': note('Merge key', 'base: &base\n  Visibility: Private\n<<: *base\n'),
  'notes/flow-mapping.md': '---\n{title: Flow mapping, type: note, Visibility: Private}\n---\nA note about acme-example.\n',
};
/** Files that pass unchanged: a canonical private request (any quoting) and pages that do not ask for private. */
const PRIVATE: Record<string, string> = {
  'notes/canonical.md': note('Canonical', 'visibility: private\n'),
  'notes/quoted.md': note('Quoted', '"visibility": "private" # keep\n'),
};
const WORLD: Record<string, string> = {
  'notes/plain.md': note('Plain'),
  'notes/world.md': note('World', 'visibility: world\n'),
};
const slugOf = (path: string) => path.replace(/\.md$/, '');
const paths = (files: Record<string, string>) => Object.keys(files).sort();
const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);

function writeTree(root: string, files: Record<string, string>): void {
  mkdirSync(join(root, 'notes'), { recursive: true });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
}

async function newSource(engine: BrainEngine, root: string): Promise<string> {
  const id = `source-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  return id;
}

/** Every noncanonical file left no page, private files are stored private and world files world. */
async function expectStored(engine: BrainEngine, sourceId: string): Promise<void> {
  for (const path of paths(NONCANONICAL)) expect({ path, page: await engine.getPage(slugOf(path), { sourceId }) }).toEqual({ path, page: null });
  for (const path of paths(PRIVATE)) expect({ path, private: isPrivatePage((await engine.getPage(slugOf(path), { sourceId }))!) }).toEqual({ path, private: true });
  for (const path of paths(WORLD)) expect({ path, private: isPrivatePage((await engine.getPage(slugOf(path), { sourceId }))!) }).toEqual({ path, private: false });
}

const holdCodes = async (engine: BrainEngine, sourceId: string) =>
  ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).map(hold => ({ path: hold.path, code: String(hold.code) })).sort(byPath);
const heldAs = (code: string, extra: string[] = []) => [...paths(NONCANONICAL), ...extra].map(path => ({ path, code })).sort(byPath);

test('noncanonicalPrivateRequest is true exactly when the content asks for private and the parse would not store visibility: private', () => {
  const asks = (content: string) => noncanonicalPrivateRequest(content, parseMarkdown(content, 'notes/example.md').frontmatter);
  for (const [path, content] of Object.entries(NONCANONICAL)) expect({ path, asks: asks(content) }).toEqual({ path, asks: true });
  for (const [path, content] of Object.entries({ ...PRIVATE, ...WORLD })) expect({ path, asks: asks(content) }).toEqual({ path, asks: false });
  expect(noncanonicalPrivateRequest('', { Visibility: 'Private' })).toBe(true);
  expect(noncanonicalPrivateRequest('', { visibility: ['private'] })).toBe(true);
  expect(noncanonicalPrivateRequest('', { visibility: 'private' })).toBe(false);
  expect(noncanonicalPrivateRequest('', { visibility: 'world', summary: 'private' })).toBe(false);
  expect(noncanonicalPrivateRequest('', null)).toBe(false);
});

test('screenImportContent holds visibility_noncanonical only for file ingestion (holdNoncanonicalPrivate); a page or derived write screen admits it for its own guard', () => {
  const content = NONCANONICAL['notes/upper-value.md']!;
  const held = screenImportContent({ content, path: 'notes/upper-value.md', holdNoncanonicalPrivate: true });
  expect(held.status === 'refused' ? held.refusal.code : held.status).toBe('visibility_noncanonical');
  expect(screenImportContent({ content, path: 'notes/upper-value.md' }).status).toBe('importable');
  expect(screenImportContent({ content: PRIVATE['notes/canonical.md']!, path: 'notes/canonical.md', holdNoncanonicalPrivate: true }).status).toBe('importable');
});

for (const backend of backends) describe(`#7848 non-canonical private requests on file ingestion (${backend})`, () => {
  const engine = () => engines[backends.indexOf(backend)]!;

  test('repo-less gbrain import of a plain directory refuses each file that asks for private in another spelling; the rest imports unchanged', () => withEnv(env, async () => {
    const root = mkdtempSync(join(home, 'plain-'));
    writeTree(root, { ...NONCANONICAL, ...PRIVATE, ...WORLD });
    const sourceId = await newSource(engine(), root);
    const result = await runImport(engine(), [root, '--no-embed'], { sourceId });
    expect(result.imported).toBe(paths(PRIVATE).length + paths(WORLD).length);
    expect(result.failures.map(failure => failure.path).sort()).toEqual(paths(NONCANONICAL));
    await expectStored(engine(), sourceId);
    const direct = await importFile(engine(), join(root, 'notes/upper-value.md'), 'notes/upper-value.md', { noEmbed: true, sourceId });
    expect({ status: direct.status, code: direct.refusal?.code, skip_reason: direct.skip_reason }).toEqual({ status: 'skipped', code: 'visibility_noncanonical', skip_reason: 'visibility_noncanonical' });
    expect(await engine().getPage('notes/upper-value', { sourceId })).toBeNull();
  }), 180_000);

  test('classic Git sync holds each such file visibility_noncanonical, keeps an existing world page, and imports it private once fixed', () => withEnv(env, async () => {
    const root = mkdtempSync(join(home, 'classic-'));
    git(root, 'init', '-q');
    writeTree(root, { 'notes/turned.md': note('Turned') });
    commit(root, 'seed');
    const sourceId = await newSource(engine(), root);
    const sync = () => performSync(engine(), { repoPath: root, sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
    await sync();
    const before = (await engine().getPage('notes/turned', { sourceId }))!;
    expect(isPrivatePage(before)).toBe(false);
    writeTree(root, { ...NONCANONICAL, ...PRIVATE, ...WORLD, 'notes/turned.md': note('Turned', 'Visibility: Private\n') });
    commit(root, 'ask for private');
    await sync();
    expect(await holdCodes(engine(), sourceId)).toEqual(heldAs('visibility_noncanonical', ['notes/turned.md']));
    await expectStored(engine(), sourceId);
    const kept = (await engine().getPage('notes/turned', { sourceId }))!;
    expect({ hash: kept.content_hash, private: isPrivatePage(kept) }).toEqual({ hash: before.content_hash, private: false });
    writeTree(root, { 'notes/turned.md': note('Turned', 'visibility: private\n') });
    commit(root, 'canonical private');
    await sync();
    expect(await holdCodes(engine(), sourceId)).toEqual(heldAs('visibility_noncanonical'));
    expect(isPrivatePage((await engine().getPage('notes/turned', { sourceId }))!)).toBe(true);
    const doctor = await gitHeldFilesCheck(engine(), [sourceId]);
    expect(doctor.details?.visibility_noncanonical).toEqual({ held: paths(NONCANONICAL).length, stored: 0 });
  }), 180_000);

  test('doctor git_held_files counts stored pages that ask for private in another spelling, on a brain with no Git source', () => withEnv(env, async () => {
    const sourceId = await newSource(engine(), mkdtempSync(join(home, 'stored-')));
    const put = (slug: string, frontmatter: Record<string, unknown>) =>
      engine().putPage(slug, { type: 'note', title: slug, compiled_truth: 'A private note about acme-example.', frontmatter }, { sourceId });
    await put('notes/legacy-upper', { Visibility: 'Private' });
    await put('notes/legacy-list', { visibility: ['private'] });
    await put('notes/legacy-canonical', { visibility: 'private' });
    await put('notes/legacy-world', { visibility: 'world', summary: 'private' });
    const doctor = await gitHeldFilesCheck(engine(), [sourceId]);
    expect(doctor.details?.visibility_noncanonical).toEqual({ held: 0, stored: 2 });
    expect(doctor.status).toBe('warn');
    expect(doctor.message).toContain('2 stored page(s)');
  }), 180_000);
});

describe('#7848 managed brains', () => {
  for (const backend of backends) {
    const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
    const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };

    test(`[${backend}] managed Git sync holds each such file visibility_noncanonical, the rest syncs, and a fixed file imports private`, () => managedBrain(async ({ engine, root }) => {
      writeTree(root, { ...PRIVATE, ...WORLD });
      commit(root, 'seed');
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writeTree(root, NONCANONICAL);
      commit(root, 'ask for private');
      const result = await performManagedSync(engine, OPTS);
      expect((result.held ?? []).map(hold => ({ path: hold.path, code: String(hold.code) })).sort(byPath)).toEqual(heldAs('visibility_noncanonical'));
      expect(await holdCodes(engine, 'default')).toEqual(heldAs('visibility_noncanonical'));
      await expectStored(engine, 'default');
      writeTree(root, { 'notes/upper-key.md': note('Upper key', 'visibility: private\n') });
      commit(root, 'canonical private');
      await performManagedSync(engine, OPTS);
      expect((await holdCodes(engine, 'default')).map(hold => hold.path)).not.toContain('notes/upper-key.md');
      expect(isPrivatePage((await engine.getPage('notes/upper-key', { sourceId: 'default' }))!)).toBe(true);
    }, { ...(databaseUrl ? { databaseUrl } : {}), setup: ({ root }) => { git(root, 'init', '-q'); } }), 180_000);

    test(`[${backend}] managed gbrain import of a directory with no Git checkout refuses each such file; the rest imports unchanged`, () => managedBrain(async ({ engine, root }) => {
      writeTree(root, { ...NONCANONICAL, ...PRIVATE, ...WORLD });
      const result = await runImport(engine, [root, '--no-embed'], { sourceId: 'default' });
      expect(result.failures.map(failure => failure.path).sort()).toEqual(paths(NONCANONICAL));
      for (const failure of result.failures) expect(failure.error).toContain('visibility: private');
      await expectStored(engine, 'default');
    }, databaseUrl ? { databaseUrl } : {}), 180_000);
  }
});
