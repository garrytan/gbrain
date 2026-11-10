import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setCheckAttrSourceForTests, __setNoLazyFetchForTests, __setPinnedWindowForTests } from '../src/core/persistence/sync-blobs.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { filterOwnedRefusal } from '../src/core/persistence/sync-entry-fault.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

// GST-2312 (#9024): a committed file a Git filter owns (git-crypt, any clean/smudge driver) is held alone under
// content_filter_owned; the rest of the source imports, the watermark moves, and no filter program ever runs.
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string) => '---\ntype: concept\ntitle: ' + title + '\n---\n\nThe body of ' + title + '.\n';
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const live = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
const holds = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []) as Array<{ path: string; code: string; message: string }>;

/**
 * A filter `secret` on secret/** whose clean stores base64 (after git-crypt's header when `gitCrypt`) and whose smudge
 * leaves a marker, and a `core.fsmonitor` that leaves `<marker>.fsmonitor` (the test's own Git calls switch it off).
 */
function filtered(root: string, gitCrypt: boolean): string {
  const bin = join(root, '..', 'bin'), marker = join(root, '..', 'filter-ran');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'fsmonitor'), '#!/bin/sh\ntouch ' + marker + '.fsmonitor\nexit 1\n'); chmodSync(join(bin, 'fsmonitor'), 0o755);
  git(root, 'config', 'core.fsmonitor', join(bin, 'fsmonitor'));
  writeFileSync(join(bin, 'clean'), '#!/bin/sh\ntouch ' + marker + '.clean\n' + (gitCrypt ? "printf '\\000GITCRYPT\\000'; " : '') + 'base64\n');
  writeFileSync(join(bin, 'smudge'), '#!/bin/sh\ntouch ' + marker + '\n' + (gitCrypt ? 'tail -c +11 | ' : '') + 'base64 -d\n');
  chmodSync(join(bin, 'clean'), 0o755); chmodSync(join(bin, 'smudge'), 0o755);
  git(root, 'config', 'filter.secret.clean', join(bin, 'clean')); git(root, 'config', 'filter.secret.smudge', join(bin, 'smudge'));
  writeFileSync(join(root, '.gitattributes'), 'secret/** filter=secret\n');
  mkdirSync(join(root, 'secret'));
  writeFileSync(join(root, 'secret/one.md'), note('one')); writeFileSync(join(root, 'ok.md'), note('ok'));
  commit(root, 'filtered');
  return marker;
}

