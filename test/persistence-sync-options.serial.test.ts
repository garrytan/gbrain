import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { performSync } from '../src/commands/sync.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { admitWrite, claimNextWrite, getWriteRequest } from '../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter, revokeLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { prepareManagedSyncMutation, type SyncIntent } from '../src/core/persistence/sync-prepare.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { currentSourceFilesystemSignal, withSourceFilesystemLock } from '../src/core/minions/source-filesystem.ts';
import { managedSyncAuthority, withLegacySyncDelegation } from '../src/core/persistence/sync-authority.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { APPLICATION_AUTHORITY, prepareRemoteAgent, prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests } from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { interruptAfterSyncDiscovery } from './helpers/persistence-sync-interruption.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-options-'));
const stores: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [];
const body = '---\ntitle: Example record\n---\nA synthetic record about durable processing consent.\n';
const options = { noPull: true, noEmbed: true, noExtract: true, noSchemaPack: true };
beforeAll(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  stores.push({ engine, close: () => engine.disconnect() });
  if (process.env.DATABASE_URL) stores.push(await isolatedPersistencePostgres(process.env.DATABASE_URL));
}, 120_000);
afterAll(async () => {
  _resetPackLocatorForTests(); _resetPackCacheForTests();
  for (const store of stores) { await disposePersistenceConsumer(store.engine); await store.close(); }
  rmSync(home, { recursive: true, force: true });
});
const check = (name: string, run: (engine: BrainEngine) => Promise<void>) => test(name, () =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined }, async () => {
    const fetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = Object.assign(async () => { networkCalls++; throw new Error('Provider and connector network calls are forbidden in this fixture'); }, { preconnect: fetch.preconnect });
    try {
      for (const { engine } of stores) await run(engine);
      expect(networkCalls).toBe(0);
    } finally { globalThis.fetch = fetch; }
  }), 120_000);
async function fixture(engine: BrainEngine, count = 1, claim = true, parent = home) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const id = `options-${randomUUID().slice(0, 12)}`, root = join(parent, id); mkdirSync(root);
  const git = await makeGitFixture(root);
  mkdirSync(join(root, 'records'));
  for (let i = 0; i < count; i++) writeFileSync(join(root, `records/example-${i}.md`), body.replace('synthetic record', `synthetic record ${i}`));
  git.commitAll('Add synthetic processing fixture');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
  if (claim) {
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
  return { id, root, git, opts: { ...options, sourceId: id, repoPath: root } };
}
async function cursor(engine: BrainEngine, source: string) {
  const [row] = await engine.executeRaw<{ fingerprint: string; completed_keys: any[] }>(
    "SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [source]);
  return { key: row.fingerprint, value: row.completed_keys[0] };
}
async function assertUntouched(engine: BrainEngine, f: Awaited<ReturnType<typeof fixture>>) {
  expect(await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1', [f.id])).toEqual([]);
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
  expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1', [f.id])).toEqual([]);
  expect(await engine.executeRaw("SELECT op,fingerprint,completed_keys FROM op_checkpoints WHERE op IN ('managed-sync','managed-sync-manifest') AND (completed_keys->0->>'sourceId'=$1 OR fingerprint IN (SELECT completed_keys->0->>'runId' FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1))", [f.id])).toEqual([]);
  expect((await engine.executeRaw('SELECT last_commit,last_sync_at FROM sources WHERE id=$1', [f.id]))[0]).toEqual({ last_commit: null, last_sync_at: null });
  expect(readFileSync(join(f.root, 'records/example-0.md'), 'utf8')).toBe(body.replace('synthetic record', 'synthetic record 0'));
}

check('noEmbed prevents effects, transport calls and vectors while the opt-in control commits all three', async engine => {
  for (const noEmbed of [true, false]) {
    const f = await fixture(engine);
    await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour'");
    await engine.executeRaw("ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT (now()+interval '1 hour')");
    try {
      expect(await performManagedSync(engine, { ...f.opts, noEmbed })).toMatchObject({ status: 'first_sync', added: 1 });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT now()');
    }
    const effects = await engine.executeRaw("SELECT kind,state FROM persistence_effects WHERE source_id=$1 AND kind='embedding'", [f.id]);
    expect(effects).toEqual(noEmbed ? [] : [{ kind: 'embedding', state: 'queued' }]);
    await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE source_id=$1 AND kind='embedding'", [f.id]);
    let calls = 0;
    await runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: false }, {
      hostId: localHostId(), limit: 10,
      embedding: { signature: 'test:model:1536', model: 'test:model', embed: async texts => {
        calls++; return texts.map(() => new Float32Array(1536).fill(0.1));
      } },
    });
    expect(calls).toBe(noEmbed ? 0 : 1);
    const vectors = await engine.executeRaw('SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND c.embedding IS NOT NULL', [f.id]);
    expect(vectors.length).toBe(noEmbed ? 0 : 1);
    expect(await engine.executeRaw("SELECT state FROM persistence_effects WHERE source_id=$1 AND kind='embedding'", [f.id])).toEqual(noEmbed ? [] : [{ state: 'committed' }]);
  }
});

check('noSchemaPack bypasses the configured pack and noExtract queues no optional extraction', async engine => {
  const pack = join(home, 'fixture-pack.yaml');
  writeFileSync(pack, `api_version: gbrain-schema-pack-v1\nname: processing-fixture\nversion: 1.0.0\ndescription: ""\ngbrain_min_version: 0.38.0\nextends: null\nborrow_from: []\npage_types:\n  - name: custom-record\n    primitive: entity\n    path_prefixes: [records/]\n    aliases: []\n    extractable: false\n    expert_routing: false\nlink_types: []\nfrontmatter_links: []\ntakes_kinds: [fact, take, bet, hunch]\nenrichable_types: []\nfiling_rules: []\n`);
  await withEnv({ GBRAIN_SCHEMA_PACK: 'processing-fixture' }, async () => {
    for (const noSchemaPack of [true, false]) {
      _resetPackCacheForTests();
      let loads = 0;
      __setPackLocatorForTests(name => { loads++; return name === 'processing-fixture' ? pack : null; });
      try {
        const f = await fixture(engine);
        const beforeJobs = await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id');
        expect(await performManagedSync(engine, { ...f.opts, noSchemaPack })).toMatchObject({ status: 'first_sync', added: 1 });
        expect(loads > 0).toBe(!noSchemaPack);
        expect((await engine.getPage('records/example-0', { sourceId: f.id }))?.type).toBe(noSchemaPack ? 'concept' : 'custom-record');
        expect(await engine.executeRaw("SELECT kind FROM persistence_effects WHERE source_id=$1 AND kind='facts-backstop'", [f.id])).toEqual([]);
        expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(beforeJobs);
        const [request] = await engine.executeRaw<{ intent: SyncIntent }>("SELECT intent FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'", [f.id]);
        expect(request.intent.processingOptions).toEqual({ noEmbed: true, noSchemaPack, noExtract: true });
      } finally { _resetPackLocatorForTests(); _resetPackCacheForTests(); }
    }
  });
});

