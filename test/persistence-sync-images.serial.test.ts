import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as imageImport from '../src/core/import-file.ts';
import * as realEmbedding from '../src/core/embedding.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { withEnv } from './helpers/with-env.ts';
import { interruptAfterSyncDiscovery } from './helpers/persistence-sync-interruption.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { freezeSyncContent, thawSyncContent, MAX_SYNC_BYTES } from '../src/core/persistence/sync-content.ts';
import { digest, sha256 } from '../src/core/persistence/digest.ts';

// Never infer an image-test fixture from the operator's ambient DATABASE_URL.
const postgresUrl = process.env.GBRAIN_TEST_SYNC_IMAGES_POSTGRES_URL;
const pooledUrl = process.env.GBRAIN_TEST_SYNC_IMAGES_PGBOUNCER_URL;
if (process.env.GBRAIN_TEST_REQUIRE_SYNC_IMAGES_POSTGRES === '1' && !postgresUrl) {
  throw new Error('Managed image sync requires GBRAIN_TEST_SYNC_IMAGES_POSTGRES_URL.');
}
if ((pooledUrl || process.env.GBRAIN_TEST_REQUIRE_SYNC_IMAGES_PGBOUNCER === '1') && (!postgresUrl || !pooledUrl)) {
  throw new Error('Managed image sync through PgBouncer requires dedicated direct and pooled fixture URLs.');
}
// Validate every configured endpoint before creating or connecting any database.
if (postgresUrl) assertSafeE2eDatabaseUrl(postgresUrl);
if (pooledUrl) assertSafeE2eDatabaseUrl(pooledUrl);
const pooledEnv = { GBRAIN_PREPARE: 'false', GBRAIN_DISABLE_DIRECT_POOL: '1', GBRAIN_DIRECT_DATABASE_URL: undefined };

let lastInputs: unknown[] = [];
let calls = 0, provider: (() => Promise<void>) | undefined;
mock.module('../src/core/embedding.ts', () => ({ ...realEmbedding, embedMultimodal: async (inputs: unknown[]) => {
  calls++; lastInputs = inputs; await provider?.(); return inputs.map(() => new Float32Array(1024).fill(0.125));
} }));
const { performManagedSync } = await import('../src/core/persistence/sync-run.ts');
const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
const { claimWorktree, getWorktreeBinding, acquireWorktree } = await import('../src/core/persistence/ownership.ts');
const { prepareManagedSyncMutation } = await import('../src/core/persistence/sync-prepare.ts');
const { discoverManagedSync, readSyncBytes, readSyncFile } = await import('../src/core/persistence/sync-discovery.ts');
const home = mkdtempSync(join(tmpdir(), 'managed-sync-images-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBEDDING_IMAGE_OCR: 'false' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const changed = Buffer.concat([png, Buffer.from([0, 255, 128, 1])]);
const newer = Buffer.concat([png, Buffer.from([0, 255, 128, 2])]);
const stores: Array<{ route: 'pglite' | 'postgres' | 'pgbouncer'; engine: BrainEngine; close: () => Promise<void> }> = [];
beforeAll(async () => {
  const lite = new PGLiteEngine();
  stores.push({ route: 'pglite', engine: lite, close: () => lite.disconnect() });
  await lite.connect({}); await lite.initSchema();
  if (postgresUrl) stores.push({ route: 'postgres', ...await isolatedPersistencePostgres(postgresUrl) });
  if (postgresUrl && pooledUrl) {
    // CREATE/init/DROP stay on the safe direct helper; only test traffic is pooled.
    const pg = await isolatedPersistencePostgres(postgresUrl);
    stores.push({ route: 'pgbouncer', ...pg });
    await pg.engine.disconnect();
    const url = new URL(pooledUrl); url.pathname = new URL(pg.databaseUrl).pathname;
    await withEnv(pooledEnv, () => pg.engine.connect({ database_url: url.toString(), poolSize: 4 }));
  }
  for (const { engine } of stores) {
    // Text outbox work is not under test; keep it dormant even in provider-failure controls.
    await engine.executeRaw("ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT (now()+interval '1 hour')");
  }
}, 120_000);
afterAll(async () => {
  try {
    const results = await withEnv(env, () => Promise.allSettled(stores.map(async store => {
      try { await disposePersistenceConsumer(store.engine); } finally { await store.close(); }
    })));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Managed image sync fixture cleanup failed.');
  } finally { rmSync(home, { recursive: true, force: true }); mock.restore(); }
});
function git(root: string, ...args: string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim(); }
function commit(root: string) { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'Synthetic fixture change'); return git(root, 'rev-parse', 'HEAD'); }
async function fixture(engine: BrainEngine, files: Record<string, string | Buffer>, subpath?: string) {
  await disposePersistenceConsumer(engine); provider = undefined;
  const id = `images-${randomUUID().slice(0, 12)}`, root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (const [path, bytes] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), bytes); }
  const head = commit(root), sourceRoot = subpath ? join(root, subpath) : root;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, sourceRoot]);
  await claimWorktree(engine, id, sourceRoot);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, sourceRoot, head, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true, noSchemaPack: true } };
}
async function anchor(engine: BrainEngine, id: string) { return (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0].last_commit; }
const check = (name: string, run: (engine: BrainEngine) => void | Promise<void>) => test(name, () => withEnv(env, async () => {
  const fetch = globalThis.fetch; let network = 0;
  globalThis.fetch = Object.assign(async () => { network++; throw new Error('Network forbidden in managed sync fixture'); }, { preconnect: fetch.preconnect });
  try {
    for (const { route, engine } of stores) {
      await withEnv(route === 'pgbouncer' ? pooledEnv : {}, async () => { await run(engine); });
      expect(network).toBe(0);
      console.info(`MANAGED_SYNC_IMAGES route=${route} engine=${engine.kind} passed=${JSON.stringify(name)}`);
    }
  } finally { provider = undefined; globalThis.fetch = fetch; }
}), 120_000);

