import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setNoLazyFetchForTests, __setPinnedWindowForTests } from '../src/core/persistence/sync-blobs.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

// GST-2331: in a partial clone, a managed sync read of an object the repository lacks fetches nothing, so the program the
// checkout's config names for object fetches (remote.origin.uploadpack) never runs. The file is held git_object_missing
// unless its working-tree bytes are the committed blob, and a blobless clone with a normal checkout still syncs every file.
// A treeless clone (--filter=tree:0) that lacks a tree of the synced commit stops the run, naming the partial clone, and a
// policy file the clone never fetched makes the source read as nobody; neither fetches.
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string) => '---\ntype: concept\ntitle: ' + title + '\n---\n\nThe body of ' + title + '.\n' + 'A line that keeps the file long enough to pair as a rename.\n'.repeat(8);
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const live = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
const holds = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []) as Array<{ path: string; code: string; message: string; meta: { blob_oid?: string } }>;
const dropObject = (root: string, oid: string) => rmSync(join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));

/** The run's refusal: what `performManagedSync` threw, or a failure when it returned. */
async function refusal(engine: BrainEngine): Promise<OperationError> {
  try { await performManagedSync(engine, OPTS); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('the sync did not stop');
}
const coverage = async (engine: BrainEngine) => (await engine.executeRaw<{ prefix: string; reason: string; detail: { problems?: Array<{ message: string }> } | null }>("SELECT prefix, reason, detail FROM access_pending_coverage WHERE source_id='default' ORDER BY prefix"));

/** A bare server holding every object of `root` and an upload-pack wrapper that leaves `marker` when Git runs it. */
function server(root: string): { url: string; uploadPack: string; marker: string } {
  const bare = join(root, '..', 'origin.git'), bin = join(root, '..', 'bin'), marker = join(root, '..', 'upload-pack-ran'), uploadPack = join(bin, 'upload-pack');
  mkdirSync(bin, { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', root, bare]);
  git(bare, 'config', 'uploadpack.allowFilter', 'true'); git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  writeFileSync(uploadPack, '#!/bin/sh\ntouch ' + marker + '\nexec git-upload-pack "$@"\n'); chmodSync(uploadPack, 0o755);
  return { url: 'file://' + bare, uploadPack, marker };
}

/** Turns the checkout into a partial clone of `server(root)` whose object fetches run the marker wrapper. */
function promisor(root: string): string {
  const { url, uploadPack, marker } = server(root);
  for (const [key, value] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'origin'], ['remote.origin.url', url],
    ['remote.origin.promisor', 'true'], ['remote.origin.partialclonefilter', 'blob:none'], ['remote.origin.uploadpack', uploadPack]]) git(root, 'config', key!, value!);
  return marker;
}

/** An upstream repository of `names` under notes/, served bare, cloned into `root` under `filter` (`checkout`: with a normal checkout). */
function bloblessClone(root: string, names: string[], checkout: boolean, filter = 'blob:none'): ReturnType<typeof server> {
  const upstream = join(root, '..', 'upstream');
  mkdirSync(join(upstream, 'notes'), { recursive: true }); git(upstream, 'init', '-q', '-b', 'main');
  for (const name of names) writeFileSync(join(upstream, 'notes', name + '.md'), note(name));
  commit(upstream, 'upstream');
  const remote = server(upstream);
  execFileSync('git', ['clone', '-q', '--filter=' + filter, ...(checkout ? [] : ['--no-checkout']), remote.url, root]);
  git(root, 'config', 'remote.origin.uploadpack', remote.uploadPack);
  rmSync(remote.marker, { force: true });
  return remote;
}

for (const backend of testBackends()) describe('[' + backend + '] managed sync in a partial clone fetches nothing (GST-2331)', () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
  beforeAll(async () => { if (databaseUrl) template = await persistencePostgresTemplate(databaseUrl); }, 120_000);
  afterAll(async () => { await template?.dispose(); });
  const brain = (body: (ctx: { engine: BrainEngine; root: string }) => Promise<void>, setup?: (root: string) => void) => managedBrain(body, { ...(template ? { open: template.clone } : {}),
    setup: ({ root }) => {
      if (setup) return setup(root);
      git(root, 'init', '-q'); mkdirSync(join(root, 'notes')); writeFileSync(join(root, 'notes/seed.md'), note('seed')); commit(root, 'seed');
    } });

  test('a missing committed blob is never fetched: identical working-tree bytes import, a differing copy is held git_object_missing naming the partial clone', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    for (const name of ['same', 'edited', 'ok']) writeFileSync(join(root, 'notes', name + '.md'), note(name));
    commit(root, 'three notes');
    const marker = promisor(root);
    const edited = git(root, 'rev-parse', 'HEAD:notes/edited.md');
    dropObject(root, git(root, 'rev-parse', 'HEAD:notes/same.md')); dropObject(root, edited);
    writeFileSync(join(root, 'notes/edited.md'), note('edited in the checkout'));
    git(root, 'update-index', '--assume-unchanged', 'notes/edited.md');
    await performManagedSync(engine, OPTS);
    expect(existsSync(marker)).toBe(false);
    const held = await holds(engine);
    expect(held.map(hold => [hold.path, hold.code])).toEqual([['notes/edited.md', 'git_object_missing']]);
    expect(held[0]!.meta.blob_oid).toBe(edited);
    expect(held[0]!.message).toContain('partial clone');
    expect(held[0]!.message).toContain('git cat-file -p ' + edited);
    expect(await live(engine)).toEqual(['notes/ok', 'notes/same', 'notes/seed']);
    await performManagedSync(engine, OPTS);
    expect(existsSync(marker)).toBe(false);
    expect((await holds(engine)).map(hold => [hold.path, hold.code])).toEqual([['notes/edited.md', 'git_object_missing']]);
  }), 240_000);

  test('a rename whose old blob is missing fetches nothing and keeps every file: the new path imports and the old page is deleted', () => brain(async ({ engine, root }) => {
    writeFileSync(join(root, 'notes/old.md'), note('moved'));
    commit(root, 'old');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    expect(await live(engine)).toEqual(['notes/old', 'notes/seed']);
    git(root, 'mv', 'notes/old.md', 'notes/new.md');
    writeFileSync(join(root, 'notes/new.md'), note('moved') + 'One more line.\n');
    commit(root, 'rename with an edit');
    const marker = promisor(root);
    dropObject(root, git(root, 'rev-parse', 'HEAD~1:notes/old.md'));
    await performManagedSync(engine, OPTS);
    expect(existsSync(marker)).toBe(false);
    expect(await holds(engine)).toEqual([]);
    expect(await live(engine)).toEqual(['notes/new', 'notes/seed']);
    expect((await engine.executeRaw<{ c: string }>("SELECT last_commit AS c FROM sources WHERE id='default'"))[0]!.c).toBe(git(root, 'rev-parse', 'HEAD'));
  }), 240_000);

  test('a blobless clone with a normal checkout syncs every file, and a later commit after a pull, without running the upload-pack program', () => {
    let remote: ReturnType<typeof server> | undefined;
    return brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      expect(existsSync(remote!.marker)).toBe(false);
      expect(await holds(engine)).toEqual([]);
      expect(await live(engine)).toEqual(['notes/a', 'notes/b', 'notes/seed']);
      const upstream = join(root, '..', 'upstream');
      writeFileSync(join(upstream, 'notes/c.md'), note('c')); writeFileSync(join(upstream, 'notes/a.md'), note('a, edited'));
      commit(upstream, 'c'); git(upstream, 'push', '-q', remote!.url, 'HEAD:main');
      git(root, 'pull', '-q', '--ff-only', 'origin', 'main');
      rmSync(remote!.marker, { force: true });
      await performManagedSync(engine, OPTS);
      expect(existsSync(remote!.marker)).toBe(false);
      expect(await holds(engine)).toEqual([]);
      expect(await live(engine)).toEqual(['notes/a', 'notes/b', 'notes/c', 'notes/seed']);
      expect((await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE source_id='default' AND slug='notes/a'"))[0]!.compiled_truth).toContain('The body of a, edited.');
      expect((await engine.executeRaw<{ c: string }>("SELECT last_commit AS c FROM sources WHERE id='default'"))[0]!.c).toBe(git(root, 'rev-parse', 'HEAD'));
    }, root => { remote = bloblessClone(root, ['seed', 'a', 'b'], true); });
  }, 240_000);

  test('a blobless clone without a checkout fetches nothing and holds every committed file git_object_missing', () => {
    let remote: ReturnType<typeof server> | undefined;
    return brain(async ({ engine, root }) => {
      await performManagedSync(engine, OPTS);
      expect(existsSync(remote!.marker)).toBe(false);
      const held = await holds(engine);
      expect(held.map(hold => [hold.path, hold.code]).sort()).toEqual([['notes/a.md', 'git_object_missing'], ['notes/seed.md', 'git_object_missing']]);
      expect(held[0]!.message).toContain('partial clone');
      expect(await live(engine)).toEqual([]);
    }, root => { remote = bloblessClone(root, ['seed', 'a'], false); });
  }, 240_000);
  test('a missing blob is fetched on neither read path, nor by a Git that ignores GIT_NO_LAZY_FETCH: the cat-file --batch window and the git show fallback each hold it', async () => {
    for (const arm of [{ window: null, lazyOff: true }, { window: 0, lazyOff: true }, { window: null, lazyOff: false }, { window: 0, lazyOff: false }]) await brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writeFileSync(join(root, 'notes/missing.md'), note('missing'));
      commit(root, 'missing');
      const marker = promisor(root);
      const oid = git(root, 'rev-parse', 'HEAD:notes/missing.md');
      dropObject(root, oid);
      writeFileSync(join(root, 'notes/missing.md'), note('missing, edited in the checkout'));
      git(root, 'update-index', '--assume-unchanged', 'notes/missing.md');
      const restoreWindow = __setPinnedWindowForTests(arm.window), restoreLazy = __setNoLazyFetchForTests(arm.lazyOff);
      try { await performManagedSync(engine, OPTS); } finally { restoreLazy(); restoreWindow(); }
      expect(existsSync(marker)).toBe(false);
      const held = await holds(engine);
      expect(held.map(hold => [hold.path, hold.code])).toEqual([['notes/missing.md', 'git_object_missing']]);
      expect(held[0]!.message).toContain('partial clone');
      expect(held[0]!.message).toContain('git cat-file -p ' + oid);
      expect(await live(engine)).toEqual(['notes/seed']);
    });
  }, 240_000);

  test('a treeless clone without a checkout stops the run naming the partial clone, fetches nothing, and syncs once the user fetches the trees', () => {
    let remote: ReturnType<typeof server> | undefined;
    return brain(async ({ engine, root }) => {
      const stopped = await refusal(engine);
      expect(existsSync(remote!.marker)).toBe(false);
      expect(stopped.code).toBe('git_object_missing');
      expect(stopped.suggestion).toContain('partial clone');
      const head = git(root, 'rev-parse', 'HEAD');
      expect(stopped.fix?.argv).toEqual(['git', '-C', root, 'ls-tree', '-r', '-d', head]);
      expect(await live(engine)).toEqual([]);
      expect((await refusal(engine)).code).toBe('git_object_missing');
      expect(existsSync(remote!.marker)).toBe(false);
      const [command, ...args] = stopped.fix?.argv ?? [];
      execFileSync(command!, args, { stdio: 'ignore' });
      rmSync(remote!.marker, { force: true });
      await performManagedSync(engine, OPTS);
      expect(existsSync(remote!.marker)).toBe(false);
      expect((await holds(engine)).map(hold => [hold.path, hold.code]).sort()).toEqual([['notes/a.md', 'git_object_missing'], ['notes/seed.md', 'git_object_missing']]);
    }, root => { remote = bloblessClone(root, ['seed', 'a'], false, 'tree:0'); });
  }, 240_000);

  test('a treeless clone whose HEAD moved to a fetched commit without a checkout stops the run and deletes nothing; a pull syncs without fetching', () => {
    let remote: ReturnType<typeof server> | undefined;
    return brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      expect(existsSync(remote!.marker)).toBe(false);
      const upstream = join(root, '..', 'upstream');
      mkdirSync(join(upstream, 'deep', 'er'), { recursive: true });
      writeFileSync(join(upstream, 'deep/er/c.md'), note('c')); rmSync(join(upstream, 'notes/b.md'));
      commit(upstream, 'c'); git(upstream, 'push', '-q', remote!.url, 'HEAD:main');
      git(root, 'fetch', '-q', 'origin'); git(root, 'reset', '-q', '--soft', 'origin/main');
      rmSync(remote!.marker, { force: true });
      const stopped = await refusal(engine);
      expect(existsSync(remote!.marker)).toBe(false);
      expect(stopped.code).toBe('git_object_missing');
      expect(stopped.suggestion).toContain('partial clone');
      expect(stopped.fix?.argv).toEqual(['git', '-C', root, 'ls-tree', '-r', '-d', git(root, 'rev-parse', 'HEAD')]);
      expect(await live(engine)).toEqual(['notes/a', 'notes/b', 'notes/seed']);
      git(root, 'reset', '-q', '--hard', 'HEAD');
      rmSync(remote!.marker, { force: true });
      await performManagedSync(engine, OPTS);
      expect(existsSync(remote!.marker)).toBe(false);
      expect(await holds(engine)).toEqual([]);
      expect(await live(engine)).toEqual(['deep/er/c', 'notes/a', 'notes/seed']);
      writeFileSync(join(upstream, 'notes/d.md'), note('d')); commit(upstream, 'd'); git(upstream, 'push', '-q', remote!.url, 'HEAD:main');
      git(root, 'pull', '-q', '--ff-only', 'origin', 'main');
      rmSync(remote!.marker, { force: true });
      await performManagedSync(engine, OPTS);
      expect(existsSync(remote!.marker)).toBe(false);
      expect(await live(engine)).toEqual(['deep/er/c', 'notes/a', 'notes/d', 'notes/seed']);
      expect(await coverage(engine)).toEqual([]);
    }, root => { remote = bloblessClone(root, ['seed', 'a', 'b'], true, 'tree:0'); });
  }, 240_000);

  test('folder rules whose history the partial clone never fetched are not fetched: the source reads as nobody, naming the partial clone, until the user fetches them', () => {
    let remote: ReturnType<typeof server> | undefined;
    return brain(async ({ engine, root }) => {
      await engine.executeRaw("INSERT INTO access_members (id) VALUES ('alice-example')");
      await performManagedSync(engine, OPTS);
      expect(existsSync(remote!.marker)).toBe(false);
      const blocked = await coverage(engine);
      expect(blocked.map(row => [row.prefix, row.reason])).toEqual([['', 'invalid']]);
      expect(blocked[0]!.detail?.problems?.[0]?.message).toContain('partial clone');
      expect(blocked[0]!.detail?.problems?.[0]?.message).toContain('git -C ' + root + ' log --first-parent -p HEAD -- .gbrain/access.yml');
      expect(await live(engine)).toEqual(['hr/x']);
      await performManagedSync(engine, OPTS);
      expect(existsSync(remote!.marker)).toBe(false);
      git(root, 'log', '--first-parent', '-p', 'HEAD', '--', '.gbrain/access.yml');
      await performManagedSync(engine, OPTS);
      expect(await coverage(engine)).toEqual([]);
    }, root => {
      const upstream = join(root, '..', 'upstream');
      mkdirSync(join(upstream, '.gbrain'), { recursive: true }); mkdirSync(join(upstream, 'hr'), { recursive: true }); git(upstream, 'init', '-q', '-b', 'main');
      const rule = (id: string) => '  - id: ' + id + '\n    prefix: ' + id + '/\n    readable_by: [alice-example]\n';
      writeFileSync(join(upstream, 'hr/x.md'), note('x')); writeFileSync(join(upstream, '.gbrain/access.yml'), 'version: 1\nrules:\n' + rule('hr')); commit(upstream, 'one');
      writeFileSync(join(upstream, '.gbrain/access.yml'), 'version: 1\nrules:\n' + rule('hr') + rule('ops')); commit(upstream, 'two');
      remote = server(upstream);
      execFileSync('git', ['clone', '-q', '--filter=blob:none', remote.url, root]);
      git(root, 'config', 'remote.origin.uploadpack', remote.uploadPack);
      rmSync(remote.marker, { force: true });
    });
  }, 240_000);
});