check('interrupted options survive resume and changed-option retries cannot rewrite accepted work', async engine => {
  const f = await fixture(engine, 2);
  const first = await performManagedSync(engine, f.opts, { maxPages: 1, maxMs: 1000 });
  expect(first).toMatchObject({ status: 'partial', filesImported: 1 });
  const before = await cursor(engine, f.id);
  const requests = await engine.executeRaw('SELECT id,intent FROM persistence_requests WHERE source_id=$1', [f.id]);
  for (const key of ['noEmbed', 'noSchemaPack', 'noExtract'] as const) {
    await expect(performManagedSync(engine, { ...f.opts, [key]: false })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await cursor(engine, f.id)).toEqual(before);
    expect(await engine.executeRaw('SELECT id,intent FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual(requests);
  }
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'first_sync', runId: first.runId, filesImported: 2 });
  expect((await cursor(engine, f.id)).value.processingOptions).toEqual({ noEmbed: true, noSchemaPack: true, noExtract: true });
  expect(await engine.executeRaw("SELECT kind FROM persistence_effects WHERE source_id=$1 AND kind IN ('embedding','facts-backstop')", [f.id])).toEqual([]);
  const retry = await fixture(engine, 2);
  const interrupted = await performManagedSync(engine, retry.opts, { maxPages: 1, maxMs: 1000 });
  const original = await engine.executeRaw('SELECT id,intent FROM persistence_requests WHERE source_id=$1 ORDER BY id', [retry.id]);
  await expect(performManagedSync(engine, { ...retry.opts, noSchemaPack: false })).rejects.toMatchObject({ code: 'invalid_params' });
  const rediscovered = await performManagedSync(engine, { ...retry.opts, noSchemaPack: false, retryFailed: true });
  expect(rediscovered.status).toBe('first_sync');
  expect(rediscovered.runId).not.toBe(interrupted.runId);
  expect((await cursor(engine, retry.id)).value.processingOptions.noSchemaPack).toBe(false);
  expect(await engine.executeRaw('SELECT id,intent FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY id', [original.map(row => row.id)])).toEqual(original);
});

check('unknown legacy import consent fails under its original request and explicit retry rediscovery is required', async engine => {
  const f = await fixture(engine);
  expect(await interruptAfterSyncDiscovery(engine, f.opts)).toMatchObject({ status: 'partial' });
  const c = await cursor(engine, f.id), requestId = randomUUID();
  const path = 'records/example-0.md', content = readFileSync(join(f.root, path), 'utf8');
  const intent: SyncIntent = { kind: 'managed_sync_import', expected_revision: null, sourcePath: path, path, rawHash: sha256(content), content,
    ownerEpoch: c.value.binding.owner_epoch, syncAuthority: c.value.authority, cursorKey: c.key, runId: c.value.runId,
    index: 0, total: 1, from: c.value.from, target: c.value.target, slugMode: c.value.slugMode };
  const admission = { requestId, operation: 'submit_job', sourceId: f.id, sourceIncarnation: c.value.incarnation,
    slug: 'records/example-0', pageId: null, worktreeId: c.value.binding.worktree_id, topologyGeneration: c.value.binding.topology_generation,
    principal: c.value.authority.writer.principal, authority: c.value.authority.writer, callerIntent: intent, intent };
  const next = { ...c.value, pending: { requestId, slug: admission.slug, pageId: null, intent } };
  delete next.processingOptions;
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=$2::text::jsonb WHERE op='managed-sync' AND fingerprint=$1", [c.key, JSON.stringify([next])]);
  await admitWrite(engine, admission);
  const blocked = await performManagedSync(engine, f.opts);
  expect(blocked).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_error: 'invalid_params', write_request: { request_id: requestId } } });
  const failed = (await getWriteRequest(engine, admission.principal, requestId))!;
  expect(failed.intent).toEqual(intent);
  expect((await admitWrite(engine, admission)).id).toBe(failed.id);
  expect((await performManagedSync(engine, f.opts)).managedWrite?.write_request).toEqual(blocked.managedWrite?.write_request);
  expect(await engine.getPage(admission.slug, { sourceId: f.id })).toBeNull();
  expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1', [f.id])).toEqual([]);
  expect(await performManagedSync(engine, { ...f.opts, retryFailed: true })).toMatchObject({ status: 'first_sync', added: 1 });
  expect((await getWriteRequest(engine, admission.principal, requestId))?.intent).toEqual(intent);
  expect((await cursor(engine, f.id)).value.runId).not.toBe(c.value.runId);
});

check('claimed inactive filesystem and connector calls refuse before fetch or publication without activating', async engine => {
  for (const kind of [null, 'github', 'google']) {
    const f = await fixture(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    if (kind) await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [f.id, JSON.stringify({ kind })]);
    await expect(performSync(engine, f.opts)).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    await expect(performManagedSync(engine, f.opts)).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    expect(await engine.executeRaw('SELECT enabled FROM persistence_brain WHERE singleton=1')).toEqual([{ enabled: false }]);
    await assertUntouched(engine, f);
  }
});

check('inherited cancellation and a released filesystem context never enter the new routing path', async engine => {
  const f = await fixture(engine, 1, false);
  const abort = new AbortController();
  let cancelledResult: Awaited<ReturnType<typeof performSync>> | undefined;
  await expect(withSourceFilesystemLock(engine, f.root, async () => {
    await claimWorktree(engine, f.id, f.root);
    abort.abort();
    cancelledResult = await performSync(engine, f.opts);
    expect(cancelledResult).toMatchObject({ status: 'partial', reason: 'timeout' });
  }, { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelledResult).toMatchObject({ status: 'partial', reason: 'timeout', filesImported: 0 });
  await assertUntouched(engine, f);
  const released = await fixture(engine, 1, false);
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let delayed!: Promise<unknown>;
  await withSourceFilesystemLock(engine, released.root, async () => {
    delayed = gate.then(() => performSync(engine, released.opts));
  });
  resume();
  await expect(delayed).rejects.toMatchObject({ name: 'LockStolenError' });
  await assertUntouched(engine, released);
});

check('old inactive sync intents and managed bypass options remain refused', async engine => {
  const f = await fixture(engine);
  for (const change of [{ noPull: false }, { includeGitignored: true }, { skipFailed: true }]) {
    await expect(performManagedSync(engine, { ...f.opts, ...change })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
  }
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [f.id, home]);
  });
  await expect(performManagedSync(engine, { ...f.opts, repoPath: undefined })).rejects.toMatchObject({ code: 'source_changed' });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await expect(prepareManagedSyncMutation(engine, { intent: { kind: 'managed_sync_import' } } as any, { engine: engine.kind }))
    .rejects.toMatchObject({ code: 'writer_coordinator_required' });
  await assertUntouched(engine, f);
});

