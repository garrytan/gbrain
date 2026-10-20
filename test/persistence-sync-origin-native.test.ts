/**
 * Native sync-origin identity (separators, case, root spellings) and deletion provenance of managed sync.
 *
 * #6712 PR 4b: a non-company source syncs by the live pass, so these tests assert the pass where they used to assert the
 * cursor. Protects, for the pass: a remote sync keeps its accepted path and payload unchanged across root spellings and,
 * on a page no sync import recorded, asks for the brain host and writes nothing; deleting a filename no page claims is not
 * a candidate (no request, the live or tombstoned page unchanged; a tombstone whose file is still present is held
 * file_drift deleted/tombstone_edited); a committed or working-tree deletion of a page no sync import recorded is held
 * file_drift deleted/file_gone and the page stays live. A native root spelling keeps the registered owner and resumes the
 * one pass row; a pass's deletion publication revalidates a recreated file, activation, the configured root and the
 * origin after preparation, under the request id it was admitted with. An older binary's unfinished cursor (what its
 * frozen manifest and admitted deletion leave behind) is retired by the pass: a frozen deletion of a present file is never
 * admitted, an admitted one is cancelled under its original id with its intent unchanged, an origin-less page is never
 * deleted by slug, and a legacy deletion request with no manifest still fails closed at preparation.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { resolveSlugForPath } from '../src/core/sync.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { managedSyncAuthority } from '../src/core/persistence/sync-authority.ts';
import { passRequestId } from '../src/core/persistence/sync-pass-batch.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { prepareManagedSyncMutation, type SyncIntent } from '../src/core/persistence/sync-prepare.ts';
import { assertDistinctSyncOrigins, syncOriginPath } from '../src/core/persistence/sync-origin.ts';
import { assertConfiguredSyncRoot, resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { admitWrite, getWriteRequest } from '../src/core/persistence/journal.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { computeSyncDelta } from '../src/core/sync-delta.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { gitAsync } from './helpers/git-publication.ts';
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
afterEach(() => installFaultHook(undefined));
const check = (name: string, run: (engine: BrainEngine) => Promise<void>) => test(name, () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const { engine } of stores) await run(engine);
}), 120_000);

async function fixture(engine: BrainEngine, sourcePath = 'notes/example.md', slug = 'notes/example', files: Record<string, string> = { 'notes/example.md': content }) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const id = `origin-${randomUUID().slice(0, 12)}`, root = join(home, id); mkdirSync(root);
  for (const args of [['init', '-q'], ['config', 'maintenance.auto', 'false'], ['config', 'gc.auto', '0'], ['config', 'user.email', 't@t.co'], ['config', 'user.name', 't']]) await gitAsync(root, ...args);
  for (const [path, bytes] of Object.entries(files)) { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, bytes); }
  await gitAsync(root, 'add', '-A');
  await gitAsync(root, 'commit', '-q', '-m', 'Add synthetic origin fixture');
  const head = (await gitAsync(root, 'rev-parse', 'HEAD')).trim();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
  await importFromContent(engine, slug, content, { sourceId: id, sourcePath, noEmbed: true });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: id }))!;
  expect(snapshot).not.toBeNull();
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, head, slug, snapshot, opts: { ...options, sourceId: id, repoPath: root } };
}

/**
 * #6712 PR 4b: what an older binary's unfinished cursor left for this source: a cursor row and its frozen manifest naming the
 * deletion of notes/example.md, and (when `admitted`) that deletion admitted as the cursor's pending request with a legacy
 * intent (no `working`, no `passId`). A non-company source no longer writes a cursor, so the rows are written as it wrote them.
 */