check('mixed Markdown and binary images sync provider-free with durable exact base64 bytes', async engine => {
  const f = await fixture(engine, { 'a.md': 'A synthetic source observation.\n', 'images/Photo One.PNG': png }), before = calls;
  await expect(performManagedSync(engine, { ...f.opts, noPull: false })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
  expect(await performManagedSync(engine, { ...f.opts, dryRun: true })).toMatchObject({ status: 'dry_run' });
  expect(await anchor(engine, f.id)).toBeNull();
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'first_sync', added: 2, filesImported: 2 });
  expect(calls).toBe(before); expect(readFileSync(join(f.root, 'images/Photo One.PNG'))).toEqual(png);
  const page = await engine.getPage('images/photo one.png', { sourceId: f.id });
  expect(page).toMatchObject({ type: 'image', source_path: 'images/Photo One.PNG', content_hash: sha256(png) });
  expect(await engine.getFile(f.id, 'images/Photo One.PNG')).toMatchObject({ page_id: page!.id, content_hash: sha256(png), size_bytes: engine.kind === 'postgres' ? BigInt(png.length) : png.length });
  const [row] = await engine.executeRaw<{ intent: any }>("SELECT intent FROM persistence_requests WHERE source_id=$1 AND slug='images/photo one.png'", [f.id]);
  expect(row.intent).toMatchObject({ content: null, binaryContent: png.toString('base64'), contentEncoding: 'base64', contentHash: sha256(png), lineEndingOnly: false, processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: true } });
  expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE source_id=$1 AND kind='embedding'", [f.id])).toEqual([]);
  expect(await anchor(engine, f.id)).toBe(f.head);
});
check('image changes, additions, renames and deletions advance only complete sync manifests', async engine => {
  const f = await fixture(engine, { 'first.png': png, 'rename.png': png });
  await performManagedSync(engine, f.opts);
  writeFileSync(join(f.root, 'first.png'), changed); renameSync(join(f.root, 'rename.png'), join(f.root, 'renamed.png')); writeFileSync(join(f.root, 'added.png'), png); const next = commit(f.root);
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'synced', deleted: 1, filesImported: 4 });
  expect(await engine.getPage('rename.png', { sourceId: f.id })).toBeNull();
  expect(await engine.getPage('renamed.png', { sourceId: f.id })).not.toBeNull();
  expect(await engine.getPage('first.png', { sourceId: f.id })).toMatchObject({ content_hash: sha256(changed) });
  expect(await anchor(engine, f.id)).toBe(next);
  rmSync(join(f.root, 'first.png')); const last = commit(f.root);
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ deleted: 1 });
  expect(await engine.getPage('first.png', { sourceId: f.id })).toBeNull(); expect(await anchor(engine, f.id)).toBe(last);
});
check('nested source-root image identity does not include the surrounding repository prefix', async engine => {
  const f = await fixture(engine, { 'wiki/images/Photo.PNG': png, 'outside.png': png }, 'wiki');
  await performManagedSync(engine, f.opts);
  expect(await engine.getPage('images/photo.png', { sourceId: f.id })).toMatchObject({ source_path: 'images/Photo.PNG' });
  expect(await engine.getPage('wiki/images/photo.png', { sourceId: f.id })).toBeNull();
  expect(await engine.getPage('outside.png', { sourceId: f.id })).toBeNull();
});
check('pinned Git image imports preserve dirty or absent working-tree bytes; opt-in imports current bytes', async engine => {
  for (const absent of [false, true]) {
    const f = await fixture(engine, { 'photo.png': png });
    if (absent) rmSync(join(f.root, 'photo.png')); else writeFileSync(join(f.root, 'photo.png'), changed);
    await performManagedSync(engine, f.opts);
    expect(await engine.getPage('photo.png', { sourceId: f.id })).toMatchObject({ content_hash: sha256(png) });
    if (absent) expect(existsSync(join(f.root, 'photo.png'))).toBe(false); else expect(readFileSync(join(f.root, 'photo.png'))).toEqual(changed);
    await performManagedSync(engine, { ...f.opts, workingTree: true });
    if (absent) expect(await engine.getPage('photo.png', { sourceId: f.id })).toBeNull();
    else expect(await engine.getPage('photo.png', { sourceId: f.id })).toMatchObject({ content_hash: sha256(changed) });
  }
});
check('provider preparation receives pinned binary bytes rather than dirty worktree data', async engine => {
  const f = await fixture(engine, { 'photo.png': png }); writeFileSync(join(f.root, 'photo.png'), changed);
  provider = async () => {
    expect(lastInputs).toEqual([{ kind: 'image_base64', data: png.toString('base64'), mime: 'image/png' }]);
    expect(await engine.getPage('photo.png', { sourceId: f.id })).toBeNull(); expect(await anchor(engine, f.id)).toBeNull();
  };
  expect(await performManagedSync(engine, { ...f.opts, noEmbed: false })).toMatchObject({ status: 'first_sync' });
  expect(readFileSync(join(f.root, 'photo.png'))).toEqual(changed);
  expect(await engine.getPage('photo.png', { sourceId: f.id })).toMatchObject({ content_hash: sha256(png) });
});
check('provider failure blocks the image and final anchor; replay retains its UUID and explicit retry replaces only failed work', async engine => {
  const f = await fixture(engine, { 'a.md': 'A committed synthetic observation.\n', 'z.png': png });
  provider = async () => { expect(await engine.getPage('z.png', { sourceId: f.id })).toBeNull(); throw new Error('synthetic provider failure'); };
  const opts = { ...f.opts, noEmbed: false }, first = await performManagedSync(engine, opts);
  expect(first).toMatchObject({ status: 'blocked_by_failures', filesImported: 1 }); expect(await anchor(engine, f.id)).toBeNull();
  expect(await engine.getPage('z.png', { sourceId: f.id })).toBeNull(); expect(await engine.getFile(f.id, 'z.png')).toBeNull();
  const request = first.managedWrite!.write_request.request_id, before = calls;
  expect((await performManagedSync(engine, opts)).managedWrite!.write_request.request_id).toBe(request); expect(calls).toBe(before);
  provider = async () => { expect(await engine.getPage('z.png', { sourceId: f.id })).toBeNull(); expect(await anchor(engine, f.id)).toBeNull(); };
  expect(await performManagedSync(engine, { ...opts, retryFailed: true })).toMatchObject({ status: 'first_sync' });
  expect(await anchor(engine, f.id)).toBe(f.head);
  expect(await engine.executeRaw('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [request])).toEqual([{ state: 'failed' }]);
  expect(await engine.executeRaw('SELECT vector_dims(embedding_image) AS dims FROM content_chunks WHERE page_id=$1', [(await engine.getPage('z.png', { sourceId: f.id }))!.id])).toEqual([{ dims: 1024 }]);
});
check('worktree bytes changing during provider preparation conflict before image publication', async engine => {
  const f = await fixture(engine, { 'photo.png': png });
  provider = async () => { writeFileSync(join(f.root, 'photo.png'), changed); };
  expect(await performManagedSync(engine, { ...f.opts, noEmbed: false })).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_error: 'source_changed' } });
  expect(await engine.getPage('photo.png', { sourceId: f.id })).toBeNull(); expect(await anchor(engine, f.id)).toBeNull();
  expect(readFileSync(join(f.root, 'photo.png'))).toEqual(changed);
});
check('canonical revision and owner races during image preparation preserve newer state and the anchor', async engine => {
  for (const race of ['revision', 'owner']) {
    const f = await fixture(engine, { 'photo.png': png });
    provider = async () => {
      if (race === 'owner') {
        const binding = (await getWorktreeBinding(engine, f.id))!;
        await engine.executeRaw('UPDATE persistence_worktrees SET owner_epoch=owner_epoch+1 WHERE id=$1::uuid', [binding.worktree_id]);
      } else await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.putPage('photo.png', { type: 'note', title: 'Newer', compiled_truth: 'Newer accepted state.', timeline: '', frontmatter: {}, content_hash: 'newer' }, { sourceId: f.id })));
    };
    const result = await performManagedSync(engine, { ...f.opts, noEmbed: false });
    expect(result.status === 'blocked_by_failures' || result.status === 'partial').toBe(true); expect(await anchor(engine, f.id)).toBeNull();
    expect(await engine.getFile(f.id, 'photo.png')).toBeNull();
    if (race === 'revision') expect(await engine.getPage('photo.png', { sourceId: f.id })).toMatchObject({ compiled_truth: 'Newer accepted state.' });
    else expect(await engine.getPage('photo.png', { sourceId: f.id })).toBeNull();
  }
});
check('interrupted mixed sync resumes pinned binary target with immutable processing consent', async engine => {
  const f = await fixture(engine, { 'a.md': 'Synthetic text preceding a binary image.\n', 'z.png': png });
  const first = await performManagedSync(engine, f.opts, { maxPages: 1, maxMs: 1000 });
  expect(first).toMatchObject({ status: 'partial', filesImported: 1 }); expect(await anchor(engine, f.id)).toBeNull();
  const manifest = await engine.executeRaw("SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [first.runId]);
  writeFileSync(join(f.root, 'z.png'), changed); const head = commit(f.root);
  for (const option of ['noEmbed', 'noExtract', 'noSchemaPack']) await expect(performManagedSync(engine, { ...f.opts, [option]: false })).rejects.toMatchObject({ code: 'invalid_params' });
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'first_sync', runId: first.runId, toCommit: f.head });
  expect(await engine.getPage('z.png', { sourceId: f.id })).toMatchObject({ content_hash: sha256(png) });
  expect(readFileSync(join(f.root, 'z.png'))).toEqual(changed);
  expect(await engine.executeRaw("SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [first.runId])).toEqual(manifest);
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ toCommit: head });
  expect(await engine.getPage('z.png', { sourceId: f.id })).toMatchObject({ content_hash: sha256(changed) });
});
check('pinned image update cannot roll back a canonical page when current worktree disagrees', async engine => {
  const f = await fixture(engine, { 'photo.png': png }); await performManagedSync(engine, f.opts);
  writeFileSync(join(f.root, 'photo.png'), changed); commit(f.root); writeFileSync(join(f.root, 'photo.png'), newer);
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_error: 'source_changed' } });
  expect(await anchor(engine, f.id)).toBe(f.head); expect(readFileSync(join(f.root, 'photo.png'))).toEqual(newer);
  expect(await engine.getPage('photo.png', { sourceId: f.id })).toMatchObject({ content_hash: sha256(png) });
});
check('pinned symlink images and malformed UTF-8 text fail closed', async engine => {
  const f = await fixture(engine, { 'target.png': png, 'note.md': 'Valid text.\n' });
  symlinkSync('target.png', join(f.root, 'alias.png')); commit(f.root);
  rmSync(join(f.root, 'alias.png')); writeFileSync(join(f.root, 'alias.png'), png);
  const discovery = await discoverManagedSync(engine, f.opts);
  expect(() => readSyncBytes(discovery, discovery.entries.find(e => e.path === 'alias.png')!)).toThrow('regular Git blob');
  const bad = await fixture(engine, { 'bad.md': Buffer.from([0xff, 0xfe, 0x80]) });
  await expect(performManagedSync(engine, bad.opts)).rejects.toMatchObject({ code: 'invalid_params' }); expect(await anchor(engine, bad.id)).toBeNull();
});
check('frozen content accepts legacy text only and rejects unknown codecs, type mismatches and malformed binary', () => {
  const f = freezeSyncContent('photo.png', png); expect(thawSyncContent('photo.png', f.content, f.contentEncoding, f.contentHash)).toEqual(png);
  expect(thawSyncContent('note.md', 'Legacy text\r\n', undefined, undefined).toString()).toBe('Legacy text\r\n');
  for (const [path, content, encoding, hash] of [
    ['photo.png', f.content, undefined, f.contentHash], ['photo.png', f.content, 'utf8', f.contentHash], ['photo.png', f.content, 'rot13', f.contentHash],
    ['photo.png', f.content + '\n', 'base64', f.contentHash], ['photo.png', '!!!!', 'base64', f.contentHash], ['photo.png', f.content, 'base64', 'wrong'],
    ['note.md', f.content, 'base64', f.contentHash], ['note.md', '\ud800', 'utf8', undefined], ['file.bin', 'text', 'utf8', undefined],
  ]) expect(() => thawSyncContent(path!, content, encoding, hash)).toThrow();
});

