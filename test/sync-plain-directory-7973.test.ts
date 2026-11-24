/**
 * #7973: a plain directory registered with `sources add --path <dir> --force` (no Git checkout at or above it)
 * syncs without Git: the run imports its files into the source the way `gbrain import` does on a repo-less brain.
 * Fails when: sync dies with a raw `git rev-parse` internal_error, a dry run writes, a removed file stays searchable,
 * `sources add` and sync disagree about what a forced plain directory does, or a Git-synced source whose
 * checkout is gone is imported as plain (its database-only edits would be overwritten and deletions stop propagating).
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { performSync } from '../src/commands/sync.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { runImport } from '../src/commands/import.ts';
import { randomUUID } from 'node:crypto';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { createFileWatcherSource } from '../src/core/ingestion/sources/file-watcher.ts';
import { IngestionTestHarness } from '../src/core/ingestion/test-harness.ts';
import { makeIngestCaptureHandler } from '../src/core/minions/handlers/ingest-capture.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';

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

async function putPerson(ctx: ManagedBrain['ctx'], engine: ManagedBrain['engine'], body: string): Promise<void> {
  const snapshot = await engine.readPageSnapshot('people/alice-example', { sourceId: 'source-a' });
  const edit = await submitPageMutation(ctx, { operation: 'put_page', params: { source_id: 'source-a', slug: 'people/alice-example', request_id: randomUUID(),
    expected_revision: snapshot!.revision, content: person('Alice Example', body) }, waitMs: 30_000 });
  expect(edit.state).toBe('committed');
}

describe.each(backends.map(url => [engineName(url), url] as const))('plain-directory sync (%s)', (_name, url) => {
  test('an unchanged file never overwrites a database-only edit (#8079)', () => withPlainSource(url, async ({ engine, ctx }, dir) => {
    const sync = () => performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true });
    const body = async () => (await engine.getPage('people/alice-example', { sourceId: 'source-a' }))?.compiled_truth;
    expect((await sync()).status).toBe('synced');
    await engine.setConfig('sync.write_through', 'false');
    await putPerson(ctx, engine, 'Database-only correction: works at widget-co.');
    await engine.setConfig('sync.write_through', 'true');
    const file = join(dir, 'people/alice-example.md');
    const disk = readFileSync(file, 'utf8');
    expect(await sync()).toMatchObject({ status: 'blocked_by_failures', failedFiles: 1 });
    expect(await body()).toContain('Database-only correction');
    expect(readFileSync(file, 'utf8')).toBe(disk);
    // Refused before admission: autopilot's interval syncs leave no failed write behind.
    expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE state<>'committed'")).toHaveLength(0);
    // A file edit made after the database edit is refused too, and a healthy sibling still imports in the same run.
    writeFileSync(file, person('Alice Example', 'A conflicting file edit.'));
    writeFileSync(join(dir, 'people/charlie-example.md'), person('Charlie Example', 'A healthy sibling.'));
    expect(await sync()).toMatchObject({ status: 'blocked_by_failures', added: 1, failedFiles: 1 });
    expect(await body()).toContain('Database-only correction');
    expect((await engine.getPage('people/charlie-example', { sourceId: 'source-a' }))?.compiled_truth).toContain('healthy sibling');
    // Bringing the file in line with the page resolves it; later file edits sync again.
    const page = await engine.readPageSnapshot('people/alice-example', { sourceId: 'source-a' });
    writeFileSync(file, serializePageToMarkdown(page!.page, page!.tags));
    expect(await sync()).toMatchObject({ status: 'synced', added: 0 });
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '30 days' WHERE op='plain-directory-agreed'");
    await purgeStaleCheckpoints(engine);
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='plain-directory-agreed'")).toHaveLength(1);
    writeFileSync(file, person('Alice Example', 'A file edit after the two sides agreed.'));
    expect(await sync()).toMatchObject({ status: 'synced', added: 1 });
    expect(await body()).toContain('after the two sides agreed');
  }), 180_000);

  test('an explicit import of the file chooses the file over a database-only edit (#8079)', () => withPlainSource(url, async ({ engine, ctx }, dir) => {
    const sync = () => performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true });
    await sync();
    await engine.setConfig('sync.write_through', 'false');
    await putPerson(ctx, engine, 'Database-only correction.');
    await engine.setConfig('sync.write_through', 'true');
    const file = join(dir, 'people/alice-example.md');
    writeFileSync(file, person('Alice Example', 'The reviewed file wins.'));
    expect(await sync()).toMatchObject({ status: 'blocked_by_failures', failedFiles: 1 });
    expect((await runImport(engine, [file, '--no-embed'], { sourceId: 'source-a' })).errors).toBe(0);
    expect((await engine.getPage('people/alice-example', { sourceId: 'source-a' }))?.compiled_truth).toContain('reviewed file wins');
    writeFileSync(file, person('Alice Example', 'A later file edit.'));
    expect(await sync()).toMatchObject({ status: 'synced', added: 1 });
    expect(await sync()).toMatchObject({ status: 'synced', added: 0 });
  }), 180_000);

  test('a file edit after a page write that wrote the file still syncs (#8079)', () => withPlainSource(url, async ({ engine, ctx }, dir) => {
    const sync = () => performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true });
    await sync();
    await putPerson(ctx, engine, 'Written through to the file.');
    const file = join(dir, 'people/alice-example.md');
    expect(readFileSync(file, 'utf8')).toContain('Written through to the file.');
    writeFileSync(file, person('Alice Example', 'A person edits the file before the next sync.'));
    expect(await sync()).toMatchObject({ status: 'synced', added: 1 });
    expect((await engine.getPage('people/alice-example', { sourceId: 'source-a' }))?.compiled_truth).toContain('edits the file before the next sync');
  }), 180_000);

  test('a file matched to the page in a noncanonical form resolves the conflict (#8079)', () => withPlainSource(url, async ({ engine, ctx }, dir) => {
    const sync = () => performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true });
    await sync();
    await engine.setConfig('sync.write_through', 'false');
    await putPerson(ctx, engine, 'Database-only correction.');
    await engine.setConfig('sync.write_through', 'true');
    const file = join(dir, 'people/alice-example.md');
    const page = await engine.readPageSnapshot('people/alice-example', { sourceId: 'source-a' });
    writeFileSync(file, `${serializePageToMarkdown(page!.page, page!.tags)}\n\n\n`);
    expect(await sync()).toMatchObject({ status: 'synced' });
    writeFileSync(file, person('Alice Example', 'A file edit after the file was matched.'));
    expect(await sync()).toMatchObject({ status: 'synced', added: 1 });
    expect((await engine.getPage('people/alice-example', { sourceId: 'source-a' }))?.compiled_truth).toContain('after the file was matched');
  }), 180_000);

  test('a file edit after an import that left its file untouched still syncs (#8079)', () => withPlainSource(url, async ({ engine }, dir) => {
    const sync = () => performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true });
    expect(await sync()).toMatchObject({ status: 'synced', added: 1 });
    // A streamed import (a body over the single-string limit) validates its canonical file without rewriting it, so its
    // receipt says the import came from the file but records no file write.
    const [receipt] = await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
      return tx.executeRaw<{ id: string }>(`UPDATE persistence_requests r
        SET outcome = (r.outcome - 'persistence' - 'write_through') || '{"persistence":{"mode":"database"},"write_through":{"written":false,"skipped":"no_repo_configured"}}'::jsonb
        FROM pages p WHERE p.slug='people/alice-example' AND p.source_id='source-a' AND r.id=p.revision_write_request_id
          AND r.outcome->>'imported_file'='true' RETURNING r.id`);
    });
    expect(receipt).toBeDefined();
    writeFileSync(join(dir, 'people/alice-example.md'), person('Alice Example', 'An ordinary file edit.'));
    expect(await sync()).toMatchObject({ status: 'synced', added: 1 });
    expect((await engine.getPage('people/alice-example', { sourceId: 'source-a' }))?.compiled_truth).toContain('An ordinary file edit.');
  }), 180_000);
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
    expect(await performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true })).toMatchObject({ status: 'synced', added: 0, deleted: 1 });
    expect(await engine.searchKeyword('Advises acme-example', { sourceId: 'source-a' })).toHaveLength(0);
    expect(await engine.getPage('people/charlie-example', { sourceId: 'source-a' })).toBeNull();
  }), 180_000);

  test('a managed brain withdraws a deleted plain-directory file using its receipt', () => withPlainSource(url, async ({ engine }, dir) => {
    const sync = () => performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true });
    expect(await sync()).toMatchObject({ added: 1, deleted: 0 });
    rmSync(join(dir, 'people/alice-example.md'));
    // Keep the root visibly populated so this exercises per-file deletion, not the empty-volume guard.
    writeFileSync(join(dir, 'keep.txt'), 'Volume remains mounted.');
    expect(await sync()).toMatchObject({ deleted: 1 });
    expect(await engine.getPage('people/alice-example', { sourceId: 'source-a' })).toBeNull();
    expect(await engine.searchKeyword('acme-example', { sourceId: 'source-a' })).toHaveLength(0);
  }), 180_000);

  test('rename withdraws the old file and imports the new one', () => withPlainSource(url, async ({ engine }, dir) => {
    const sync = () => performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true });
    await sync();
    expect(await engine.searchKeyword('acme-example', { sourceId: 'source-a' })).not.toHaveLength(0);
    renameSync(join(dir, 'people/alice-example.md'), join(dir, 'people/renamed-example.md'));
    expect(await sync()).toMatchObject({ status: 'synced', added: 1, deleted: 1 });
    expect(await engine.getPage('people/alice-example', { sourceId: 'source-a' })).toBeNull();
    expect(await engine.getPage('people/renamed-example', { sourceId: 'source-a' })).not.toBeNull();
    expect((await engine.searchKeyword('acme-example', { sourceId: 'source-a' })).map(hit => hit.slug)).toEqual(['people/renamed-example']);
  }), 180_000);

  test('missing file never withdraws a newer database-only edit', () => withPlainSource(url, async ({ engine, ctx }, dir) => {
    await performSync(engine, { sourceId: 'source-a', noEmbed: true });
    await engine.setConfig('sync.write_through', 'false');
    await putPerson(ctx, engine, 'Only copy of a database correction.');
    await engine.setConfig('sync.write_through', 'true');
    rmSync(join(dir, 'people/alice-example.md'));
    expect(await performSync(engine, { sourceId: 'source-a', noEmbed: true })).toMatchObject({ deleted: 0 });
    expect((await engine.getPage('people/alice-example', { sourceId: 'source-a' }))?.compiled_truth).toContain('Only copy');
  }), 180_000);

  test('plain-directory reconciliation respects per-source delete limits and exclusions', () => withPlainSource(url, async ({ engine }, dir) => {
    const sync = (exclude?: string[]) => performSync(engine, { sourceId: 'source-a', noEmbed: true, exclude });
    await sync();
    rmSync(join(dir, 'people/alice-example.md'));
    await engine.setConfig('sync.max_deletes.source.source-a', '0');
    expect(await sync()).toMatchObject({ deleted: 0 });
    expect(await engine.getPage('people/alice-example', { sourceId: 'source-a' })).not.toBeNull();
    await engine.setConfig('sync.max_deletes.source.source-a', '1');
    expect(await sync(['people/**'])).toMatchObject({ deleted: 0 });
    expect(await sync()).toMatchObject({ deleted: 1 });
    expect(await engine.searchKeyword('acme-example', { sourceId: 'source-a' })).toHaveLength(0);
  }), 180_000);

  test('real watcher unlink reconciles its registered source and keeps default intact', () => withPlainSource(url, async ({ engine, ctx }, dir) => {
    await performSync(engine, { sourceId: 'source-a', noEmbed: true });
    await submitPageMutation({ ...ctx, sourceId: 'default' }, { operation: 'put_page', params: {
      source_id: 'default', slug: 'people/alice-example', content: person('Alice Example', 'Default source sibling.'), request_id: randomUUID() }, waitMs: 30_000 });
    const harness = new IngestionTestHarness({ engine });
    await harness.run(createFileWatcherSource({ brainDir: dir, debounceMs: 10, awaitStabilityMs: 10 }));
    try {
      rmSync(join(dir, 'people/alice-example.md'));
      const deadline = Date.now() + 5000;
      while (!harness.events.length && Date.now() < deadline) await Bun.sleep(20);
      expect(harness.events).toHaveLength(1);
      const event = harness.events[0]!;
      const job: MinionJobContext = { id: 1, name: 'ingest_capture', data: { event }, attempts_made: 0,
        idempotency_key: null, signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
        updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] };
      expect(await makeIngestCaptureHandler(engine)(job)).toMatchObject({ status: 'deleted' });
      expect(await engine.searchKeyword('acme-example', { sourceId: 'source-a' })).toHaveLength(0);
      expect((await engine.getPage('people/alice-example', { sourceId: 'default' }))?.compiled_truth).toContain('Default source sibling');
      // A queued unlink replay after restoration must not remove the returned file.
      writeFileSync(join(dir, 'people/alice-example.md'), person('Alice Example', 'Restored source file.'));
      expect(await makeIngestCaptureHandler(engine)(job)).toMatchObject({ status: 'skipped' });
      expect(await engine.getPage('people/alice-example', { sourceId: 'source-a' })).not.toBeNull();
    } finally { await harness.stop(); }
  }), 180_000);

  test('managed reconciliation keeps an unreadable file even with mass reconciliation allowed', () => withPlainSource(url, async ({ engine }, dir) => {
    const locked = join(dir, 'private');
    mkdirSync(locked);
    writeFileSync(join(locked, 'bob-example.md'), person('Bob Example', 'An unreadable file is not a deleted file.'));
    const sync = () => performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true });
    expect(await sync()).toMatchObject({ added: 2 });
    chmodSync(locked, 0o000);
    try {
      expect(await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, sync)).toMatchObject({ deleted: 0 });
      expect(await engine.getPage('private/bob-example', { sourceId: 'source-a' })).not.toBeNull();
    } finally { chmodSync(locked, 0o755); }
  }), 180_000);

  test('a missing or empty root (an unmounted volume) withdraws nothing', () => withPlainSource(url, async ({ engine }, dir) => {
    const sync = () => performSync(engine, { sourceId: 'source-a', noPull: true, noEmbed: true });
    const alice = () => engine.getPage('people/alice-example', { sourceId: 'source-a' });
    await sync();
    renameSync(dir, `${dir}-away`);
    await sync().catch(() => undefined);
    expect(await alice()).not.toBeNull();
    renameSync(`${dir}-away`, dir);
    rmSync(join(dir, 'people'), { recursive: true });
    writeFileSync(join(dir, '.DS_Store'), '');
    expect(await sync()).toMatchObject({ deleted: 0 });
    expect(await alice()).not.toBeNull();
    expect(await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, sync)).toMatchObject({ deleted: 1 });
    expect(await alice()).toBeNull();
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

test('a plain folder outside any git repository registers without --force (GST-2732)', () => managedBrain(async ({ engine, root }) => {
  const dir = join(root, '..', 'plain-folder');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'note.md'), '# A note\n');
  await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'source-b', path: dir, requireGitContent: true });
  const [row] = await engine.executeRaw<{ id: string }>("SELECT id FROM sources WHERE id='source-b'");
  expect(row?.id).toBe('source-b');
}), 120_000);

test('sources add without --force refuses a git repository with nothing committed and names what --force does', () => managedBrain(async ({ engine, root }) => {
  const dir = join(root, '..', 'plain-notes');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q']);
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

  test('a classic brain imports a plain-directory file but keeps its page after deletion', async () => {
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
        rmSync(join(dir, 'people/alice-example.md'));
        expect(await performSync(engine, { sourceId: 'source-a', noEmbed: true })).toMatchObject({ deleted: 0 });
        expect(await engine.getPage('people/alice-example', { sourceId: 'source-a' })).not.toBeNull();
        expect(await engine.searchKeyword('acme-example', { sourceId: 'source-a' })).not.toHaveLength(0);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);

  test('classic absent-file pages survive even an explicit mass-reconcile override', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-plain-guard-'));
    const locked = join(home, 'plain-notes', 'private');
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const dir = join(home, 'plain-notes'); mkdirSync(join(dir, 'people'), { recursive: true }); mkdirSync(locked);
        writeFileSync(join(dir, 'people', 'alice-example.md'), person('Alice Example', 'Works at acme-example.'));
        writeFileSync(join(locked, 'bob-example.md'), person('Bob Example', 'Works at widget-example.'));
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('source-c','source-c',$1,'{}')", [dir]);
        const sync = () => performSync(engine, { sourceId: 'source-c', noPull: true, noEmbed: true });
        expect(await sync()).toMatchObject({ status: 'synced', added: 2 });
        // An unreadable folder is skipped by the walk; its file is not proven gone, so nothing is withdrawn.
        chmodSync(locked, 0o000);
        expect(await sync()).toMatchObject({ deleted: 0 });
        expect(await engine.getPage('private/bob-example', { sourceId: 'source-c' })).not.toBeNull();
        chmodSync(locked, 0o755);
        // Classic brains keep every page even when the removal is confirmed.
        rmSync(join(dir, 'people'), { recursive: true }); rmSync(locked, { recursive: true });
        expect(await sync()).toMatchObject({ deleted: 0 });
        expect(await engine.getPage('people/alice-example', { sourceId: 'source-c' })).not.toBeNull();
        expect(await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, sync)).toMatchObject({ deleted: 0 });
        expect(await engine.getPage('private/bob-example', { sourceId: 'source-c' })).not.toBeNull();
        expect(await engine.getPage('people/alice-example', { sourceId: 'source-c' })).not.toBeNull();
      });
    } finally { try { chmodSync(locked, 0o755); } catch { /* removed */ } rmSync(home, { recursive: true, force: true }); }
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
