import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resolveSlugForPath } from '../src/core/sync.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { prepareManagedSyncMutation, type SyncIntent } from '../src/core/persistence/sync-prepare.ts';
import { assertDistinctSyncOrigins, syncOriginPath } from '../src/core/persistence/sync-origin.ts';
import { assertConfiguredSyncRoot, resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { admitWrite, claimNextWrite, getWriteRequest } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { computeSyncDelta } from '../src/core/sync-delta.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { interruptAfterSyncDiscovery } from './helpers/persistence-sync-interruption.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-origin-native-'));
const stores: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [];
const content = '---\ntitle: Example note\ntype: note\n---\nA stable synthetic observation.\n';
const options = { noPull: true, noEmbed: true, noExtract: true, noSchemaPack: true, full: true };
beforeAll(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  stores.push({ engine, close: () => engine.disconnect() });
  if (process.env.DATABASE_URL) stores.push(await isolatedPersistencePostgres(process.env.DATABASE_URL));
  console.info(`NATIVE_SYNC_ORIGIN_PLATFORM=${process.platform}`);
}, 120_000);
afterAll(async () => {
  for (const store of stores) { await disposePersistenceConsumer(store.engine); await store.close(); }
  rmSync(home, { recursive: true, force: true });
});
const check = (name: string, run: (engine: BrainEngine) => Promise<void>) => test(name, () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const { engine } of stores) await run(engine);
}), 120_000);

async function fixture(engine: BrainEngine, sourcePath = 'notes/example.md', slug = 'notes/example', files: Record<string, string> = { 'notes/example.md': content }) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const id = `origin-${randomUUID().slice(0, 12)}`, root = join(home, id); mkdirSync(root);
  const git = await makeGitFixture(root);
  for (const [path, bytes] of Object.entries(files)) { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, bytes); }
  git.commitAll('Add synthetic origin fixture');
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
  await importFromContent(engine, slug, content, { sourceId: id, sourcePath, noEmbed: true });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: id }))!;
  expect(snapshot).not.toBeNull();
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, head, slug, snapshot, opts: { ...options, sourceId: id, repoPath: root } };
}