async function legacyDeletion(engine: BrainEngine, f: Awaited<ReturnType<typeof fixture>>, admitted: boolean) {
  const context = await resolveManagedSyncContext(engine, f.opts);
  const authority = await managedSyncAuthority(engine, f.id, context.incarnation, context.root);
  const binding = { ...context.binding, owner_epoch: String(context.binding.owner_epoch), topology_generation: String(context.binding.topology_generation) };
  const key = `legacy-${randomUUID()}`, runId = randomUUID();
  const target = (await gitAsync(f.root, 'rev-parse', 'HEAD')).trim();
  const entry = { path: 'notes/example.md', sourcePath: f.snapshot.page.source_path!, action: 'delete', working: false,
    slug: f.slug, pageId: f.snapshot.page.id, revision: f.snapshot.revision };
  const cursor: Record<string, any> = { binding, root: context.root, gitRoot: context.gitRoot, sourceId: f.id, incarnation: context.incarnation, from: null, target,
    slugMode: 'git-root', discoveredAt: new Date().toISOString(), runId, index: 0, total: 1, authority,
    processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: true }, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 },
    syncOptions: { full: true, workingTree: false, srcSubpath: null, exclude: [], includeHidden: [], strategy: null } };
  const intent: SyncIntent = { kind: 'managed_sync_delete', expected_revision: f.snapshot.revision,
    sourcePath: entry.sourcePath, path: entry.path, rawHash: sha256(content), content: null,
    ownerEpoch: binding.owner_epoch, syncAuthority: authority, cursorKey: key,
    runId, index: 0, total: 1, from: null, target, slugMode: 'git-root' };
  const requestId = randomUUID();
  if (admitted) cursor.pending = { requestId, slug: f.slug, pageId: f.snapshot.page.id, intent };
  await engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,$3::text::jsonb,now())', ['managed-sync', key, JSON.stringify([cursor])]);
  await engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,$3::text::jsonb,now())', ['managed-sync-manifest', runId, JSON.stringify([entry])]);
  if (admitted) await admitWrite(engine, { requestId, operation: 'submit_job', sourceId: f.id,
    sourceIncarnation: context.incarnation, slug: f.slug, pageId: f.snapshot.page.id, worktreeId: binding.worktree_id,
    topologyGeneration: binding.topology_generation, principal: authority.writer.principal,
    authority: authority.writer, callerIntent: intent, intent });
  return { requestId, intent, cursor: cursor as { runId: string; authority: typeof authority }, entry, key };
}
/** The page the pass keeps: on Windows it re-spells a stored backslash origin with '/' in place, revision unchanged (as the separator identity test asserts). */
const keptSnapshot = (f: Awaited<ReturnType<typeof fixture>>) => process.platform === 'win32'
  ? { ...f.snapshot, page: { ...f.snapshot.page, source_path: syncOriginPath(f.snapshot.page.source_path!, 'win32') } } : f.snapshot;
const legacyRows = (engine: BrainEngine, legacy: Awaited<ReturnType<typeof legacyDeletion>>) => engine.executeRaw<{ op: string }>(
  "SELECT op FROM op_checkpoints WHERE (op='managed-sync' AND fingerprint=$1) OR (op='managed-sync-manifest' AND fingerprint=$2)", [legacy.key, legacy.cursor.runId]);
const deleteRequests = (engine: BrainEngine, id: string) => engine.executeRaw<{ request_id: string; state: string; error_code: string | null }>(
  "SELECT request_id::text AS request_id, state, error_code FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_delete' ORDER BY sequence", [id]);

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