check('first and full nested source-root discovery ignore unrelated root files', async engine => {
  const f = await fixture(engine, 1, false);
  writeFileSync(join(f.root, 'README.md'), 'Unrelated root documentation.\n');
  writeFileSync(join(f.root, 'a.md'), 'Unrelated short root filename.\n');
  f.git.commitAll('Add unrelated root documentation');
  const root = join(f.root, 'records');
  await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [f.id, root]);
  await claimWorktree(engine, f.id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect(await performManagedSync(engine, { ...f.opts, repoPath: root })).toMatchObject({ status: 'first_sync', added: 1 });
  expect((await engine.getPage('example-0', { sourceId: f.id }))?.source_path).toBe('example-0.md');
  expect(await engine.getPage('readme', { sourceId: f.id })).toBeNull();
  expect(await performManagedSync(engine, { ...f.opts, repoPath: root, full: true })).toMatchObject({ status: 'synced', deleted: 0 });
  expect(readFileSync(join(f.root, 'README.md'), 'utf8')).toBe('Unrelated root documentation.\n');
  expect(readFileSync(join(f.root, 'a.md'), 'utf8')).toBe('Unrelated short root filename.\n');
});

test('fresh processes resume persisted pending opt-outs under the original request and persist synthetic vectors only for opt-in', () =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const kind of ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])] as const) for (const noEmbed of [true, false]) {
      const databasePath = join(home, `restart-${kind}-${noEmbed}`);
      let engine: BrainEngine, close: () => Promise<void>, database: string;
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
        const [row] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
        const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${row.name}`; database = url.toString();
      } else {
        engine = new PGLiteEngine(); await engine.connect({ database_path: databasePath }); await engine.initSchema();
        close = () => engine.disconnect(); database = databasePath;
      }
      try {
        const f = await fixture(engine);
        await engine.executeRaw("ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT (now()+interval '1 hour')");
        const lock = await acquireWorktree((await getWorktreeBinding(engine, f.id))!);
        expect(lock).not.toBeNull();
        let pending: Awaited<ReturnType<typeof performManagedSync>>;
        let frozen: Array<{ id: string; request_id: string; state: string; intent: SyncIntent }>;
        try {
          pending = await performManagedSync(engine, { ...f.opts, noEmbed });
          expect(pending).toMatchObject({ status: 'partial', reason: 'writer_pending', filesImported: 0 });
          await disposePersistenceConsumer(engine);
          frozen = await engine.executeRaw('SELECT id,request_id,state,intent FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
          expect(frozen).toHaveLength(1);
          expect(frozen[0].state).toBe('queued');
          expect(frozen[0].request_id).toBe(pending.managedWrite!.write_request.request_id);
          expect(frozen[0].intent.processingOptions).toEqual({ noEmbed, noSchemaPack: true, noExtract: true });
          expect(await engine.getPage('records/example-0', { sourceId: f.id })).toBeNull();
          expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1', [f.id])).toEqual([]);
          expect((await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBeNull();
          await engine.disconnect();
        } finally { await lock?.release(); }
        const inputPath = join(home, `restart-${kind}-${noEmbed}.json`);
        writeFileSync(inputPath, JSON.stringify({ kind, database, sourceId: f.id, root: f.root, noEmbed }), { mode: 0o600 });
        const child = async (mode: string) => {
          const process = Bun.spawn([globalThis.process.execPath, '--no-env-file', join(import.meta.dir, 'fixtures/persistence-sync-options-child.ts'), inputPath, mode], {
            cwd: home, env: { ...globalThis.process.env, GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '', GBRAIN_MODEL_DISCOVERY: 'off' },
            stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
          });
          const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
          expect({ code, stderr }).toMatchObject({ code: 0 });
          return JSON.parse(stdout);
        };
        const resumed = await child('resume');
        expect(resumed.pid).not.toBe(process.pid);
        expect(resumed.before).toEqual(frozen!);
        expect(resumed.changedOptions).toEqual({ code: 'invalid_params' });
        expect(resumed.afterChangedOptions).toEqual(frozen!);
        expect(resumed.result).toMatchObject({ status: 'first_sync', runId: pending!.runId, added: 1, filesImported: 1 });
        expect(resumed.after).toHaveLength(2);
        expect(resumed.after[0]).toEqual({ ...frozen![0], state: 'committed' });
        expect(resumed.after[1]).toMatchObject({ state: 'committed', intent: { kind: 'managed_sync_checkpoint', runId: pending!.runId } });
        expect(resumed.beforeDrain).toEqual(noEmbed ? [] : [{ kind: 'embedding', state: 'queued' }]);
        expect(resumed.effects).toEqual(noEmbed ? [] : [{ kind: 'embedding', state: 'committed' }]);
        expect(resumed.networkCalls).toBe(0);
        expect(resumed.transportCalls).toBe(noEmbed ? 0 : 1);
        expect(resumed.chunks).toHaveLength(1);
        expect(resumed.chunks[0].vector).toBe(noEmbed ? null : `[${new Array(1536).fill(0.25).join(',')}]`);
        expect(resumed.pages).toHaveLength(1);
        expect(resumed.pages[0].embedding_signature).toBe(noEmbed ? null : 'test:restart:1536');
        expect(resumed.source[0].last_commit).toBe(frozen![0].intent.target);
        expect(resumed.source[0].last_sync_at).not.toBeNull();
        const replayed = await child('replay');
        expect(replayed.pid).not.toBe(resumed.pid);
        expect(replayed.before).toEqual(resumed.after);
        expect(replayed.result).toMatchObject({ status: 'up_to_date', added: 0 });
        expect(replayed.after).toEqual(resumed.after);
        expect(replayed.pages).toEqual(resumed.pages);
        expect(replayed.chunks).toEqual(resumed.chunks);
        expect(replayed.effects).toEqual(resumed.effects);
        expect(replayed.transportCalls).toBe(0);
        expect(replayed.networkCalls).toBe(0);
        expect(readFileSync(join(f.root, 'records/example-0.md'), 'utf8')).toBe(body.replace('synthetic record', 'synthetic record 0'));
        console.info(`PERSISTED_SYNC_OPTIONS engine=${kind} noEmbed=${noEmbed} resumed_original_request=true processes=2 vectors=${noEmbed ? 0 : 1}`);
      } finally { await disposePersistenceConsumer(engine!); await close!(); }
    }
  }), 240_000);

type BoundaryChange = 'archived' | 'recreated' | 'wrong-owner-epoch' | 'revoked-local' | 'physical-root-replaced';
async function changeBoundary(engine: BrainEngine, f: Awaited<ReturnType<typeof fixture>>, change: BoundaryChange): Promise<() => Promise<void>> {
  if (change === 'revoked-local') {
    const registration = await registerLocalWriter(engine, 'cli');
    expect(await revokeLocalWriter(engine, registration.id)).toBe(true);
    return async () => { await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=NULL WHERE id=$1::uuid', [registration.id]); };
  }
  if (change === 'physical-root-replaced') {
    const original = `${f.root}-original`;
    renameSync(f.root, original); cpSync(original, f.root, { recursive: true });
    return async () => { rmSync(f.root, { recursive: true, force: true }); renameSync(original, f.root); };
  }
  if (change === 'wrong-owner-epoch') {
    const binding = (await getWorktreeBinding(engine, f.id))!;
    await engine.executeRaw('UPDATE persistence_worktrees SET owner_epoch=owner_epoch+1 WHERE id=$1::uuid', [binding.worktree_id]);
    return async () => { await engine.executeRaw('UPDATE persistence_worktrees SET owner_epoch=$2 WHERE id=$1::uuid', [binding.worktree_id, binding.owner_epoch]); };
  }
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [f.id]);
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    if (change === 'archived') await tx.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [f.id]);
    else {
      await tx.executeRaw('DELETE FROM page_write_guards WHERE source_incarnation=$1::uuid', [source.incarnation]);
      await tx.executeRaw('UPDATE sources SET incarnation=$2::uuid WHERE id=$1', [f.id, randomUUID()]);
    }
  });
  return async () => {
    await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
      await tx.executeRaw('UPDATE sources SET incarnation=$2::uuid,archived=$3 WHERE id=$1', [f.id, source.incarnation, source.archived]);
    });
  };
}

for (const change of ['archived', 'recreated', 'wrong-owner-epoch', 'revoked-local', 'physical-root-replaced', 'remote-agent', 'shared-secret'] as const) {
  check(`dispatch fences ${change} in active and claimed-inactive brains`, async engine => {
    for (const enabled of [true, false]) {
      const f = await fixture(engine);
      const registration = await registerLocalWriter(engine, 'cli');
      if (change === 'wrong-owner-epoch') expect(await interruptAfterSyncDiscovery(engine, f.opts)).toMatchObject({ status: 'partial' });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [enabled]);
      let restore = async () => {}, run = () => performSync(engine, f.opts);
      if (change === 'shared-secret') run = () => withLegacySyncDelegation(() => performSync(engine, f.opts));
      else if (change === 'remote-agent') {
        const clientId = `fixture-agent-${randomUUID()}`;
        await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,bound_source_id,federated_read,bound_tools,delegated_slug_prefixes,delegated_namespace)
          VALUES($1,'Fixture agent','test-only','agent',$2,$2,ARRAY[$2]::text[],ARRAY['get_page','put_page'],ARRAY['records/'],'prefixes')`, [clientId, f.id]);
        const authority = await prepareRemoteAgent({ engine, remote: true, auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['agent'], sourceId: f.id } } as OperationContext,
          { source_id: f.id, allowed_tools: ['get_page', 'put_page'], allowed_slug_prefixes: ['records/'] });
        run = () => withSubmissionAuthority(authority, () => performSync(engine, f.opts));
      } else if (change !== 'revoked-local') restore = await changeBoundary(engine, f, change);
      try {
        const invoke = async () => {
          if (change === 'revoked-local') restore = await changeBoundary(engine, f, change);
          if (enabled && change === 'physical-root-replaced') {
            expect(await run()).toMatchObject({ status: 'blocked_by_failures', managedWrite: { write_error: 'recovery_required' } });
          } else {
            const code = !enabled ? 'writer_coordinator_required' : change === 'archived' || change === 'recreated' ? 'owner_unavailable'
              : change === 'wrong-owner-epoch' ? 'source_changed' : 'permission_denied';
            await expect(run()).rejects.toMatchObject({ code });
          }
        };
        if (change === 'revoked-local') await withVerifiedLocalRegistration(engine, registration, invoke);
        else await invoke();
        expect(await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1', [f.id])).toEqual([]);
        expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1', [f.id])).toEqual([]);
        expect((await engine.executeRaw('SELECT last_commit,last_sync_at FROM sources WHERE id=$1', [f.id]))[0]).toEqual({ last_commit: null, last_sync_at: null });
        const requests = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE source_id=$1', [f.id]);
        if (enabled && change === 'physical-root-replaced') {
          expect(requests).toHaveLength(1); expect(requests[0].state).toBe('failed');
        } else expect(requests).toEqual([]);
        expect(await engine.executeRaw('SELECT enabled FROM persistence_brain WHERE singleton=1')).toEqual([{ enabled }]);
        expect(readFileSync(join(f.root, 'records/example-0.md'), 'utf8')).toBe(body.replace('synthetic record', 'synthetic record 0'));
        console.info(`SYNC_DISPATCH_FENCE engine=${engine.kind} enabled=${enabled} case=${change} published=0`);
      } finally { await disposePersistenceConsumer(engine); await restore(); }
    }
  });
}