async function legacyDeletion(engine: BrainEngine, f: Awaited<ReturnType<typeof fixture>>, admitted: boolean) {
  expect((await interruptAfterSyncDiscovery(engine, f.opts)).status).toBe('partial');
  const [stored] = await engine.executeRaw<{ fingerprint: string; completed_keys: any[] }>(
    "SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]);
  const cursor = stored.completed_keys[0];
  const entry = { path: 'notes/example.md', sourcePath: f.snapshot.page.source_path!, action: 'delete', working: false,
    slug: f.slug, pageId: f.snapshot.page.id, revision: f.snapshot.revision };
  const intent: SyncIntent = { kind: 'managed_sync_delete', expected_revision: f.snapshot.revision,
    sourcePath: entry.sourcePath, path: entry.path, rawHash: sha256(content), content: null,
    ownerEpoch: String(cursor.binding.owner_epoch), syncAuthority: cursor.authority, cursorKey: stored.fingerprint,
    runId: cursor.runId, index: 0, total: 1, from: cursor.from, target: cursor.target, slugMode: cursor.slugMode };
  const requestId = randomUUID();
  const next = { ...cursor, total: 1, ...(admitted ? { pending: { requestId, slug: f.slug, pageId: f.snapshot.page.id, intent } } : {}) };
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=$2::text::jsonb WHERE op='managed-sync-manifest' AND fingerprint=$1", [cursor.runId, JSON.stringify([entry])]);
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=$2::text::jsonb WHERE op='managed-sync' AND fingerprint=$1", [stored.fingerprint, JSON.stringify([next])]);
  if (admitted) await admitWrite(engine, { requestId, operation: 'submit_job', sourceId: f.id,
    sourceIncarnation: cursor.incarnation, slug: f.slug, pageId: f.snapshot.page.id, worktreeId: cursor.binding.worktree_id,
    topologyGeneration: cursor.binding.topology_generation, principal: cursor.authority.writer.principal,
    authority: cursor.authority.writer, callerIntent: intent, intent });
  return { requestId, intent, cursor, entry };
}

test('origin comparison is Windows-specific and never case-folds POSIX identity', () => {
  expect(syncOriginPath('notes\\example.md', 'win32')).toBe('notes/example.md');
  expect(syncOriginPath('notes\\example.md', 'linux')).toBe('notes\\example.md');
  expect(syncOriginPath('Notes/example.md', 'win32')).not.toBe(syncOriginPath('notes/example.md', 'win32'));
  expect(() => assertDistinctSyncOrigins(['Notes/example.md', 'notes/example.md'], 'win32')).toThrow();
  expect(() => assertDistinctSyncOrigins(['Notes/example.md', 'notes/example.md', 'notes\\example.md'], 'linux')).not.toThrow();
  for (const path of ['../escape.md', 'notes/../escape.md', '/absolute.md', 'notes//example.md']) expect(() => syncOriginPath(path)).toThrow();
  expect(() => syncOriginPath('C:\\escape.md', 'win32')).toThrow();
  for (const path of ['notes./example.md', 'notes /example.md', 'notes/example.md:alias', 'NUL.md']) {
    expect(() => syncOriginPath(path, 'win32')).toThrow();
    expect(syncOriginPath(path, 'linux')).toBe(path);
  }
});

test('configured sync roots still refuse unrelated directories and replaced registered roots', () => {
  const root = realpathSync(mkdtempSync(join(home, 'configured-root-')));
  const other = realpathSync(mkdtempSync(join(home, 'other-root-')));
  expect(() => assertConfiguredSyncRoot(root, other)).toThrow('configured source directory');
  expect(() => assertConfiguredSyncRoot(root, join(home, 'missing'))).toThrow('configured source directory');
  rmSync(root, { recursive: true });
  symlinkSync(other, root, 'junction');
  expect(() => assertConfiguredSyncRoot(root, root)).toThrow('configured source directory');
  expect(() => assertConfiguredSyncRoot(root, other)).toThrow('configured source directory');
});

check('native root spellings retain the registered owner and resume the same sync cursor', async engine => {
  for (const legacy of [false, true]) {
    const f = await fixture(engine);
    if (legacy) {
      const binding = (await getWorktreeBinding(engine, f.id))!;
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
        await tx.executeRaw('UPDATE persistence_source_bindings SET relative_path=$2 WHERE source_id=$1',
          [f.id, relative(binding.local_path!, realpathSync(f.root)).split(sep).join('/')]);
      });
    }
    const binding = (await getWorktreeBinding(engine, f.id))!;
    const context = await resolveManagedSyncContext(engine, f.opts);
    const nativeRoot = realpathSync.native(f.root);
    expect(context.root).toBe(resolve(binding.local_path!, binding.relative_path));
    expect(realpathSync.native(context.root)).toBe(nativeRoot);
    console.info(`Native sync root fixture: platform=${process.platform} legacy=${legacy} distinct=${realpathSync(f.root) !== binding.local_path}`);
    if (process.platform === 'win32' && process.env.GBRAIN_TEST_REQUIRE_CASE_INSENSITIVE === '1') {
      expect(realpathSync(f.root)).not.toBe(binding.local_path);
    }
    expect(await resolveManagedSyncContext(engine, { ...f.opts, repoPath: nativeRoot })).toEqual(context);
    expect((await interruptAfterSyncDiscovery(engine, f.opts)).status).toBe('partial');
    const before = await engine.executeRaw<{ fingerprint: string; completed_keys: Array<Record<string, unknown>> }>(
      "SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]);
    expect(before).toHaveLength(1);
    expect(await performManagedSync(engine, { ...f.opts, repoPath: nativeRoot, dryRun: true })).toMatchObject({ status: 'dry_run' });
    expect(await engine.executeRaw(
      "SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id])).toEqual(before);
    expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'first_sync', added: 0, deleted: 0 });
    const after = await engine.executeRaw<{ fingerprint: string; completed_keys: Array<Record<string, unknown>> }>(
      "SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]);
    expect(after).toHaveLength(1);
    expect(after[0].fingerprint).toBe(before[0].fingerprint);
    for (const key of ['root', 'gitRoot', 'binding', 'authority', 'runId']) {
      expect(after[0].completed_keys[0][key]).toEqual(before[0].completed_keys[0][key]);
    }
    expect(await getWorktreeBinding(engine, f.id)).toEqual(binding);
    expect((await engine.getPage(f.slug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
    expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toBe(content);
  }
});

check('native sync retains the exact accepted remote path and payload hash across root spellings', async engine => {
  const f = await fixture(engine);
  const clientId = `fixture-admin-${randomUUID()}`;
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
    VALUES($1,'Fixture admin','test-only','admin',$2,ARRAY['submit_job'])`, [clientId, f.id]);
  const ctx = { engine, remote: true, sourceId: f.id, auth: { clientId, principal: { kind: 'oauth_client', id: clientId },
    scopes: ['admin'], sourceId: f.id, allowedOperations: ['submit_job'] } } as OperationContext;
  const remote = await prepareRemoteJob(ctx, 'sync', { noPull: true });
  const binding = (await getWorktreeBinding(engine, f.id))!;
  const accepted = structuredClone(remote);
  if (process.platform === 'win32' && process.env.GBRAIN_TEST_REQUIRE_CASE_INSENSITIVE === '1') {
    expect(remote.data.repoPath).not.toBe(binding.local_path);
  }
  expect(await withSubmissionAuthority(remote.authority, () => performManagedSync(engine, remote.data as SyncOpts)))
    .toMatchObject({ status: 'first_sync', added: 0, deleted: 0 });
  const receipts = await engine.executeRaw<{ intent: { syncAuthority: { remoteData: unknown; remoteJob: unknown } }; state: string }>(
    'SELECT intent,state FROM persistence_requests WHERE source_id=$1', [f.id]);
  expect(receipts.length).toBeGreaterThan(0);
  for (const receipt of receipts) {
    expect(receipt.state).toBe('committed');
    expect(receipt.intent.syncAuthority.remoteData).toEqual(accepted.data);
    expect(receipt.intent.syncAuthority.remoteJob).toEqual(accepted.authority);
  }
  expect(remote).toEqual(accepted);
  expect(await getWorktreeBinding(engine, f.id)).toEqual(binding);
  expect((await engine.getPage(f.slug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
  await expect(withSubmissionAuthority(remote.authority, () => performManagedSync(engine,
    { ...remote.data, repoPath: home } as SyncOpts))).rejects.toMatchObject({ code: 'permission_denied' });
});

check('native historical separator identity preserves the original page or refuses distinct POSIX origins', async engine => {
  const f = await fixture(engine, 'notes\\example.md');
  const history = await engine.getVersions(f.slug, { sourceId: f.id });
  if (process.platform === 'win32') {
    expect(await performManagedSync(engine, { ...f.opts, dryRun: true })).toMatchObject({ status: 'dry_run' });
    expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
    const result = await performManagedSync(engine, f.opts);
    expect(result).toMatchObject({ status: 'first_sync', added: 0, deleted: 0 });
    const page = await engine.getPage(f.slug, { sourceId: f.id });
    expect(page?.id).toBe(f.snapshot.page.id);
    expect(page?.source_path).toBe('notes/example.md');
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_delete'", [f.id])).toEqual([]);
    expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(f.head);
  } else {
    await expect(performManagedSync(engine, { ...f.opts, dryRun: true })).rejects.toMatchObject({ code: 'page_identity_changed' });
    await expect(performManagedSync(engine, f.opts)).rejects.toMatchObject({ code: 'page_identity_changed' });
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
    expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  }
  expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
  expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toBe(content);
});

check('native Windows historical alias cannot become a delete plus replacement identity', async engine => {
  if (process.platform !== 'win32') {
    const literal = 'notes\\example.md', literalSlug = resolveSlugForPath(literal);
    const f = await fixture(engine, literal, literalSlug, { [literal]: content, 'notes/example.md': content.replace('stable', 'separate') });
    const history = await engine.getVersions(f.slug, { sourceId: f.id });
    await expect(performManagedSync(engine, { ...f.opts, dryRun: true })).rejects.toMatchObject({ code: 'page_identity_changed' });
    await expect(performManagedSync(engine, f.opts)).rejects.toMatchObject({ code: 'page_identity_changed' });
    expect((await engine.getPage(literalSlug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
    expect(await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1', [f.id])).toHaveLength(1);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
    expect(readFileSync(join(f.root, literal), 'utf8')).toBe(content);
    expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toContain('separate');
    expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
    expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
    return;
  }
  const f = await fixture(engine, 'notes\\example.md', 'legacy-example');
  const history = await engine.getVersions(f.slug, { sourceId: f.id });
  expect(await performManagedSync(engine, { ...f.opts, dryRun: true })).toMatchObject({ status: 'dry_run' });
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
  const result = await performManagedSync(engine, f.opts);
  expect(result).toMatchObject({ status: 'first_sync', added: 0, deleted: 0 });
  expect((await engine.getPage('legacy-example', { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
  expect(await engine.getPage('notes/example', { sourceId: f.id })).toBeNull();
  expect(await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1', [f.id])).toHaveLength(1);
  expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
});

for (const alias of [false, true]) check(`native historical ${alias ? 'alias' : 'ordinary'} origin survives a real incremental delta and dry-run`, async engine => {
  const literal = 'notes\\example.md';
  const files: Record<string, string> = { 'notes/example.md': content, 'notes/untouched.md': 'An unchanged, independently tracked note.\n' };
  if (process.platform !== 'win32') files[literal] = content;
  const f = await fixture(engine, literal, alias ? 'legacy-example' : 'notes/example', files);
  const history = await engine.getVersions(f.slug, { sourceId: f.id });
  await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [f.id, f.head])));
  const revised = content.replace('title: Example note', 'title: "Example note"');
  writeFileSync(join(f.root, 'notes/example.md'), revised);
  execFileSync('git', ['-C', f.root, 'add', 'notes/example.md']);
  execFileSync('git', ['-C', f.root, 'commit', '-qm', 'Change only equivalent frontmatter spelling']);
  const target = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  expect(target).not.toBe(f.head);
  expect(computeSyncDelta(f.root, f.head, target)).toMatchObject({ status: 'ok', manifest: { added: [], modified: ['notes/example.md'], deleted: [], renamed: [] } });
  const opts = { ...f.opts, full: false };
  if (process.platform !== 'win32' && !alias) {
    await expect(performManagedSync(engine, { ...opts, dryRun: true })).rejects.toMatchObject({ code: 'page_identity_changed' });
  } else {
    expect(await performManagedSync(engine, { ...opts, dryRun: true })).toMatchObject({ status: 'dry_run', fromCommit: f.head, toCommit: target, filesImported: 0 });
  }
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
  expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1', [f.id])).toEqual([]);
  expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id])).toEqual([]);
  expect((await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(f.head);
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
  if (process.platform !== 'win32' && !alias) {
    await expect(performManagedSync(engine, opts)).rejects.toMatchObject({ code: 'page_identity_changed' });
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
    expect((await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(f.head);
  } else {
    const result = await performManagedSync(engine, opts);
    expect(result).toMatchObject({ status: 'synced', fromCommit: f.head, toCommit: target, deleted: 0, filesImported: 1 });
    const requests = await engine.executeRaw<{ intent: SyncIntent; state: string }>('SELECT intent,state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
    expect(requests).toHaveLength(2);
    expect(requests.every(row => row.state === 'committed')).toBe(true);
    expect(requests[0].intent).toMatchObject({ kind: 'managed_sync_import', path: 'notes/example.md', from: f.head, target });
    expect(requests[1].intent.kind).toBe('managed_sync_checkpoint');
    expect(await engine.getPage('notes/untouched', { sourceId: f.id })).toBeNull();
    expect((await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(target);
    if (process.platform === 'win32' && alias) expect(await engine.getPage('notes/example', { sourceId: f.id })).toBeNull();
  }
  expect((await engine.getPage(f.slug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
  expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
  expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toBe(revised);
  if (process.platform !== 'win32') expect(readFileSync(join(f.root, literal), 'utf8')).toBe(content);
});

check('a genuine committed Git deletion commits one deletion and the exact checkpoint', async engine => {
  const f = await fixture(engine);
  await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [f.id, f.head])));
  const history = await engine.getVersions(f.slug, { sourceId: f.id });
  unlinkSync(join(f.root, 'notes/example.md'));
  execFileSync('git', ['-C', f.root, 'add', '-A']);
  execFileSync('git', ['-C', f.root, 'commit', '-qm', 'Commit the intentional source deletion']);
  const target = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  expect(computeSyncDelta(f.root, f.head, target)).toMatchObject({ status: 'ok', manifest: { deleted: ['notes/example.md'] } });
  expect(await performManagedSync(engine, { ...f.opts, full: false, dryRun: true })).toMatchObject({ status: 'dry_run' });
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
  expect(await performManagedSync(engine, { ...f.opts, full: false })).toMatchObject({ status: 'synced', deleted: 1, filesImported: 1, fromCommit: f.head, toCommit: target });
  const deleted = (await engine.readPageSnapshot(f.slug, { sourceId: f.id, includeDeleted: true }))!;
  expect(deleted.page.id).toBe(f.snapshot.page.id);
  expect(deleted.page.deleted_at).not.toBeNull();
  expect(deleted.revision).not.toBe(f.snapshot.revision);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toHaveLength(history.length + 1);
  const requests = await engine.executeRaw<{ intent: SyncIntent; state: string }>('SELECT intent,state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
  expect(requests).toHaveLength(2);
  expect(requests.every(row => row.state === 'committed')).toBe(true);
  expect(requests[0].intent).toMatchObject({ kind: 'managed_sync_delete', working: false, target, from: f.head });
  expect(requests[1].intent.kind).toBe('managed_sync_checkpoint');
  expect((await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(target);
  expect(await performManagedSync(engine, { ...f.opts, full: false })).toMatchObject({ status: 'up_to_date', deleted: 0 });
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(2);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toHaveLength(history.length + 1);
});

check('old manifest reuse refuses a present-file deletion before admitting any request', async engine => {
  const f = await fixture(engine, process.platform === 'win32' ? 'notes\\example.md' : 'notes/example.md');
  const legacy = await legacyDeletion(engine, f, false);
  await expect(performManagedSync(engine, f.opts)).rejects.toMatchObject({ code: 'page_identity_changed' });
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
  expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  const [manifest] = await engine.executeRaw<{ completed_keys: unknown[] }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [legacy.cursor.runId]);
  expect(manifest.completed_keys).toEqual([legacy.entry]);
  expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBeNull();
  expect((await performManagedSync(engine, { ...f.opts, retryFailed: true })).status).toBe('first_sync');
  expect((await engine.getPage(f.slug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
});

check('already-admitted legacy deletion fails under its original ID and only explicit rediscovery advances', async engine => {
  const f = await fixture(engine, process.platform === 'win32' ? 'notes\\example.md' : 'notes/example.md');
  const legacy = await legacyDeletion(engine, f, true);
  const first = await performManagedSync(engine, f.opts);
  expect(first).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_request: { request_id: legacy.requestId } } });
  const row = (await getWriteRequest(engine, legacy.cursor.authority.writer.principal, legacy.requestId))!;
  expect(row.state).not.toBe('committed');
  expect(row.error_code).toBe('page_identity_changed');
  expect(row.intent).toEqual(legacy.intent);
  expect((await performManagedSync(engine, f.opts)).managedWrite?.write_request).toEqual(first.managedWrite?.write_request);
  expect((await engine.getPage(f.slug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
  expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toBe(content);
  expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBeNull();
  expect((await performManagedSync(engine, { ...f.opts, retryFailed: true })).status).toBe('first_sync');
  expect((await getWriteRequest(engine, legacy.cursor.authority.writer.principal, legacy.requestId))?.state).toBe(row.state);
  expect((await engine.getPage(f.slug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
});

check('explicit working-tree deletion remains valid even when the pinned Git target contains the file', async engine => {
  const f = await fixture(engine);
  unlinkSync(join(f.root, 'notes/example.md'));
  const result = await performManagedSync(engine, { ...f.opts, workingTree: true });
  expect(result).toMatchObject({ status: 'first_sync', deleted: 1 });
  expect(await engine.getPage(f.slug, { sourceId: f.id })).toBeNull();
  const [request] = await engine.executeRaw<{ intent: SyncIntent }>("SELECT intent FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_delete'", [f.id]);
  expect(request.intent.working).toBe(true);
});

check('native case aliases refuse rather than merge distinct origins', async engine => {
  const f = await fixture(engine, 'Notes/example.md', 'notes/example', { 'Notes/example.md': content });
  const object = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD:Notes/example.md'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', f.root, '-c', 'core.ignorecase=false', 'update-index', '--add', '--cacheinfo', `100644,${object},notes/example.md`]);
  execFileSync('git', ['-C', f.root, 'commit', '-qm', 'Add case-distinct tree entry']);
  if (process.platform !== 'win32') {
    mkdirSync(join(f.root, 'notes'), { recursive: true });
    writeFileSync(join(f.root, 'notes/example.md'), content);
  }
  await expect(performManagedSync(engine, f.opts)).rejects.toMatchObject({ code: 'page_identity_changed' });
  expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
  expect(readFileSync(join(f.root, 'Notes/example.md'), 'utf8')).toBe(content);
  expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toBe(content);
});

check('unknown old deletion manifests fail closed without rewriting accepted request identity', async engine => {
  const f = await fixture(engine);
  const legacy = await legacyDeletion(engine, f, true);
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [legacy.cursor.runId]);
  const row = (await getWriteRequest(engine, legacy.cursor.authority.writer.principal, legacy.requestId))!;
  await expect(prepareManagedSyncMutation(engine, row, { engine: engine.kind })).rejects.toMatchObject({ code: 'page_identity_changed' });
  expect((await getWriteRequest(engine, legacy.cursor.authority.writer.principal, legacy.requestId))?.intent).toEqual(legacy.intent);
  expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  await engine.executeRaw("UPDATE persistence_requests SET state='cancelled' WHERE id=$1::uuid", [row.id]);
});

check('an admitted deletion cannot infer a missing page origin from its slug', async engine => {
  const f = await fixture(engine);
  unlinkSync(join(f.root, 'notes/example.md'));
  execFileSync('git', ['-C', f.root, 'add', '-A']);
  execFileSync('git', ['-C', f.root, 'commit', '-qm', 'Remove the synthetic source file']);
  await engine.executeRaw('UPDATE pages SET source_path=NULL WHERE id=$1', [f.snapshot.page.id]);
  const legacy = await legacyDeletion(engine, f, true);
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'blocked_by_failures',
    managedWrite: { write_error: 'page_identity_changed', write_request: { request_id: legacy.requestId } } });
  expect((await engine.getPage(f.slug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
  expect((await getWriteRequest(engine, legacy.cursor.authority.writer.principal, legacy.requestId))?.intent).toEqual(legacy.intent);
});

check('publication revalidates a recreated working-tree deletion and activation after preparation', async engine => {
  for (const change of ['file', 'activation', 'configured-root', 'origin']) {
    const f = await fixture(engine);
    unlinkSync(join(f.root, 'notes/example.md'));
    const legacy = await legacyDeletion(engine, f, false);
    const intent = { ...legacy.intent, working: true, rawHash: null };
    const requestId = randomUUID();
    const [cursor] = await engine.executeRaw<{ completed_keys: any[] }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [intent.cursorKey]);
    cursor.completed_keys[0].pending = { requestId, slug: f.slug, pageId: f.snapshot.page.id, intent };
    await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=$2::text::jsonb WHERE op='managed-sync' AND fingerprint=$1", [intent.cursorKey, JSON.stringify(cursor.completed_keys)]);
    const admission = { requestId, operation: 'submit_job', sourceId: f.id, sourceIncarnation: legacy.cursor.incarnation,
      slug: f.slug, pageId: f.snapshot.page.id, worktreeId: legacy.cursor.binding.worktree_id, topologyGeneration: legacy.cursor.binding.topology_generation,
      principal: legacy.cursor.authority.writer.principal, authority: legacy.cursor.authority.writer, callerIntent: intent, intent };
    const accepted = await admitWrite(engine, admission);
    const row = (await claimNextWrite(engine, localHostId()))!;
    expect(row.id).toBe(accepted.id);
    const prepared = await prepareManagedSyncMutation(engine, row, { engine: engine.kind });
    if (change === 'file') writeFileSync(join(f.root, 'notes/example.md'), content);
    else if (change === 'activation') await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    else if (change === 'origin') await engine.executeRaw('UPDATE pages SET source_path=NULL WHERE id=$1', [f.snapshot.page.id]);
    else await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
      await tx.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [f.id, home]);
    });
    const published = await publishMutation(engine, row, prepared);
    expect(published.state).not.toBe('committed');
    expect(published.error_code).toBe(change === 'activation' ? 'writer_coordinator_required' : change === 'origin' ? 'page_identity_changed' : 'source_changed');
    expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
    expect((await admitWrite(engine, admission)).id).toBe(accepted.id);
    expect((await getWriteRequest(engine, admission.principal, requestId))?.intent).toEqual(intent);
    expect((await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBeNull();
  }
});