check('pending image sync resumes the same request UUID and binary intent after owner lock release', async engine => {
  const f = await fixture(engine, { 'photo.png': png }), lock = await acquireWorktree((await getWorktreeBinding(engine, f.id))!);
  expect(lock).not.toBeNull();
  try {
    const first = await performManagedSync(engine, f.opts);
    expect(first).toMatchObject({ status: 'partial', reason: 'writer_pending', filesImported: 0 });
    const id = first.managedWrite!.write_request.request_id;
    const frozen = await engine.executeRaw('SELECT intent FROM persistence_requests WHERE request_id=$1::uuid', [id]);
    expect(await anchor(engine, f.id)).toBeNull(); expect(await engine.getPage('photo.png', { sourceId: f.id })).toBeNull();
    expect(await performManagedSync(engine, { ...f.opts, retryFailed: true })).toMatchObject({ status: 'partial', managedWrite: { write_request: { request_id: id } } });
    expect(await engine.executeRaw('SELECT intent FROM persistence_requests WHERE request_id=$1::uuid', [id])).toEqual(frozen);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(1);
    const [accepted] = await engine.executeRaw<import('../src/core/persistence/model.ts').WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [id]);
    expect((await prepareManagedSyncMutation(engine, accepted, { engine: engine.kind })).observedRevision).toBeNull();
    for (const [invalid, code] of [
      [{ contentEncoding: 'utf8' }, 'invalid_params'], [{ contentEncoding: undefined }, 'invalid_params'],
      [{ binaryContent: '!!!!' }, 'invalid_params'], [{ contentHash: 'wrong' }, 'source_changed'],
      [{ content: png.toString('base64') }, 'invalid_params'], [{ processingOptions: undefined }, 'invalid_params'],
    ] as const) {
      await expect(prepareManagedSyncMutation(engine, { ...accepted, intent: { ...accepted.intent, ...invalid } }, { engine: engine.kind })).rejects.toMatchObject({ code });
    }
    expect(await engine.executeRaw('SELECT intent FROM persistence_requests WHERE request_id=$1::uuid', [id])).toEqual(frozen);
    await lock!.release();
    expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'first_sync', filesImported: 1 });
    expect(await engine.executeRaw('SELECT request_id,state FROM persistence_requests WHERE request_id=$1::uuid', [id])).toEqual([{ request_id: id, state: 'committed' }]);
    expect(await anchor(engine, f.id)).toBe(f.head);
  } finally { await lock?.release(); await disposePersistenceConsumer(engine); }
});