for (const change of ['unchanged', 'archived', 'recreated', 'wrong-owner-epoch', 'revoked-local', 'physical-root-replaced', 'remote-job-revoked'] as const) {
  check(`publication revalidates ${change} after successful preparation without changing the original request`, async engine => {
    const f = await fixture(engine, 1, false);
    const path = 'records/example-0.md', content = readFileSync(join(f.root, path), 'utf8');
    const previous = content.replace('durable processing consent', 'previously accepted content');
    writeFileSync(join(f.root, path), previous);
    f.git.commitAll('Record synthetic prior content');
    const from = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await importFromContent(engine, 'records/example-0', previous, { sourceId: f.id, sourcePath: path, noEmbed: true });
    await engine.createVersion('records/example-0', { sourceId: f.id });
    await engine.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [f.id, from]);
    writeFileSync(join(f.root, path), content);
    f.git.commitAll('Change synthetic publication content');
    const before = (await engine.readPageSnapshot('records/example-0', { sourceId: f.id }))!;
    const history = await engine.getVersions('records/example-0', { sourceId: f.id });
    expect(before).not.toBeNull();
    expect(history.length).toBeGreaterThan(0);
    await claimWorktree(engine, f.id, f.root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const binding = (await getWorktreeBinding(engine, f.id))!;
    let authority = await managedSyncAuthority(engine, f.id, binding.source_incarnation, f.root);
    let clientId: string | undefined;
    if (change === 'remote-job-revoked') {
      clientId = `fixture-admin-${randomUUID()}`;
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
        VALUES($1,'Fixture admin','test-only','admin',$2,ARRAY['submit_job'])`, [clientId, f.id]);
      const ctx = { engine, remote: true, sourceId: f.id, auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: f.id, allowedOperations: ['submit_job'] } } as OperationContext;
      const remote = await prepareRemoteJob(ctx, 'sync', { noPull: true });
      authority = await withSubmissionAuthority(remote.authority, () => managedSyncAuthority(engine, f.id, binding.source_incarnation, f.root));
    }
    const intent: SyncIntent = { kind: 'managed_sync_import', processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: change !== 'remote-job-revoked' },
      expected_revision: before.revision, path, sourcePath: path, content, rawHash: sha256(content), ownerEpoch: String(binding.owner_epoch), syncAuthority: authority,
      cursorKey: randomUUID(), runId: randomUUID(), index: 0, total: 1, from,
      target: execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), slugMode: 'git-root', working: false };
    const admission = { requestId: randomUUID(), operation: 'submit_job', sourceId: f.id, sourceIncarnation: binding.source_incarnation,
      slug: 'records/example-0', pageId: before.page.id, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation,
      principal: authority.writer.principal, authority: authority.writer, callerIntent: intent, intent };
    const checkpoint = [{ sourceId: f.id, runId: intent.runId, index: 0, total: 1, from, target: intent.target, pending: { requestId: admission.requestId } }];
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)", [intent.cursorKey, JSON.stringify(checkpoint)]);
    const accepted = await admitWrite(engine, admission), row = (await claimNextWrite(engine, localHostId()))!;
    expect(row.id).toBe(accepted.id);
    const prepared = await prepareManagedSyncMutation(engine, row, { engine: engine.kind });
    expect(prepared.noop).not.toBe(true);
    let restore = async () => {};
    if (change === 'remote-job-revoked') await engine.executeRaw("UPDATE oauth_clients SET scope='read' WHERE client_id=$1", [clientId!]);
    else if (change !== 'unchanged') restore = await changeBoundary(engine, f, change);
    const fenced = (await engine.readPageSnapshot(admission.slug, { sourceId: f.id }))!;
    expect(fenced.page).toEqual(before.page);
    expect(fenced.revision).toBe(before.revision);
    if (change === 'recreated') expect(fenced.sourceIncarnation).not.toBe(before.sourceIncarnation);
    else expect(fenced.sourceIncarnation).toBe(before.sourceIncarnation);
    try {
      const result = await publishMutation(engine, row, prepared);
      if (change === 'unchanged') {
        expect(result.state).toBe('committed');
        expect(await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1', [f.id])).toHaveLength(1);
        expect((await engine.readPageSnapshot(admission.slug, { sourceId: f.id }))!.revision).not.toBe(before.revision);
      } else {
        expect(['failed', 'conflict']).toContain(result.state);
        expect(result.error_code).toBe(change === 'archived' || change === 'recreated' ? 'source_changed' : change === 'wrong-owner-epoch' ? 'owner_unavailable'
          : change === 'physical-root-replaced' ? 'recovery_required' : 'permission_denied');
        expect(await engine.readPageSnapshot(admission.slug, { sourceId: f.id })).toEqual(fenced);
        expect(await engine.getVersions(admission.slug, { sourceId: f.id })).toEqual(history);
      }
      expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1', [f.id])).toEqual([]);
      expect((await engine.executeRaw('SELECT last_commit,last_sync_at FROM sources WHERE id=$1', [f.id]))[0]).toEqual({ last_commit: from, last_sync_at: null });
      expect((await engine.executeRaw<{ completed_keys: unknown }>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [intent.cursorKey]))[0].completed_keys).toEqual(checkpoint);
      const receipt = (await getWriteRequest(engine, admission.principal, admission.requestId))!;
      expect(receipt.id).toBe(accepted.id);
      expect(receipt.request_id).toBe(admission.requestId);
      expect(receipt.digest).toBe(accepted.digest);
      expect(receipt.intent).toEqual(intent);
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(1);
      expect(readFileSync(join(f.root, path), 'utf8')).toBe(content);
      console.info(`SYNC_PUBLICATION_FENCE engine=${engine.kind} case=${change} state=${result.state} frozen_intent_unchanged=true`);
    } finally { await restore(); }
  });
}

for (const boundary of ['mode', 'company-profile'] as const) for (const interrupted of ['caller-abort', 'explicit-abort', 'job-abort', 'lease-loss', 'released-context'] as const) check(`active dispatch rechecks ${interrupted} after an observed ${boundary} await`, async engine => {
  const parent = mkdtempSync(join(tmpdir(), 'gbrain-sync-barrier-'));
  const f = await fixture(engine, 1, false, parent), abort = new AbortController();
  const checkpoints = await engine.executeRaw('SELECT op,fingerprint,completed_keys FROM op_checkpoints ORDER BY op,fingerprint');
  let entered!: () => void, resume!: () => void;
  const atRead = new Promise<void>(resolve => { entered = resolve; }), releaseRead = new Promise<void>(resolve => { resume = resolve; });
  const execute = engine.executeRaw, interval = globalThis.setInterval;
  const timer = interrupted === 'lease-loss' ? spyOn(globalThis, 'setInterval').mockImplementation(((fn: (...args: any[]) => void, milliseconds?: number, ...args: any[]) =>
    interval(fn, milliseconds === 300_000 ? 10 : milliseconds, ...args)) as unknown as typeof interval) : undefined;
  let pending!: Promise<Awaited<ReturnType<typeof performSync>>>, observed: Awaited<ReturnType<typeof performSync>> | undefined;
  let readObserved = false, callbackReached = false, leasedKey: string | undefined;
  const outer = withSourceFilesystemLock(engine, f.root, async () => {
    timer?.mockRestore();
    await claimWorktree(engine, f.id, f.root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const signal = currentSourceFilesystemSignal()!;
    const lost = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
      const result = await execute.call(this, sql, params);
      if (!readObserved && sql === (boundary === 'mode' ? 'SELECT enabled FROM persistence_brain WHERE singleton=1' : 'SELECT config,incarnation FROM sources WHERE id=$1')) {
        readObserved = true; entered(); await releaseRead;
      }
      return result;
    } as BrainEngine['executeRaw'];
    pending = interrupted === 'job-abort'
      ? withSubmissionAuthority(APPLICATION_AUTHORITY, () => performSync(engine, f.opts), abort.signal)
      : performSync(engine, { ...f.opts, ...(interrupted === 'explicit-abort' ? { signal: abort.signal } : {}) });
    void pending.catch(() => {});
    await atRead;
    if (interrupted === 'released-context') { callbackReached = true; return; }
    if (interrupted === 'caller-abort' || interrupted === 'explicit-abort' || interrupted === 'job-abort') abort.abort();
    else {
      const [lease] = await execute.call(engine, "SELECT id,acquisition_token FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-fs:%'") as Array<{ id: string; acquisition_token: string }>;
      expect(lease).toBeDefined(); leasedKey = String(lease.id);
      await execute.call(engine, 'UPDATE gbrain_cycle_locks SET acquisition_token=$2::uuid WHERE id=$1', [leasedKey, randomUUID()]);
      await lost;
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toMatchObject({ name: 'LockStolenError', lockId: leasedKey });
    }
    resume();
    if (interrupted === 'caller-abort' || interrupted === 'explicit-abort') observed = await pending;
    else if (interrupted === 'job-abort') await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    else await expect(pending).rejects.toMatchObject({ name: 'LockStolenError', lockId: leasedKey });
    callbackReached = true;
  }, { signal: interrupted === 'caller-abort' ? abort.signal : undefined });
  try {
    if (interrupted === 'released-context') {
      await outer; resume();
      await expect(pending).rejects.toMatchObject({ name: 'LockStolenError', lockId: 'released-worktree-context' });
    } else if (interrupted === 'explicit-abort' || interrupted === 'job-abort') await outer;
    else await expect(outer).rejects.toMatchObject({ name: interrupted === 'caller-abort' ? 'AbortError' : 'LockStolenError' });
    expect(readObserved).toBe(true);
    expect(callbackReached).toBe(true);
    if (interrupted === 'caller-abort' || interrupted === 'explicit-abort') expect(observed).toMatchObject({ status: 'partial', reason: 'timeout', filesImported: 0 });
    await assertUntouched(engine, f);
    expect(await engine.executeRaw('SELECT op,fingerprint,completed_keys FROM op_checkpoints ORDER BY op,fingerprint')).toEqual(checkpoints);
    expect(await engine.executeRaw('SELECT enabled FROM persistence_brain WHERE singleton=1')).toEqual([{ enabled: true }]);
    console.info(`SYNC_AFTER_AWAIT engine=${engine.kind} boundary=${boundary} case=${interrupted} barrier_observed=true checkpoints=0 published=0`);
  } finally {
    resume(); timer?.mockRestore(); engine.executeRaw = execute;
    if (leasedKey) await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [leasedKey]);
    await outer.catch(() => {}); await pending?.catch(() => {});
    rmSync(parent, { recursive: true, force: true });
  }
});

check('active pre-entry cancellation returns the caller partial result or rejects the job without creating checkpoints', async engine => {
  for (const caller of ['explicit', 'job']) {
    const f = await fixture(engine), abort = new AbortController();
    const checkpoints = await engine.executeRaw('SELECT op,fingerprint,completed_keys FROM op_checkpoints ORDER BY op,fingerprint');
    abort.abort();
    if (caller === 'explicit') {
      const result = await performSync(engine, { ...f.opts, signal: abort.signal });
      expect(result).toMatchObject({ status: 'partial', reason: 'timeout', filesImported: 0 });
    } else {
      await expect(withSubmissionAuthority(APPLICATION_AUTHORITY, () => performSync(engine, f.opts), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    }
    await assertUntouched(engine, f);
    expect(await engine.executeRaw('SELECT op,fingerprint,completed_keys FROM op_checkpoints ORDER BY op,fingerprint')).toEqual(checkpoints);
    console.info(`SYNC_PRE_ENTRY engine=${engine.kind} caller=${caller} checkpoints=0 published=0`);
  }
});

async function syncState(engine: BrainEngine, sourceId: string) {
  return {
    pages: await engine.executeRaw('SELECT * FROM pages WHERE source_id=$1 ORDER BY id', [sourceId]),
    requests: await engine.executeRaw('SELECT * FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]),
    effects: await engine.executeRaw('SELECT * FROM persistence_effects WHERE source_id=$1 ORDER BY id', [sourceId]),
    source: await engine.executeRaw('SELECT last_commit,last_sync_at FROM sources WHERE id=$1', [sourceId]),
    checkpoints: await engine.executeRaw('SELECT op,fingerprint,completed_keys,updated_at FROM op_checkpoints ORDER BY op,fingerprint'),
    counters: await engine.executeRaw('SELECT * FROM persistence_counters ORDER BY key'),
  };
}

type SyncBarrier = 'discovery' | 'discovery-commit' | 'foreground' | 'freeze' | 'freeze-commit' | 'request-lookup' | 'admission-commit';
function matchesSyncBarrier(boundary: SyncBarrier, sql: string, params: unknown[] | undefined, transactional: boolean): boolean {
  if (boundary === 'discovery') return sql.startsWith('SELECT source_path FROM pages WHERE source_id=');
  if (boundary === 'foreground') return sql.includes("NOT(COALESCE(intent->>'kind','') LIKE 'managed_sync_%') LIMIT 1");
  if (boundary === 'freeze') return sql.startsWith('SELECT id,source_path FROM pages WHERE source_id=') && !transactional;
  if (boundary === 'request-lookup') return sql.startsWith('SELECT') && sql.includes('FROM persistence_requests') && sql.includes('request_id=') && !transactional;
  if (boundary === 'admission-commit') return sql.includes('UPDATE persistence_counters SET outstanding_count=outstanding_count+1');
  return transactional && sql === 'SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2' && params?.[0] === 'managed-sync';
}

for (const boundary of ['discovery', 'discovery-commit', 'foreground', 'freeze', 'freeze-commit', 'request-lookup', 'admission-commit'] as const) {
  for (const interrupted of ['explicit-abort', 'caller-abort', 'job-abort', 'lease-loss', 'released-context'] as const) {
    if (interrupted === 'lease-loss' && boundary.endsWith('-commit')) continue;
    for (const kind of ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])]) check(`managed cancellation fences ${interrupted} at ${boundary} (${kind})`, async engine => {
      if (engine.kind !== kind) return;
      const parent = mkdtempSync(join(tmpdir(), 'gbrain-sync-admission-'));
      const f = await fixture(engine, 1, false, parent), abort = new AbortController();
      let entered!: () => void, resume!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { resume = resolve; });
      let exited!: () => void;
      const contextExited = new Promise<void>(resolve => { exited = resolve; });
      const execute = engine.executeRaw, transaction = engine.transaction, interval = globalThis.setInterval;
      const timer = interrupted === 'lease-loss' ? spyOn(globalThis, 'setInterval').mockImplementation(((fn: (...args: any[]) => void, ms?: number, ...args: any[]) =>
        interval(fn, ms === 300_000 ? 10 : ms, ...args)) as unknown as typeof interval) : undefined;
      let pending!: Promise<Awaited<ReturnType<typeof performSync>>>;
      let before: Awaited<ReturnType<typeof syncState>> | undefined, transactionBefore: typeof before;
      let observed = false, frozen = false, leasedKey: string | undefined;
      const outer = withSourceFilesystemLock(engine, f.root, async () => {
        timer?.mockRestore();
        await claimWorktree(engine, f.id, f.root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const signal = currentSourceFilesystemSignal()!;
        const lost = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        engine.transaction = async function (this: BrainEngine, fn: (tx: BrainEngine) => Promise<unknown>) {
          if (!observed) transactionBefore = await syncState(this, f.id);
          return transaction.call(this, fn);
        } as BrainEngine['transaction'];
        engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
          const rows = await execute.call(this, sql, params);
          if (sql.startsWith('UPDATE op_checkpoints SET completed_keys=') && params?.[0] === 'managed-sync') frozen = true;
          if (!observed && matchesSyncBarrier(boundary, sql, params, this !== engine) && (boundary !== 'freeze-commit' || frozen)) {
            observed = true;
            before = this === engine ? await syncState(engine, f.id) : transactionBefore;
            expect(before).toBeDefined();
            expect(before!.requests).toEqual([]);
            entered(); await gate;
          }
          return rows;
        } as BrainEngine['executeRaw'];
        pending = interrupted === 'job-abort'
          ? withSubmissionAuthority(APPLICATION_AUTHORITY, () => performSync(engine, f.opts), abort.signal)
          : performSync(engine, { ...f.opts, ...(interrupted === 'caller-abort' ? {} : { signal: abort.signal }) });
        void pending.catch(() => {});
        await Promise.race([reached, pending.then(() => { throw new Error(`Missing ${boundary} barrier`); })]);
        if (interrupted === 'released-context') { setImmediate(exited); return; }
        if (interrupted === 'lease-loss') {
          const [lease] = await execute.call(engine, "SELECT id FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-fs:%'") as Array<{ id: string }>;
          leasedKey = lease.id;
          await execute.call(engine, 'UPDATE gbrain_cycle_locks SET acquisition_token=$2::uuid WHERE id=$1', [leasedKey, randomUUID()]);
          await lost;
          abort.abort();
          expect(signal.reason).toMatchObject({ name: 'LockStolenError', lockId: leasedKey });
        } else abort.abort(interrupted === 'job-abort' ? new Error('Synthetic worker timeout') : undefined);
        resume();
        if (interrupted === 'explicit-abort' || interrupted === 'caller-abort') expect(await pending).toMatchObject({ status: 'partial', reason: 'timeout', filesImported: 0, added: 0 });
        else await expect(pending).rejects.toMatchObject(interrupted === 'job-abort' ? { name: 'AbortError', message: 'Synthetic worker timeout' } : { name: 'LockStolenError', lockId: leasedKey });
      }, { signal: interrupted === 'caller-abort' ? abort.signal : undefined });
      try {
        if (interrupted === 'released-context') {
          await Promise.race([contextExited, outer]); abort.abort(); resume();
          await expect(pending).rejects.toMatchObject({ name: 'LockStolenError', lockId: 'released-worktree-context' });
          await outer;
        } else if (interrupted === 'lease-loss') await expect(outer).rejects.toMatchObject({ name: 'LockStolenError', lockId: expect.any(String) });
        else if (interrupted === 'caller-abort') await expect(outer).rejects.toMatchObject({ name: 'AbortError' });
        else await outer;
        expect(observed).toBe(true);
        await disposePersistenceConsumer(engine);
        expect(await syncState(engine, f.id)).toEqual(before!);
        expect(readFileSync(join(f.root, 'records/example-0.md'), 'utf8')).toBe(body.replace('synthetic record', 'synthetic record 0'));
        console.info(`SYNC_ADMISSION_ABORT engine=${engine.kind} boundary=${boundary} case=${interrupted} requests_at_interrupt=0 state_unchanged=true`);
      } finally {
        resume(); timer?.mockRestore();
        await outer.catch(() => {}); await pending?.catch(() => {});
        await disposePersistenceConsumer(engine);
        engine.executeRaw = execute; engine.transaction = transaction;
        if (leasedKey) await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [leasedKey]);
        rmSync(parent, { recursive: true, force: true });
      }
    });
  }
}

for (const boundary of ['retry-discovery', 'retry-commit', 'missing-manifest', 'completed-cleanup'] as const) check(`cancelled ${boundary} preserves durable cursor and receipt identities`, async engine => {
  const f = await fixture(engine);
  if (boundary !== 'completed-cleanup') {
    writeFileSync(join(f.root, 'records/example-0.md'), '---\ntitle: [broken\n---\nSynthetic invalid document.\n');
    f.git.commitAll('Add synthetic failed import');
    expect(await performSync(engine, f.opts)).toMatchObject({ status: 'blocked_by_failures' });
    writeFileSync(join(f.root, 'records/example-0.md'), body);
    f.git.commitAll('Repair synthetic failed import');
  } else expect(await performSync(engine, f.opts)).toMatchObject({ status: 'first_sync', added: 1 });
  await disposePersistenceConsumer(engine);
  const original = await cursor(engine, f.id);
  if (boundary === 'missing-manifest') await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [original.value.runId]);
  const before = await syncState(engine, f.id), abort = new AbortController(), execute = engine.executeRaw;
  expect(before.requests).toHaveLength(boundary === 'completed-cleanup' ? 2 : 1);
  let observed = false;
  engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
    const rows = await execute.call(this, sql, params);
    if (!observed && (boundary === 'retry-discovery' ? sql.startsWith('SELECT source_path FROM pages WHERE source_id=')
      : boundary === 'completed-cleanup' ? sql.startsWith('DELETE FROM op_checkpoints WHERE op=$1')
      : this !== engine && sql === 'SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2' && params?.[0] === 'managed-sync')) {
      observed = true; abort.abort();
    }
    return rows;
  } as BrainEngine['executeRaw'];
  try {
    expect(await performSync(engine, { ...f.opts, retryFailed: true, signal: abort.signal })).toMatchObject({ status: 'partial', reason: 'timeout', runId: original.value.runId });
    expect(observed).toBe(true);
    expect(await syncState(engine, f.id)).toEqual(before);
    console.info(`SYNC_RETRY_ABORT engine=${engine.kind} boundary=${boundary} original_run=${original.value.runId} state_unchanged=true`);
  } finally { engine.executeRaw = execute; }
});

check('cancellation during accepted-request lookup leaves its frozen identity for resume', async engine => {
  const f = await fixture(engine), execute = engine.executeRaw, freeze = new AbortController();
  engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
    const rows = await execute.call(this, sql, params);
    if (matchesSyncBarrier('request-lookup', sql, params, this !== engine)) freeze.abort();
    return rows;
  } as BrainEngine['executeRaw'];
  try {
    expect(await performSync(engine, { ...f.opts, signal: freeze.signal })).toMatchObject({ status: 'partial', reason: 'timeout', filesImported: 0 });
  } finally { engine.executeRaw = execute; }
  const frozen = await cursor(engine, f.id), pending = frozen.value.pending;
  expect(pending).toBeDefined();
  expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([]);
  const accepted = await admitWrite(engine, { requestId: pending.requestId, operation: 'submit_job', sourceId: f.id,
    sourceIncarnation: frozen.value.incarnation, slug: pending.slug, pageId: pending.pageId,
    worktreeId: frozen.value.binding.worktree_id, topologyGeneration: frozen.value.binding.topology_generation,
    principal: frozen.value.authority.writer.principal, authority: frozen.value.authority.writer, callerIntent: pending.intent, intent: pending.intent });
  const before = await syncState(engine, f.id), abort = new AbortController();
  let observed = false;
  engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
    const rows = await execute.call(this, sql, params);
    if (!observed && matchesSyncBarrier('request-lookup', sql, params, this !== engine)) {
      expect(rows).toHaveLength(1); observed = true; abort.abort();
    }
    return rows;
  } as BrainEngine['executeRaw'];
  try {
    expect(await performSync(engine, { ...f.opts, signal: abort.signal })).toMatchObject({ status: 'partial', reason: 'timeout', runId: frozen.value.runId, filesImported: 0 });
    expect(observed).toBe(true);
    expect(await syncState(engine, f.id)).toEqual(before);
  } finally { engine.executeRaw = execute; }
  expect(await performSync(engine, f.opts)).toMatchObject({ status: 'first_sync', runId: frozen.value.runId, added: 1 });
  const resumed = (await getWriteRequest(engine, accepted.authority.principal, accepted.request_id))!;
  expect(resumed).toMatchObject({ id: accepted.id, request_id: accepted.request_id, intent: accepted.intent, digest: accepted.digest, state: 'committed' });
  expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'", [f.id])).toEqual([{ id: accepted.id }]);
});

for (const boundary of ['accepted-commit', 'receipt-banking'] as const) check(`cancellation at ${boundary} still banks accepted work without admitting the next page`, async engine => {
  const f = await fixture(engine, 2), execute = engine.executeRaw, transaction = engine.transaction, abort = new AbortController();
  let accepted = false, observed = false;
  engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
    const rows = await execute.call(this, sql, params);
    if (sql.includes('INSERT INTO persistence_requests')) accepted = true;
    if (boundary === 'receipt-banking' && accepted && sql.startsWith('UPDATE op_checkpoints SET completed_keys=') &&
        params?.[0] === 'managed-sync' && JSON.parse(String(params[3]))[0].index === 1) { observed = true; abort.abort(); }
    return rows;
  } as BrainEngine['executeRaw'];
  engine.transaction = async function (this: BrainEngine, run: (tx: BrainEngine) => Promise<unknown>) {
    const result = await transaction.call(this, run);
    if (boundary === 'accepted-commit' && accepted && !observed) { observed = true; abort.abort(); }
    return result;
  } as BrainEngine['transaction'];
  try {
    const first = await performSync(engine, { ...f.opts, signal: abort.signal });
    expect(first).toMatchObject({ status: 'partial', reason: 'timeout', added: 1, filesImported: 1, bankedFiles: 1 });
    expect(observed).toBe(true);
    await disposePersistenceConsumer(engine);
    const banked = await cursor(engine, f.id), before = await syncState(engine, f.id);
    expect(banked.value).toMatchObject({ index: 1, counts: { added: 1 } });
    expect(banked.value.pending).toBeUndefined();
    expect(before.requests).toHaveLength(1);
    expect(before.requests[0]).toMatchObject({ state: 'committed' });
    expect(before.pages).toHaveLength(1);
    expect(before.effects).toEqual([]);
    expect(before.source).toEqual([{ last_commit: null, last_sync_at: null }]);
    engine.executeRaw = execute; engine.transaction = transaction;
    expect(await performSync(engine, f.opts)).toMatchObject({ status: 'first_sync', runId: first.runId, added: 2, filesImported: 2 });
    expect(await engine.executeRaw('SELECT * FROM persistence_requests WHERE id=$1', [before.requests[0].id])).toEqual(before.requests);
  } finally { engine.executeRaw = execute; engine.transaction = transaction; }
});

check('cancelled waits retain the accepted pending receipt and resume it after owner lock release', async engine => {
  const f = await fixture(engine), abort = new AbortController(), transaction = engine.transaction;
  const lock = await acquireWorktree((await getWorktreeBinding(engine, f.id))!);
  expect(lock).not.toBeNull();
  engine.transaction = async function (this: BrainEngine, run: (tx: BrainEngine) => Promise<unknown>) {
    const value = await transaction.call(this, run);
    if (value && typeof value === 'object' && 'request_id' in value && 'source_id' in value && value.source_id === f.id) abort.abort();
    return value;
  } as BrainEngine['transaction'];
  let requestId: string, runId: string;
  try {
    const pending = await performSync(engine, { ...f.opts, signal: abort.signal });
    expect(abort.signal.aborted).toBe(true);
    expect(pending).toMatchObject({ status: 'partial', reason: 'timeout', filesImported: 0,
      managedWrite: { write_error: 'write_pending' } });
    expect(['queued', 'running', 'recovering']).toContain(pending.managedWrite!.write_request.state);
    requestId = pending.managedWrite!.write_request.request_id; runId = pending.runId!;
    await disposePersistenceConsumer(engine);
    const frozen = await cursor(engine, f.id), state = await syncState(engine, f.id);
    expect(frozen.value.pending.requestId).toBe(requestId);
    expect(state.requests).toHaveLength(1);
    expect(state.pages).toEqual([]); expect(state.effects).toEqual([]);
    expect(state.source).toEqual([{ last_commit: null, last_sync_at: null }]);
  } finally { engine.transaction = transaction; await disposePersistenceConsumer(engine); await lock?.release(); }
  expect(await performSync(engine, f.opts)).toMatchObject({ status: 'first_sync', runId: runId!, added: 1 });
  expect(await engine.executeRaw("SELECT request_id,state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'", [f.id]))
    .toEqual([{ request_id: requestId!, state: 'committed' }]);
});