for (const backend of testBackends()) describe('[' + backend + '] a committed file a Git filter owns (#9024)', () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
  beforeAll(async () => { if (databaseUrl) template = await persistencePostgresTemplate(databaseUrl); }, 120_000);
  afterAll(async () => { await template?.dispose(); });
  const brain = (body: (ctx: { engine: BrainEngine; root: string }) => Promise<void>) => managedBrain(body, { ...(template ? { open: template.clone } : {}),
    setup: ({ root }) => { git(root, 'init', '-q'); writeFileSync(join(root, 'seed.md'), note('seed')); commit(root, 'seed'); } });

  for (const gitCrypt of [true, false]) for (const window of [null, 0] as const) {
    test((gitCrypt ? 'git-crypt' : 'clean/smudge') + ' blob, ' + (window === 0 ? 'git show' : 'cat-file --batch') + ' read: held alone, the rest imports, no filter runs', () => brain(async ({ engine, root }) => {
      const restore = __setPinnedWindowForTests(window);
      try {
        expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
        const marker = filtered(root, gitCrypt);
        expect(existsSync(marker + '.clean')).toBe(true);
        await performManagedSync(engine, OPTS);
        const held = (await holds(engine)).filter(hold => hold.path === 'secret/one.md');
        expect(held.map(hold => hold.code)).toEqual(['content_filter_owned']);
        expect(held[0]!.message).toContain("gbrain does not run a repository's filter programs during sync");
        expect(held[0]!.message).toContain(gitCrypt ? 'encrypted with git-crypt' : 'stored through the Git filter "secret"');
        expect(held[0]!.message).not.toMatch(/gbrain config set|--allow/);
        expect(await live(engine)).toEqual(['ok', 'seed']);
        writeFileSync(join(root, 'ok2.md'), note('ok2')); commit(root, 'ok2');
        await performManagedSync(engine, OPTS);
        expect(await live(engine)).toEqual(['ok', 'ok2', 'seed']);
        expect((await engine.executeRaw<{ c: string }>("SELECT last_commit AS c FROM sources WHERE id='default'"))[0]!.c).toBe(git(root, 'rev-parse', 'HEAD'));
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(marker + '.fsmonitor')).toBe(false);
      } finally { restore(); }
    }), 240_000);
  }

  test('sync.holds=fail refuses the run with content_filter_owned and imports nothing from it', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.holds', 'fail');
    const marker = filtered(root, true);
    const error = await performManagedSync(engine, OPTS).then(() => null, (caught: { code?: string; message?: string }) => caught);
    expect(error?.code).toBe('content_filter_owned');
    expect(await live(engine)).not.toContain('secret/one');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(marker + '.fsmonitor')).toBe(false);
  }), 240_000);

  test('a clean/smudge driver under sync.holds=fail refuses the run with content_filter_owned', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.holds', 'fail');
    const marker = filtered(root, false);
    const error = await performManagedSync(engine, OPTS).then(() => null, (caught: { code?: string }) => caught);
    expect(error?.code).toBe('content_filter_owned');
    expect(await live(engine)).not.toContain('secret/one');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(marker + '.fsmonitor')).toBe(false);
  }), 240_000);

  test('committing the file without the filter clears the hold and imports its text', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    filtered(root, false);
    await performManagedSync(engine, OPTS);
    expect((await holds(engine)).filter(hold => hold.path === 'secret/one.md').map(hold => hold.code)).toEqual(['content_filter_owned']);
    git(root, 'rm', '-q', '--cached', 'secret/one.md'); writeFileSync(join(root, '.gitattributes'), ''); commit(root, 'unfiltered');
    await performManagedSync(engine, OPTS);
    expect((await holds(engine)).filter(hold => hold.path === 'secret/one.md')).toEqual([]);
    expect(await live(engine)).toContain('secret/one');
  }), 240_000);

  test('a blob with git-crypt\'s header and no filter attribute is held content_filter_owned', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'locked.md'), Buffer.concat([Buffer.from('\0GITCRYPT\0'), Buffer.from('c2VjcmV0Cg==')]));
    commit(root, 'locked');
    await performManagedSync(engine, OPTS);
    expect((await holds(engine)).filter(hold => hold.path === 'locked.md').map(hold => hold.code)).toEqual(['content_filter_owned']);
  }), 240_000);

  test('a filter attribute whose driver no config defines still holds the file, naming the attribute and retry-held', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, '.gitattributes'), 'notes/** filter=unconfigured\n');
    mkdirSync(join(root, 'notes')); writeFileSync(join(root, 'notes/plain.md'), note('plain'));
    commit(root, 'unconfigured filter');
    await performManagedSync(engine, OPTS);
    const held = (await holds(engine)).filter(hold => hold.path === 'notes/plain.md');
    expect(held.map(hold => hold.code)).toEqual(['content_filter_owned']);
    expect(held[0]!.message).toContain('remove the filter attribute from .gitattributes');
    expect(held[0]!.message).toContain('gbrain sources retry-held default');
    expect(await live(engine)).not.toContain('notes/plain');
    writeFileSync(join(root, '.gitattributes'), ''); commit(root, 'drop the attribute');
    await performManagedSync(engine, OPTS);
    expect((await holds(engine)).filter(hold => hold.path === 'notes/plain.md').map(hold => hold.code)).toEqual(['content_filter_owned']);
    await retryHeld(engine, 'default');
    await performManagedSync(engine, OPTS);
    expect((await holds(engine)).filter(hold => hold.path === 'notes/plain.md')).toEqual([]);
    expect(await live(engine)).toContain('notes/plain');
  }), 240_000);

  test('the stop path (nothing held) does not tell the user to run retry-held', () => {
    expect(filterOwnedRefusal('a.md', 'text', 'secret', 'default', false)!.message).not.toContain('retry-held');
    expect(filterOwnedRefusal('a.md', 'text', 'secret', 'default', true)!.message).toContain('gbrain sources retry-held default');
  });

  for (const source of [true, false]) for (const lazyOff of [true, false]) {
    test('a partial clone missing the commit\'s .gitattributes holds the file git_object_missing and fetches nothing (' + (source ? 'check-attr --source' : 'git before 2.40: a temporary index') + (lazyOff ? '' : ', git before 2.45: no GIT_NO_LAZY_FETCH') + ')', () => brain(async ({ engine, root }) => {
      const restore = __setCheckAttrSourceForTests(source), restoreLazy = __setNoLazyFetchForTests(lazyOff);
      try {
        expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
        const marker = filtered(root, false);
        const server = join(root, '..', 'origin.git'), uploadPack = join(root, '..', 'bin', 'upload-pack');
        execFileSync('git', ['clone', '-q', '--bare', root, server]);
        git(server, 'config', 'uploadpack.allowFilter', 'true'); git(server, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
        writeFileSync(uploadPack, '#!/bin/sh\ntouch ' + marker + '.upload-pack\nexec git-upload-pack "$@"\n'); chmodSync(uploadPack, 0o755);
        for (const [key, value] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'origin'], ['remote.origin.url', 'file://' + server],
          ['remote.origin.promisor', 'true'], ['remote.origin.partialclonefilter', 'blob:none'], ['remote.origin.uploadpack', uploadPack]]) git(root, 'config', key!, value!);
        // Every object but the .gitattributes blob goes into a promisor pack, as in a real partial clone that never fetched it.
        const oid = git(root, 'rev-parse', 'HEAD:.gitattributes');
        const objects = git(root, 'rev-list', '--objects', '--all').split('\n').map(line => line.split(' ')[0]).filter(object => object !== oid);
        const pack = execFileSync('git', ['-C', root, 'pack-objects', '-q', join(root, '.git', 'objects', 'pack', 'pack')], { input: objects.join('\n') + '\n', encoding: 'utf8' }).trim();
        writeFileSync(join(root, '.git', 'objects', 'pack', 'pack-' + pack + '.promisor'), '');
        git(root, 'prune-packed');
        rmSync(join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
        await performManagedSync(engine, OPTS);
        expect(existsSync(marker + '.upload-pack')).toBe(false);
        // The root .gitattributes applies to every path, so both files of the commit are held; the seed page stays.
        const held = (await holds(engine)).filter(hold => hold.path === 'secret/one.md' || hold.path === 'ok.md').sort((a, b) => a.path.localeCompare(b.path));
        expect(held.map(hold => [hold.path, hold.code])).toEqual([['ok.md', 'git_object_missing'], ['secret/one.md', 'git_object_missing']]);
        expect(held[1]!.message).toContain('partial clone');
        expect(held[1]!.message).toContain(oid);
        expect(await live(engine)).toEqual(['seed']);
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(marker + '.fsmonitor')).toBe(false);
      } finally { restore(); restoreLazy(); }
    }), 240_000);
  }

  for (const source of [true, false]) {
    test('the filter attribute is read at the synced commit, not from an uncommitted .gitattributes (' + (source ? 'check-attr --source' : 'git before 2.40: a temporary index') + ')', () => brain(async ({ engine, root }) => {
      const restore = __setCheckAttrSourceForTests(source);
      try {
        expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
        const marker = filtered(root, false);
        writeFileSync(join(root, '.gitattributes'), '');
        await performManagedSync(engine, OPTS);
        expect((await holds(engine)).filter(hold => hold.path === 'secret/one.md').map(hold => hold.code)).toEqual(['content_filter_owned']);
        expect(await live(engine)).toEqual(['ok', 'seed']);
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(marker + '.fsmonitor')).toBe(false);
      } finally { restore(); }
    }), 240_000);
  }

  test('a Git LFS path is not held content_filter_owned (its pointers keep their own handling)', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, '.gitattributes'), 'big/** filter=lfs diff=lfs merge=lfs -text\n');
    mkdirSync(join(root, 'big')); writeFileSync(join(root, 'big/two.md'), note('two'));
    git(root, 'config', 'filter.lfs.required', 'false');
    commit(root, 'lfs path');
    await performManagedSync(engine, OPTS);
    expect((await holds(engine)).filter(hold => hold.code === 'content_filter_owned')).toEqual([]);
  }), 240_000);
});
