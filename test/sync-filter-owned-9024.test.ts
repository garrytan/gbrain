import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setPinnedWindowForTests } from '../src/core/persistence/sync-blobs.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

// GST-2312 (#9024): a committed file a Git filter owns (git-crypt, any clean/smudge driver) is held alone under
// content_filter_owned; the rest of the source imports, the watermark moves, and no filter program ever runs.
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string) => '---\ntype: concept\ntitle: ' + title + '\n---\n\nThe body of ' + title + '.\n';
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const live = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
const holds = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []) as Array<{ path: string; code: string; message: string }>;

/** A filter `secret` on secret/** whose clean stores base64 (after git-crypt's header when `gitCrypt`) and whose smudge leaves a marker. */
function filtered(root: string, gitCrypt: boolean): string {
  const bin = join(root, '..', 'bin'), marker = join(root, '..', 'filter-ran');
  mkdirSync(bin, { recursive: true });
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
  }), 240_000);

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