function oldCursorKey(value: any) {
  return digest({ source: value.incarnation, principal: value.authority.writer.principal, authority: value.authority,
    options: { full: false, workingTree: false, srcSubpath: null, exclude: [], includeHidden: [], strategy: null } });
}
check('fresh binary manifests are invisible to legacy cursor lookup while legacy text resumes unchanged', async engine => {
  const f = await fixture(engine, { 'a.md': 'First original text.\n', 'b.md': 'Second original text.\n' });
  const first = await performManagedSync(engine, f.opts, { maxPages: 1, maxMs: 1000 });
  const [row] = await engine.executeRaw<{ fingerprint: string; completed_keys: any[] }>("SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]);
  const legacy = oldCursorKey(row.completed_keys[0]); expect(row.fingerprint).not.toBe(legacy);
  // Synthetic pre-feature text cursor, with no pending request to rewrite.
  expect(row.completed_keys[0].pending).toBeUndefined();
  await engine.executeRaw("UPDATE op_checkpoints SET fingerprint=$2 WHERE op='managed-sync' AND fingerprint=$1", [row.fingerprint, legacy]);
  writeFileSync(join(f.root, 'photo.png'), png); const head = commit(f.root);
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'first_sync', runId: first.runId, toCommit: f.head });
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'synced', toCommit: head });
  expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [legacy])).toEqual([]);
  expect(await engine.getPage('photo.png', { sourceId: f.id })).toMatchObject({ type: 'image', content_hash: sha256(png) });
});
check('a completed versioned cursor cannot shadow a pending legacy UUID; dual unfinished keys refuse', async engine => {
  const f = await fixture(engine, { 'a.md': 'An initial committed observation.\n' });
  await performManagedSync(engine, f.opts);
  const [completed] = await engine.executeRaw<{ fingerprint: string; completed_keys: any[] }>("SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]);
  writeFileSync(join(f.root, 'b.md'), 'An observation awaiting the original request.\n'); commit(f.root);
  await interruptAfterSyncDiscovery(engine, f.opts);
  const [fresh] = await engine.executeRaw<{ fingerprint: string; completed_keys: any[] }>("SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]);
  const legacy = oldCursorKey(fresh.completed_keys[0]);
  await engine.executeRaw("UPDATE op_checkpoints SET fingerprint=$2 WHERE op='managed-sync' AND fingerprint=$1", [fresh.fingerprint, legacy]);
  const lock = await acquireWorktree((await getWorktreeBinding(engine, f.id))!); expect(lock).not.toBeNull();
  try {
    const pending = await performManagedSync(engine, f.opts), id = pending.managedWrite!.write_request.request_id;
    expect(pending).toMatchObject({ status: 'partial', reason: 'writer_pending' });
    await disposePersistenceConsumer(engine);
    const before = await engine.executeRaw('SELECT request_id,intent FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)", [completed.fingerprint, JSON.stringify(completed.completed_keys)]);
    expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'partial', managedWrite: { write_request: { request_id: id } } });
    await disposePersistenceConsumer(engine);
    const ambiguous = structuredClone(completed.completed_keys); ambiguous[0].done = false;
    await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=$2::text::jsonb WHERE op='managed-sync' AND fingerprint=$1", [completed.fingerprint, JSON.stringify(ambiguous)]);
    await expect(performManagedSync(engine, f.opts)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(await engine.executeRaw('SELECT request_id,intent FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id])).toEqual(before);
    await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=$2::text::jsonb WHERE op='managed-sync' AND fingerprint=$1", [completed.fingerprint, JSON.stringify(completed.completed_keys)]);
    await lock!.release();
    expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'synced', runId: pending.runId });
    expect(await engine.executeRaw('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [id])).toEqual([{ state: 'committed' }]);
    expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'up_to_date' });
  } finally { await lock?.release(); await disposePersistenceConsumer(engine); }
});
check('explicit idle retry upgrades a legacy unknown-consent cursor without rewriting its manifest', async engine => {
  const f = await fixture(engine, { 'a.md': 'Legacy source text.\n' });
  await performManagedSync(engine, f.opts);
  const [previous] = await engine.executeRaw<{ fingerprint: string; completed_keys: any[] }>("SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]);
  writeFileSync(join(f.root, 'a.md'), 'A changed legacy observation.\n'); commit(f.root);
  await interruptAfterSyncDiscovery(engine, f.opts);
  const [row] = await engine.executeRaw<{ fingerprint: string; completed_keys: any[] }>("SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]);
  const value = row.completed_keys[0], legacy = oldCursorKey(value);
  const original = await engine.executeRaw("SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [value.runId]);
  delete value.processingOptions;
  await engine.executeRaw("UPDATE op_checkpoints SET fingerprint=$2,completed_keys=$3::text::jsonb WHERE op='managed-sync' AND fingerprint=$1", [row.fingerprint, legacy, JSON.stringify([value])]);
  await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)", [previous.fingerprint, JSON.stringify(previous.completed_keys)]);
  await expect(performManagedSync(engine, f.opts)).rejects.toMatchObject({ code: 'invalid_params' });
  writeFileSync(join(f.root, 'photo.png'), png); const head = commit(f.root);
  expect(await performManagedSync(engine, { ...f.opts, retryFailed: true })).toMatchObject({ status: 'synced', toCommit: head });
  expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [legacy])).toEqual([]);
  expect(await engine.executeRaw("SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [value.runId])).toEqual(original);
  expect(await engine.getPage('photo.png', { sourceId: f.id })).toMatchObject({ type: 'image' });
  expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1", [legacy])).toEqual([]);
});
check('pinned Git binary reads accept exactly 10 MiB and refuse limit plus one', async engine => {
  const bytes = Buffer.alloc(MAX_SYNC_BYTES, 0xa5), oversized = Buffer.concat([bytes, Buffer.from([0xff])]);
  const f = await fixture(engine, { 'limit.png': bytes, 'overflow.png': oversized });
  const discovery = await discoverManagedSync(engine, f.opts);
  const limit = discovery.entries.find(e => e.path === 'limit.png')!;
  // A later working-tree edit is not the accepted blob.
  writeFileSync(join(f.root, 'limit.png'), oversized);
  expect(readSyncBytes(discovery, limit)).toEqual(bytes);
  expect(() => readSyncBytes(discovery, discovery.entries.find(e => e.path === 'overflow.png')!)).toThrow('bounded import size');
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
  expect(await anchor(engine, f.id)).toBeNull();
});
check('working-tree binary admission retains exact 10 MiB, confinement, regular-file and symlink guards', async engine => {
  const f = await fixture(engine, { 'photo.png': Buffer.from([0, 255, 128]) });
  const discovery = await discoverManagedSync(engine, f.opts), entry = { ...discovery.entries[0], working: true };
  const bytes = Buffer.alloc(MAX_SYNC_BYTES, 0xa5);
  writeFileSync(join(f.root, 'photo.png'), bytes);
  expect(readSyncBytes(discovery, entry)).toEqual(bytes);
  writeFileSync(join(f.root, 'photo.png'), Buffer.concat([bytes, Buffer.from([0xff])]));
  expect(() => readSyncBytes(discovery, entry)).toThrow('bounded import size');
  mkdirSync(join(f.root, 'directory.png'));
  expect(() => readSyncFile(f.root, 'directory.png')).toThrow('regular file');
  symlinkSync('photo.png', join(f.root, 'alias.png'));
  expect(() => readSyncFile(f.root, 'alias.png')).toThrow('symlink');
  symlinkSync('.', join(f.root, 'linked'));
  expect(() => readSyncFile(f.root, 'linked/photo.png')).toThrow('symlink');
  expect(() => readSyncFile(f.root, '../outside.png')).toThrow('escaped');
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
});
check('frozen binary decoding accepts exactly 10 MiB and refuses limit plus one with canonical digest', () => {
  const bytes = Buffer.alloc(MAX_SYNC_BYTES, 0xa5), overflow = Buffer.concat([bytes, Buffer.from([0xff])]);
  const frozen = freezeSyncContent('photo.png', bytes);
  expect(thawSyncContent('photo.png', frozen.content, frozen.contentEncoding, frozen.contentHash)).toEqual(bytes);
  expect(() => freezeSyncContent('photo.png', overflow)).toThrow('bounded import size');
  expect(() => thawSyncContent('photo.png', overflow.toString('base64'), 'base64', sha256(overflow))).toThrow('not canonically encoded');
  expect(() => thawSyncContent('photo.png', frozen.content, 'base64', sha256(overflow))).toThrow('digest');
  expect(() => thawSyncContent('photo.png', frozen.content + '\n', 'base64', frozen.contentHash)).toThrow();
});
check('invalid frozen image admission never reaches importer, provider or canonical apply', async engine => {
  const f = await fixture(engine, { 'photo.png': Buffer.from('---\nslug: photo.png\n---\nSynthetic UTF-8-like image bytes.\n') });
  const lock = await acquireWorktree((await getWorktreeBinding(engine, f.id))!);
  expect(lock).not.toBeNull();
  try {
    await performManagedSync(engine, f.opts); await disposePersistenceConsumer(engine);
    const [row] = await engine.executeRaw<import('../src/core/persistence/model.ts').WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1', [f.id]);
    const overflow = Buffer.alloc(MAX_SYNC_BYTES + 1, 0x61);
    let importerCalls = 0, applyCalls = 0;
    const before = calls;
    const importer = spyOn(imageImport, 'importImageFile').mockImplementation(async () => { importerCalls++; throw new Error('Importer must not run'); });
    try {
      for (const invalid of [
        { binaryContent: overflow.toString('base64'), contentHash: sha256(overflow) },
        { contentEncoding: 'utf8' }, { contentHash: 'wrong' }, { binaryContent: '!!!!' },
        { content: 'Synthetic text-like image payload' },
      ]) {
        await expect((async () => {
          const prepared = await prepareManagedSyncMutation(engine, { ...row, intent: { ...row.intent, ...invalid } }, { engine: engine.kind });
          applyCalls++; await prepared.apply(engine);
        })()).rejects.toBeDefined();
      }
      expect(importerCalls).toBe(0); expect(calls).toBe(before); expect(applyCalls).toBe(0);
      expect(await engine.getPage('photo.png', { sourceId: f.id })).toBeNull();
      expect(await anchor(engine, f.id)).toBeNull();
    } finally { importer.mockRestore(); }
  } finally { await lock?.release(); await disposePersistenceConsumer(engine); }
});

check('source incarnation, topology and current writer authority still fence prepared images', async engine => {
  for (const race of ['topology', 'incarnation', 'authority']) {
    const f = await fixture(engine, { 'photo.png': png });
    provider = async () => {
      if (race === 'topology') await engine.executeRaw('UPDATE persistence_source_bindings SET topology_generation=topology_generation+1 WHERE source_id=$1', [f.id]);
      else if (race === 'incarnation') await engine.executeRaw('UPDATE sources SET incarnation=$2::uuid WHERE id=$1', [f.id, randomUUID()]);
      else await engine.executeRaw("UPDATE persistence_local_writers SET revoked_at=now() WHERE id=(SELECT principal_id::uuid FROM persistence_requests WHERE source_id=$1 LIMIT 1)", [f.id]);
    };
    const outcome = await performManagedSync(engine, { ...f.opts, noEmbed: false });
    expect(['blocked_by_failures', 'partial']).toContain(outcome.status);
    expect(await anchor(engine, f.id)).toBeNull(); expect(await engine.getPage('photo.png', { sourceId: f.id })).toBeNull();
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state='committed'", [f.id])).toEqual([]);
  }
});