// #6712 PR 4b: the pass keeps one row per source incarnation (no cursor to resume). A pass interrupted part way and resumed
// under the native spelling of the root keeps that one row, admits every request under the registered owner, and leaves
// the binding as it was: no second worktree or owner.
check('native root spellings retain the registered owner and resume the same pass row', async engine => {
  for (const legacy of [false, true]) {
    const f = await fixture(engine, 'notes/example.md', 'notes/example', { 'notes/example.md': content,
      'notes/second.md': 'A second synthetic observation.\n', 'notes/third.md': 'A third synthetic observation.\n' });
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
    const passRows = () => engine.executeRaw<{ fingerprint: string; value: { source_id: string; incarnation: string; telemetry: { pass_id: string; outcome: string } } }>(
      "SELECT fingerprint, completed_keys->0 AS value FROM op_checkpoints WHERE op='managed-sync-pass' AND completed_keys->0->>'source_id'=$1", [f.id]);
    const partial = await performManagedSync(engine, f.opts, { maxPages: 1, maxMs: 1000 });
    expect(partial).toMatchObject({ status: 'partial', reason: 'writer_yield', pass: { outcome: 'resumable' } });
    const before = await passRows();
    expect(before.map(row => row.fingerprint)).toEqual([`${f.id}:${context.incarnation}`]);
    expect(await performManagedSync(engine, { ...f.opts, repoPath: nativeRoot, dryRun: true })).toMatchObject({ status: 'dry_run' });
    expect(await passRows()).toEqual(before);
    const resumed = await performManagedSync(engine, { ...f.opts, repoPath: nativeRoot });
    expect(resumed).toMatchObject({ status: 'first_sync', deleted: 0, pass: { outcome: 'synced' } });
    expect(resumed.pass!.pass_id).not.toBe(partial.pass!.pass_id);
    const after = await passRows();
    expect(after.map(row => [row.fingerprint, row.value.source_id, row.value.incarnation, row.value.telemetry.pass_id, row.value.telemetry.outcome]))
      .toEqual([[before[0]!.fingerprint, f.id, context.incarnation, resumed.pass!.pass_id, 'synced']]);
    const requests = await engine.executeRaw<{ worktree_id: string; owner_epoch: string; kind: string; path: string | null; state: string }>(
      `SELECT worktree_id::text AS worktree_id, intent->>'ownerEpoch' AS owner_epoch, intent->>'kind' AS kind, intent->>'path' AS path, state
         FROM persistence_requests WHERE source_id=$1 ORDER BY sequence`, [f.id]);
    expect(requests.every(row => row.worktree_id === binding.worktree_id && row.owner_epoch === String(binding.owner_epoch) && row.state === 'committed')).toBe(true);
    expect(requests.filter(row => row.kind === 'managed_sync_import').map(row => row.path).sort()).toEqual(['notes/second.md', 'notes/third.md']);
    expect(await getWorktreeBinding(engine, f.id)).toEqual(binding);
    expect(await engine.executeRaw('SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$1', [f.id])).toHaveLength(1);
    expect((await engine.getPage(f.slug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
    expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toBe(content);
  }
});

check('a native remote sync keeps the accepted path and payload across root spellings; on a page no sync import recorded it asks for the brain host and writes nothing', async engine => {
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
  // The page has no sync import record, so only the brain host can reconcile it: the remote pass stops before admitting anything.
  expect(await withSubmissionAuthority(remote.authority, () => performManagedSync(engine, remote.data as SyncOpts)))
    .toMatchObject({ status: 'blocked_by_failures', reason: 'reconcile_host_required', added: 0, deleted: 0,
      pass: { kind: 'full', outcome: 'blocked', stop_reason: 'reconcile_host_required' } });
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
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
    // GBRA-130 B-3 (was: the pass refused page_identity_changed): both spellings are held, neither is imported or deleted,
    // and an unrelated file in the same sync imports.
    writeFileSync(join(f.root, 'notes/other.md'), 'An unrelated synthetic note.\n');
    await gitAsync(f.root, 'add', 'notes/other.md');
    await gitAsync(f.root, 'commit', '-qm', 'Add an unrelated note');
    const result = await performManagedSync(engine, f.opts);
    expect(result.held?.map(hold => [hold.path, hold.code, hold.reason]).sort()).toEqual([['notes/example.md', 'page_identity_changed', 'spelling'], ['notes\\example.md', 'page_identity_changed', 'spelling']]);
    expect(await engine.executeRaw("SELECT intent->>'path' AS path FROM persistence_requests WHERE source_id=$1 AND intent->>'kind' <> 'managed_sync_checkpoint' ORDER BY path", [f.id])).toEqual([{ path: 'notes/other.md' }]);
    expect(await engine.getPage('notes/other', { sourceId: f.id })).not.toBeNull();
    expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  }
  expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
  expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toBe(content);
});

check('native Windows historical alias cannot become a delete plus replacement identity', async engine => {
  if (process.platform !== 'win32') {
    const literal = 'notes\\example.md', literalSlug = resolveSlugForPath(literal);
    const f = await fixture(engine, literal, literalSlug, { [literal]: content, 'notes/example.md': content.replace('stable', 'separate'), 'notes/other.md': 'An unrelated synthetic note.\n' });
    const history = await engine.getVersions(f.slug, { sourceId: f.id });
    await expect(performManagedSync(engine, { ...f.opts, dryRun: true })).rejects.toMatchObject({ code: 'page_identity_changed' });
    // GBRA-130 B-3 (was: the pass refused page_identity_changed): both spellings are held, the page is neither deleted nor
    // replaced, and an unrelated file in the same sync imports.
    const result = await performManagedSync(engine, f.opts);
    expect(result.held?.map(hold => [hold.path, hold.code, hold.reason]).sort()).toEqual([['notes/example.md', 'page_identity_changed', 'spelling'], ['notes\\example.md', 'page_identity_changed', 'spelling']]);
    expect((await engine.getPage(literalSlug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
    expect((await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1', [f.id])).map(row => row.slug).sort()).toEqual([literalSlug, 'notes/other'].sort());
    expect(await engine.executeRaw("SELECT intent->>'path' AS path FROM persistence_requests WHERE source_id=$1 AND intent->>'kind' <> 'managed_sync_checkpoint' ORDER BY path", [f.id])).toEqual([{ path: 'notes/other.md' }]);
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
  await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [f.id, f.head]), TEST_WRITE_ATTRIBUTION));
  const revised = content.replace('title: Example note', 'title: "Example note"');
  writeFileSync(join(f.root, 'notes/example.md'), revised);
  await gitAsync(f.root, 'add', 'notes/example.md');
  await gitAsync(f.root, 'commit', '-qm', 'Change only equivalent frontmatter spelling');
  const target = (await gitAsync(f.root, 'rev-parse', 'HEAD')).trim();
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
    // GBRA-130 B-3 (was: the pass refused page_identity_changed): both spellings are held, neither is imported or deleted,
    // and the unrelated notes/untouched.md imports.
    const result = await performManagedSync(engine, opts);
    expect(result).toMatchObject({ status: 'synced', fromCommit: f.head, toCommit: target, deleted: 0, filesImported: 1 });
    expect(result.held?.map(hold => [hold.path, hold.code, hold.reason]).sort()).toEqual([['notes/example.md', 'page_identity_changed', 'spelling'], ['notes\\example.md', 'page_identity_changed', 'spelling']]);
    expect(await engine.executeRaw("SELECT intent->>'path' AS path FROM persistence_requests WHERE source_id=$1 AND intent->>'kind' <> 'managed_sync_checkpoint' ORDER BY path", [f.id])).toEqual([{ path: 'notes/untouched.md' }]);
    expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
    expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
    expect((await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(target);
  } else {
    // #6712 PR 4b: the first pass reads the whole level, so the unchanged notes/untouched.md, which has no page yet, is
    // imported beside the changed file (the cursor's incremental delta saw only the change). The historical origin's page
    // is untouched (below).
    const result = await performManagedSync(engine, opts);
    expect(result).toMatchObject({ status: 'synced', fromCommit: f.head, toCommit: target, deleted: 0, filesImported: 2 });
    const requests = await engine.executeRaw<{ intent: SyncIntent; state: string }>('SELECT intent,state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
    expect(requests).toHaveLength(3);
    expect(requests.every(row => row.state === 'committed')).toBe(true);
    expect(requests.slice(0, 2).map(row => row.intent).sort((a, b) => a.path!.localeCompare(b.path!))).toEqual([
      expect.objectContaining({ kind: 'managed_sync_import', path: 'notes/example.md', from: f.head, target }),
      expect.objectContaining({ kind: 'managed_sync_import', path: 'notes/untouched.md', from: f.head, target })]);
    expect(requests[2].intent.kind).toBe('managed_sync_checkpoint');
    expect((await engine.getPage('notes/untouched', { sourceId: f.id }))?.source_path).toBe('notes/untouched.md');
    expect((await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(target);
    if (process.platform === 'win32' && alias) expect(await engine.getPage('notes/example', { sourceId: f.id })).toBeNull();
  }
  expect((await engine.getPage(f.slug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
  expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
  expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toBe(revised);
  if (process.platform !== 'win32') expect(readFileSync(join(f.root, literal), 'utf8')).toBe(content);
});

check('deleting an unowned filename is not a pass candidate and preserves the live or tombstoned foreign-origin page', async engine => {
  for (const deleted of [false, true]) {
    const f = await fixture(engine, 'notes/recorded.md', 'notes/example', {
      'notes/recorded.md': content, 'notes/example.md': content,
    });
    await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], async () => {
      await tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [f.id, f.head]);
      if (deleted) await tx.softDeletePage(f.slug, { sourceId: f.id });
    }, TEST_WRITE_ATTRIBUTION));
    const before = await engine.readPageSnapshot(f.slug, { sourceId: f.id, includeDeleted: true });
    const history = await engine.getVersions(f.slug, { sourceId: f.id });
    unlinkSync(join(f.root, 'notes/example.md'));
    await gitAsync(f.root, 'add', '-A');
    await gitAsync(f.root, 'commit', '-qm', 'Remove only an unowned duplicate');
    const target = (await gitAsync(f.root, 'rev-parse', 'HEAD')).trim();
    const opts = { ...f.opts, full: false };
    expect(await performManagedSync(engine, { ...opts, dryRun: true })).toMatchObject({ status: 'dry_run' });
    const result = await performManagedSync(engine, opts);
    expect(result).toMatchObject({ status: 'synced', deleted: 0, filesImported: 0, toCommit: target, pass: { kind: 'full', outcome: 'synced', candidates: 0 } });
    expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id, includeDeleted: true })).toEqual(before);
    expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
    expect(readFileSync(join(f.root, 'notes/recorded.md'), 'utf8')).toBe(content);
    // No page claims notes/example.md, so the pass has nothing to delete: the checkpoint is its only request.
    const requests = await engine.executeRaw<{ kind: string; state: string }>("SELECT intent->>'kind' AS kind,state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence", [f.id]);
    expect(requests).toEqual([{ kind: 'managed_sync_checkpoint', state: 'committed' }]);
    expect((await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(target);
    // A tombstone whose recorded file is still in the tree is a deletion the file never saw: held, never revived.
    const holds = ((await readGitSourceHolds(engine, { sourceIds: [f.id] }))[0]?.holds ?? []).map(hold => ({ path: hold.path, code: hold.code, side: hold.meta.side, state: hold.meta.state }));
    expect(holds).toEqual(deleted ? [{ path: 'notes/recorded.md', code: 'file_drift', side: 'deleted', state: 'tombstone_edited' }] : []);
  }
});

check('a committed Git deletion of a page no sync import recorded is held file_drift (deleted, file_gone): the page stays live and only the checkpoint commits', async engine => {
  const f = await fixture(engine);
  await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [f.id, f.head]), TEST_WRITE_ATTRIBUTION));
  const history = await engine.getVersions(f.slug, { sourceId: f.id });
  unlinkSync(join(f.root, 'notes/example.md'));
  await gitAsync(f.root, 'add', '-A');
  await gitAsync(f.root, 'commit', '-qm', 'Commit the intentional source deletion');
  const target = (await gitAsync(f.root, 'rev-parse', 'HEAD')).trim();
  expect(computeSyncDelta(f.root, f.head, target)).toMatchObject({ status: 'ok', manifest: { deleted: ['notes/example.md'] } });
  expect(await performManagedSync(engine, { ...f.opts, full: false, dryRun: true })).toMatchObject({ status: 'dry_run' });
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
  // The page was imported outside sync (no import record), so nothing proves the database still holds the deleted file's bytes.
  const result = await performManagedSync(engine, { ...f.opts, full: false });
  expect(result).toMatchObject({ status: 'synced', deleted: 0, filesImported: 0, fromCommit: f.head, toCommit: target, pass: { kind: 'full', outcome: 'synced', candidates: 0 } });
  expect(result.held?.map(item => [item.path, item.code])).toEqual([['notes/example.md', 'file_drift']]);
  const [hold] = (await readGitSourceHolds(engine, { sourceIds: [f.id] }))[0]!.holds;
  expect(hold!.meta).toMatchObject({ side: 'deleted', state: 'file_gone' });
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
  const requests = await engine.executeRaw<{ intent: SyncIntent; state: string }>('SELECT intent,state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
  expect(requests.map(row => [row.intent.kind, row.state])).toEqual([['managed_sync_checkpoint', 'committed']]);
  expect((await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(target);
  expect(await performManagedSync(engine, { ...f.opts, full: false })).toMatchObject({ status: 'up_to_date', deleted: 0 });
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(1);
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
});

// #6712 PR 4b: the pass reads no manifest. It retires an older binary's unfinished cursor, so the deletion that cursor froze
// for a file still in the tree is never admitted: no deletion request, the page as it was, and the source checkpoints HEAD.
check("an older binary's unfinished cursor freezing a present file's deletion is retired by the pass, which admits no deletion and keeps the page", async engine => {
  const f = await fixture(engine, process.platform === 'win32' ? 'notes\\example.md' : 'notes/example.md');
  const legacy = await legacyDeletion(engine, f, false);
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'first_sync', deleted: 0, pass: { outcome: 'synced' } });
  expect(await deleteRequests(engine, f.id)).toEqual([]);
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(keptSnapshot(f));
  expect(await legacyRows(engine, legacy)).toEqual([]);
  expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(f.head);
  expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toBe(content);
});

// #6712 PR 4b: the pass retires the older cursor and cancels its admitted deletion under that request's original id, with the
// accepted intent unchanged; the pass mints no deletion of its own for the present file, and the next sync stays clean.
check('an already-admitted legacy deletion is cancelled under its original ID with its intent unchanged; the pass keeps the page and the next sync stays clean', async engine => {
  const f = await fixture(engine, process.platform === 'win32' ? 'notes\\example.md' : 'notes/example.md');
  const legacy = await legacyDeletion(engine, f, true);
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'first_sync', deleted: 0, pass: { outcome: 'synced' } });
  const row = (await getWriteRequest(engine, legacy.cursor.authority.writer.principal, legacy.requestId))!;
  expect({ state: row.state, error_code: row.error_code }).toEqual({ state: 'cancelled', error_code: 'cancelled' });
  expect(row.intent).toEqual(legacy.intent);
  expect(await deleteRequests(engine, f.id)).toEqual([{ request_id: legacy.requestId, state: 'cancelled', error_code: 'cancelled' }]);
  expect(await legacyRows(engine, legacy)).toEqual([]);
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(keptSnapshot(f));
  expect(['synced', 'up_to_date']).toContain((await performManagedSync(engine, f.opts)).status);
  expect(await getWriteRequest(engine, legacy.cursor.authority.writer.principal, legacy.requestId)).toEqual(row);
  expect(await deleteRequests(engine, f.id)).toHaveLength(1);
  expect((await engine.getPage(f.slug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
  expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toBe(content);
});

check('an explicit working-tree deletion of a page no sync import recorded is held file_drift (deleted, file_gone), even when the pinned Git target contains the file', async engine => {
  const f = await fixture(engine);
  unlinkSync(join(f.root, 'notes/example.md'));
  const result = await performManagedSync(engine, { ...f.opts, workingTree: true });
  // --working-tree differs from the configured mode, so the pass converges selection-scoped and stamps no checkpoint.
  expect(result).toMatchObject({ status: 'synced', reason: 'selection_scoped', deleted: 0, pass: { kind: 'full', outcome: 'synced', candidates: 0 } });
  expect(result.held?.map(item => [item.path, item.code])).toEqual([['notes/example.md', 'file_drift']]);
  const [hold] = (await readGitSourceHolds(engine, { sourceIds: [f.id] }))[0]!.holds;
  expect(hold!.meta).toMatchObject({ side: 'deleted', state: 'file_gone' });
  expect((await engine.getPage(f.slug, { sourceId: f.id }))?.id).toBe(f.snapshot.page.id);
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
  expect(await engine.executeRaw("SELECT intent FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_delete'", [f.id])).toEqual([]);
  expect((await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBeNull();
});

check('native case aliases refuse rather than merge distinct origins', async engine => {
  const f = await fixture(engine, 'Notes/example.md', 'notes/example', { 'Notes/example.md': content, 'other.md': 'An unrelated synthetic note.\n' });
  const object = (await gitAsync(f.root, 'rev-parse', 'HEAD:Notes/example.md')).trim();
  await gitAsync(f.root, '-c', 'core.ignorecase=false', 'update-index', '--add', '--cacheinfo', `100644,${object},notes/example.md`);
  await gitAsync(f.root, 'commit', '-qm', 'Add case-distinct tree entry');
  if (process.platform !== 'win32') {
    mkdirSync(join(f.root, 'notes'), { recursive: true });
    writeFileSync(join(f.root, 'notes/example.md'), content);
  }
  // GBRA-130 B-3 (was: the pass refused page_identity_changed): the case spellings are held, neither is imported or
  // deleted, and an unrelated file in the same sync imports.
  const result = await performManagedSync(engine, f.opts);
  const held = result.held?.map(hold => [hold.path, hold.code, hold.reason]).sort();
  if (process.platform === 'linux') expect(held).toEqual([['Notes/example.md', 'page_identity_changed', 'spelling'], ['notes/example.md', 'page_identity_changed', 'spelling']]);
  else for (const hold of held ?? []) expect(hold).toEqual([expect.stringMatching(/^[Nn]otes\/example\.md$/), 'page_identity_changed', 'spelling']);
  expect(held?.length).toBeGreaterThan(0);
  expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  expect(await engine.executeRaw("SELECT intent->>'path' AS path FROM persistence_requests WHERE source_id=$1 AND intent->>'kind' <> 'managed_sync_checkpoint' ORDER BY path", [f.id])).toEqual([{ path: 'other.md' }]);
  expect(readFileSync(join(f.root, 'Notes/example.md'), 'utf8')).toBe(content);
  expect(readFileSync(join(f.root, 'notes/example.md'), 'utf8')).toBe(content);
});

// #6712 PR 4b: a legacy deletion request an older binary admitted can still reach preparation; with no manifest entry
// behind it, it fails closed even when the file is gone, and its accepted intent is not rewritten.
check('unknown old deletion manifests fail closed without rewriting accepted request identity', async engine => {
  const f = await fixture(engine);
  unlinkSync(join(f.root, 'notes/example.md'));
  await gitAsync(f.root, 'add', '-A');
  await gitAsync(f.root, 'commit', '-qm', 'Remove the synthetic source file');
  const legacy = await legacyDeletion(engine, f, true);
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [legacy.cursor.runId]);
  const row = (await getWriteRequest(engine, legacy.cursor.authority.writer.principal, legacy.requestId))!;
  await expect(prepareManagedSyncMutation(engine, row, { engine: engine.kind })).rejects.toMatchObject({ code: 'page_identity_changed' });
  expect((await getWriteRequest(engine, legacy.cursor.authority.writer.principal, legacy.requestId))?.intent).toEqual(legacy.intent);
  expect((await engine.readPageSnapshot(f.slug, { sourceId: f.id }))?.revision).toBe(f.snapshot.revision);
  await engine.executeRaw("UPDATE persistence_requests SET state='cancelled' WHERE id=$1::uuid", [row.id]);
});

// #6712 PR 4b: the pass reads pages by their recorded origin. A synced page whose origin was cleared, and whose file is
// gone, is no deletion candidate and no hold: it stays live, and an older binary's admitted deletion of it is cancelled with
// its intent unchanged.
check('a pass never infers a missing page origin from its slug: the origin-less page stays live and an admitted legacy deletion of it is cancelled unchanged', async engine => {
  const f = await fixture(engine);
  expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
  unlinkSync(join(f.root, 'notes/example.md'));
  await gitAsync(f.root, 'add', '-A');
  await gitAsync(f.root, 'commit', '-qm', 'Remove the synthetic source file');
  await engine.executeRaw('UPDATE pages SET source_path=NULL WHERE id=$1', [f.snapshot.page.id]);
  const before = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
  const legacy = await legacyDeletion(engine, f, true);
  const result = await performManagedSync(engine, { ...f.opts, full: false });
  expect(result).toMatchObject({ status: 'synced', deleted: 0 });
  expect(result.held ?? []).toEqual([]);
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(before);
  expect(before.page.deleted_at ?? null).toBeNull();
  expect(await deleteRequests(engine, f.id)).toEqual([{ request_id: legacy.requestId, state: 'cancelled', error_code: 'cancelled' }]);
  expect((await getWriteRequest(engine, legacy.cursor.authority.writer.principal, legacy.requestId))?.intent).toEqual(legacy.intent);
});

// #6712 PR 4b: a pass's working-tree deletion is re-validated at publication. A change made after the consumer prepared it
// (the file recreated, the brain deactivated, the configured root moved, the page's origin cleared) refuses it under the
// request id the pass admitted it with, its intent unchanged; the page keeps its revision and last_commit does not move.
check("a pass's working-tree deletion publication revalidates a recreated file, activation, the configured root and the origin after preparation", async engine => {
  for (const change of ['file', 'activation', 'configured-root', 'origin'] as const) {
    const f = await fixture(engine);
    const opts = { ...f.opts, workingTree: true };
    expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'synced', reason: 'selection_scoped' });
    const before = (await engine.readPageSnapshot(f.slug, { sourceId: f.id }))!;
    unlinkSync(join(f.root, 'notes/example.md'));
    let prepared: { request_id: string; intent: SyncIntent } | null = null;
    installFaultHook(async point => {
      if (point !== 'consumer:prepared' || prepared) return;
      const [running] = await engine.executeRaw<{ request_id: string; intent: SyncIntent }>(
        "SELECT request_id::text AS request_id, intent FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_delete' AND state='running'", [f.id]);
      if (!running) return;
      prepared = running;
      if (change === 'file') writeFileSync(join(f.root, 'notes/example.md'), content);
      else if (change === 'activation') await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      else if (change === 'origin') await engine.executeRaw('UPDATE pages SET source_path=NULL WHERE id=$1', [f.snapshot.page.id]);
      else await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
        await tx.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [f.id, home]);
      });
    });
    let result;
    try { result = await performManagedSync(engine, opts); }
    finally { installFaultHook(undefined); await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
    expect(prepared).not.toBeNull();
    const { request_id: requestId, intent } = prepared!;
    expect(requestId).toBe(passRequestId(intent.passId!, 'notes/example.md', null));
    const code = change === 'activation' ? 'writer_coordinator_required' : change === 'origin' ? 'page_identity_changed' : 'source_changed';
    const [published] = await engine.executeRaw<{ state: string; error_code: string | null; intent: SyncIntent }>(
      'SELECT state, error_code, intent FROM persistence_requests WHERE source_id=$1 AND request_id=$2::uuid', [f.id, requestId]);
    expect(published!.state).not.toBe('committed');
    expect(published!.error_code).toBe(code);
    expect(published!.intent).toEqual(intent);
    expect((await deleteRequests(engine, f.id)).map(row => row.request_id)).toEqual([requestId]);
    const page = await engine.readPageSnapshot(f.slug, { sourceId: f.id, includeDeleted: true });
    expect(page?.revision).toBe(before.revision);
    expect(page?.page.deleted_at ?? null).toBeNull();
    expect((await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBeNull();
    // A recreated file is the level moving: the pass passes the refused deletion over and the next round settles the file.
    if (change === 'file') expect(result).toMatchObject({ status: 'synced', reason: 'selection_scoped', deleted: 0 });
    else expect(result).toMatchObject({ status: 'blocked_by_failures', deleted: 0, pass: { outcome: 'blocked' } });
  }
});

check('an exact recorded origin retains its existing slug on every native platform', async engine => {
  const f = await fixture(engine, 'notes/recorded.md', 'notes/example', { 'notes/recorded.md': content });
  const canonical = serializePageToMarkdown(f.snapshot.page, f.snapshot.tags).replace(/^---\n/, '---\nslug: notes/example\n');
  writeFileSync(join(f.root, 'notes/recorded.md'), canonical);
  await gitAsync(f.root, 'add', '-A');
  await gitAsync(f.root, 'commit', '-qm', 'Export existing canonical identity');
  const history = await engine.getVersions(f.slug, { sourceId: f.id });
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'first_sync', added: 0, modified: 0, deleted: 0 });
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
  expect(await engine.getVersions(f.slug, { sourceId: f.id })).toEqual(history);
  expect(readFileSync(join(f.root, 'notes/recorded.md'), 'utf8')).toBe(canonical);
  writeFileSync(join(f.root, 'notes/recorded.md'), canonical.replace('slug: notes/example', 'slug: notes/impostor'));
  await gitAsync(f.root, 'add', '-A');
  await gitAsync(f.root, 'commit', '-qm', 'Attempt a different canonical identity');
  // #5988: the conflicting identity is held, never imported, instead of blocking the sync.
  const held = await performManagedSync(engine, { ...f.opts, full: false });
  expect(held.held?.map(item => [item.path, item.code])).toEqual([['notes/recorded.md', 'frontmatter_slug_conflict']]);
  expect(await engine.readPageSnapshot(f.slug, { sourceId: f.id })).toEqual(f.snapshot);
  expect(await engine.getPage('notes/impostor', { sourceId: f.id })).toBeNull();
});
