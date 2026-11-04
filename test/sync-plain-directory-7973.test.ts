/**
 * #7973: a plain directory registered with `sources add --path <dir> --force` (no Git checkout at or above it)
 * syncs without Git: the run imports its files into the source the way `gbrain import` does on a repo-less brain.
 * Fails when: sync dies with a raw `git rev-parse` internal_error, a dry run writes, a removed file deletes its
 * page, `sources add` and sync disagree about what a forced plain directory does, or a Git-synced source whose
 * checkout is gone is imported as plain (its database-only edits would be overwritten and deletions stop propagating).
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { performSync } from '../src/commands/sync.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';

const backends: Array<string | undefined> = [undefined, ...(process.env.DATABASE_URL ? [process.env.DATABASE_URL] : [])];
const engineName = (url: string | undefined) => url ? 'postgres' : 'pglite';
const person = (name: string, body: string) => `---\ntitle: "${name}"\ntype: "person"\n---\n\n# ${name}\n\n${body}\n`;

/** A managed brain with a forced plain-directory source holding one person page, registered the way `sources add --force` does. */
async function withPlainSource(url: string | undefined, run: (brain: ManagedBrain, dir: string) => Promise<void>): Promise<void> {
  await managedBrain(async brain => {
    const dir = join(brain.root, '..', 'plain-notes');
    mkdirSync(join(dir, 'people'), { recursive: true });
    writeFileSync(join(dir, 'people', 'alice-example.md'), person('Alice Example', 'Works at acme-example.'));
    expect(await runManagedSourceLifecycle(brain.engine, { operation: 'add', sourceId: 'source-a', path: dir })).toMatchObject({ state: 'committed' });
    await run(brain, dir);
  }, { databaseUrl: url });
}

describe.each(backends.map(url => [engineName(url), url] as const))('plain-directory sync (%s)', (_name, url) => {
  test('a forced plain directory syncs its files into the source without Git', () => withPlainSource(url, async ({ engine }, dir) => {
    const first = await performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true });
    expect(first).toMatchObject({ status: 'synced', added: 1, deleted: 0 });
    expect((await engine.getPage('people/alice-example', { sourceId: 'source-a' }))?.compiled_truth).toContain('Works at acme-example.');
    const [row] = await engine.executeRaw<{ last_sync_at: unknown }>("SELECT last_sync_at FROM sources WHERE id='source-a'");
    expect(row?.last_sync_at).not.toBeNull();

    writeFileSync(join(dir, 'people', 'alice-example.md'), person('Alice Example', 'Now works at widget-co.'));
    writeFileSync(join(dir, 'people', 'charlie-example.md'), person('Charlie Example', 'Advises acme-example.'));
    expect(await performSync(engine, { sourceId: 'source-a', noEmbed: true })).toMatchObject({ status: 'synced', added: 2 });
    expect((await engine.getPage('people/alice-example', { sourceId: 'source-a' }))?.compiled_truth).toContain('Now works at widget-co.');
    expect(await engine.getPage('people/charlie-example', { sourceId: 'source-a' })).not.toBeNull();

    rmSync(join(dir, 'people', 'charlie-example.md'));
    expect(await performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true })).toMatchObject({ status: 'synced', added: 0, deleted: 0 });
    expect(await engine.getPage('people/charlie-example', { sourceId: 'source-a' })).not.toBeNull();
  }), 180_000);

  test('the managed Git path refuses the plain root with a typed caller error naming the working command', () => withPlainSource(url, async ({ engine }) => {
    await expect(resolveManagedSyncContext(engine, { sourceId: 'source-a', noPull: true })).rejects.toMatchObject({
      code: 'sync_not_applicable', reason: 'plain_directory', fix: { argv: ['gbrain', 'sync', '--source', 'source-a'] } });
  }), 180_000);

  test('a dry run counts the files and writes nothing', () => withPlainSource(url, async ({ engine }) => {
    expect(await performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true, dryRun: true })).toMatchObject({ status: 'dry_run', added: 1 });
    expect(await engine.getPage('people/alice-example', { sourceId: 'source-a' })).toBeNull();
    const [row] = await engine.executeRaw<{ last_sync_at: unknown }>("SELECT last_sync_at FROM sources WHERE id='source-a'");
    expect(row?.last_sync_at).toBeNull();
  }), 180_000);
});

test('sources add without --force names what sync does with a forced plain directory', () => managedBrain(async ({ engine, root }) => {
  const dir = join(root, '..', 'plain-notes');
  mkdirSync(dir, { recursive: true });
  await expect(runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'source-a', path: dir, requireGitContent: true }))
    .rejects.toMatchObject({ code: 'not_a_git_repo', suggestion: expect.stringContaining('sync then imports its files without Git') });
}), 120_000);

describe('classic brain', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
  });

  test('a classic (unmanaged) brain syncs a forced plain directory the same way', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-plain-classic-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const dir = join(home, 'plain-notes'); mkdirSync(join(dir, 'people'), { recursive: true });
        writeFileSync(join(dir, 'people', 'alice-example.md'), person('Alice Example', 'Works at acme-example.'));
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('source-a','source-a',$1,'{}')", [dir]);
        expect(await performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true })).toMatchObject({ status: 'synced', added: 1 });
        expect((await engine.getPage('people/alice-example', { sourceId: 'source-a' }))?.compiled_truth).toContain('Works at acme-example.');
        const [row] = await engine.executeRaw<{ last_sync_at: unknown }>("SELECT last_sync_at FROM sources WHERE id='source-a'");
        expect(row?.last_sync_at).not.toBeNull();
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);

  test('a Git-synced source whose checkout is gone refuses instead of importing over the database', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-plain-lost-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const dir = join(home, 'lost-checkout'); mkdirSync(join(dir, 'people'), { recursive: true });
        writeFileSync(join(dir, 'people', 'bob-example.md'), person('Bob Example', 'Works at acme-example.'));
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config,last_commit) VALUES('source-b','source-b',$1,'{}','0123456789abcdef0123456789abcdef01234567')", [dir]);
        await expect(performSync(engine, { sourceId: 'source-b', noPull: true, noEmbed: true })).rejects.toMatchObject({
          code: 'sync_not_applicable', reason: 'checkout_missing', fix: { actor: 'user', ask_user: true } });
        expect(await engine.getPage('people/bob-example', { sourceId: 'source-b' })).toBeNull();
        const [row] = await engine.executeRaw<{ last_sync_at: unknown }>("SELECT last_sync_at FROM sources WHERE id='source-b'");
        expect(row?.last_sync_at).toBeNull();
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});
