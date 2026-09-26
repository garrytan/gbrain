import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { CRASH_BOUNDARIES, childEnvironment } from '../../scripts/persistence/validate.ts';
import { assertConservation } from '../../scripts/persistence/harness.ts';
import { configDir, type GBrainConfig } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../../src/core/markdown.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { digest, sha256, stableJson } from '../../src/core/persistence/digest.ts';
import { localHostId, readLocalWriter, registerLocalWriter, withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { claimNextWrite, getWriteRequest, receiptFor } from '../../src/core/persistence/journal.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { prepareReconcileMutation } from '../../src/core/persistence/reconcile-prepare.ts';
import { reconcileCanonical } from '../../src/core/persistence/reconcile-merge.ts';
import { runReconcileApply, runReconcilePreview, type ReconcileArtifact } from '../../src/core/persistence/reconcile.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../../src/core/persistence/service.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

export { CRASH_BOUNDARIES };
type Boundary = typeof CRASH_BOUNDARIES[number];
interface CaseOptions { kind: 'pglite' | 'postgres'; boundary: Boundary; enabled: boolean; databaseUrl?: string; }
interface WorkerConfig extends CaseOptions { root: string; dataDir: string; requestId: string; }
interface WorkerEvent { event: string; boundary?: Boundary; request_id?: string; row_id?: string; url?: string; result?: Record<string, unknown>; message?: string; }
interface ReplayFixture {
  params: { source_id: string; slug: string; preview: ReconcileArtifact; request_id: string };
  rowId: string; backupReference: string; backupHash: string; versions: number; binding: unknown; source: unknown;
}
const sourceId = 'reconcile-crash-test';
const slug = 'notes/example';
const emit = (event: WorkerEvent) => process.stdout.write(`${JSON.stringify(event)}\n`);
const hold = () => { setInterval(() => {}, 1000); return new Promise<never>(() => {}); };

function stopSynchronously(event: WorkerEvent): never {
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(1, bytes, offset, bytes.length - offset);
    assert(written > 0);
    offset += written;
  }
  const blocked = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(blocked, 0, 0);
}

function engineConfig(config: WorkerConfig): GBrainConfig {
  return config.kind === 'pglite' ? { engine: 'pglite', database_path: config.dataDir }
    : { engine: 'postgres', database_url: config.databaseUrl };
}

async function openEngine(config: WorkerConfig, initialize: boolean): Promise<BrainEngine> {
  const engine = config.kind === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
  if (config.kind === 'postgres') assertSafeE2eDatabaseUrl(config.databaseUrl!);
  await engine.connect(config.kind === 'pglite' ? { database_path: config.dataDir } : { database_url: config.databaseUrl!, poolSize: 4 });
  if (initialize) await engine.initSchema();
  return engine;
}

async function versionCount(engine: BrainEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM page_versions v
    JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2`, [sourceId, slug]);
  return Number(row.count);
}

async function sourceState(engine: BrainEngine): Promise<unknown> {
  const [row] = await engine.executeRaw('SELECT incarnation,last_commit,last_sync_at,config FROM sources WHERE id=$1', [sourceId]);
  return JSON.parse(stableJson(row));
}

async function crash(config: WorkerConfig): Promise<never> {
  const engine = await openEngine(config, true);
  const root = join(config.root, 'source');
  mkdirSync(join(root, 'notes'), { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await importFromContent(engine, slug, '---\ntype: note\ntitle: Example\ncustom_database: retained\nprofile:\n  role: example-role\n---\nA durable synthetic observation.\n',
    { sourceId, sourcePath: 'notes/example.md', noEmbed: true });
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  assert(snapshot);
  const file = join(root, `${slug}.md`);
  writeFileSync(file, serializePageToMarkdown({ ...snapshot.page,
    frontmatter: { custom_file: 'retained', profile: { location: 'example-place' } } }, snapshot.tags));
  const binding = await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [config.enabled]);
  const registration = await registerLocalWriter(engine, 'cli');
  return withVerifiedLocalRegistration(engine, registration, async () => {
    const { preview } = await runReconcilePreview(engine, { source_id: sourceId, slug });
    assert.equal(preview.status, 'ready');
    assert.deepEqual(preview.result.frontmatter.profile, { location: 'example-place', role: 'example-role' });
    const params = { source_id: sourceId, slug, preview, request_id: config.requestId };
    const holder = await acquireWorktree(binding);
    assert(holder, 'fixture must hold the actual native worktree lock before admission');
    try {
      await assert.rejects(runReconcileApply(engine, params), (error: unknown) => {
        const pending = error as { code?: string; writeRequest?: { request_id: string; state: string } };
        assert.equal(pending.code, 'write_pending');
        assert.equal(pending.writeRequest?.request_id, config.requestId);
        assert(['queued', 'running'].includes(pending.writeRequest!.state));
        return true;
      });
      await disposePersistenceConsumer(engine);
      assert.equal((await engine.readPageSnapshot(slug, { sourceId }))!.revision, snapshot.revision);
      assert.equal(readFileSync(file).toString('base64'), preview.preimages.file_base64);
    } finally { await holder.release(); }
    const row = await getWriteRequest(engine, { kind: 'local_cli', id: registration.id }, config.requestId);
    assert(row);
    assert.equal(row.state, 'queued');
    assert.equal(row.recovery, null);
    const backupReference = String(row.intent!.backup_reference);
    const fixture: ReplayFixture = { params, rowId: row.id, backupReference,
      backupHash: sha256(readFileSync(join(configDir(), 'reconciliation-previews', backupReference))),
      versions: await versionCount(engine), binding, source: await sourceState(engine) };
    writeFileSync(join(config.root, 'replay.json'), stableJson(fixture), { mode: 0o600 });
    const event: WorkerEvent = { event: 'boundary', boundary: config.boundary, row_id: row.id, request_id: config.requestId };
    const stop = async () => { emit(event); await hold(); };
    if (config.boundary === 'admitted') { await stop(); throw new Error('unreachable'); }
    const claimed = await claimNextWrite(engine, localHostId());
    assert.equal(claimed?.id, row.id);
    const prepared = await prepareReconcileMutation(engine, claimed!, engineConfig(config));
    const committed = await publishMutation(engine, claimed!, prepared, localHostId(), {
      boundary: async boundary => { if (boundary === config.boundary) await stop(); },
      stagingFlushed: () => { if (config.boundary === 'staging_flushed') stopSynchronously(event); },
    });
    if (config.boundary === 'after_response') {
      assert.equal(committed.state, 'committed');
      const receipt = await runReconcileApply(engine, params);
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json(receipt) });
      emit({ ...event, event: 'response_ready', url: server.url.toString() });
      await hold();
    }
    throw new Error(`Boundary ${config.boundary} was not reached: ${committed.state}/${committed.error_code}`);
  });
}

async function recover(config: WorkerConfig): Promise<Record<string, unknown>> {
  const engine = await openEngine(config, false);
  try {
    const fixture: ReplayFixture = JSON.parse(readFileSync(join(config.root, 'replay.json'), 'utf8'));
    const { params } = fixture;
    const registration = await readLocalWriter(engine, 'cli');
    return await withVerifiedLocalRegistration(engine, registration, async () => {
      const row = await getWriteRequest(engine, { kind: 'local_cli', id: registration.id }, config.requestId);
      assert(row, 'acknowledged reconciliation request must survive SIGKILL');
      assert.equal(row.id, fixture.rowId);
      assert.equal(row.intent?.kind, 'canonical_reconcile');
      const file = join(config.root, 'source', `${slug}.md`);
      const original = Buffer.from(params.preview.preimages.file_base64, 'base64');
      const reviewed = serializePageToMarkdown({ ...params.preview.preimages.database.page, ...params.preview.result }, params.preview.result.tags);
      const committedBoundary = ['after_commit', 'after_response'].includes(config.boundary);
      const publishedBoundary = committedBoundary || ['after_publication', 'before_commit'].includes(config.boundary);
      assert.equal(readFileSync(file, 'utf8'), publishedBoundary ? reviewed : original.toString('utf8'));
      const initialSnapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
      assert(initialSnapshot);
      assert.equal(row.state, committedBoundary ? 'committed' : config.boundary === 'admitted' ? 'queued' : 'running');
      assert.deepEqual(reconcileCanonical(initialSnapshot.page, initialSnapshot.tags), committedBoundary ? params.preview.result
        : reconcileCanonical(params.preview.preimages.database.page, params.preview.preimages.database.tags));
      if (!committedBoundary) assert.equal(initialSnapshot.revision, params.preview.preimages.database.revision);
      const stage = row.recovery?.staging?.publication;
      if (config.boundary === 'staging_flushed') {
        assert(stage, 'flushed staging path must have a durable recovery record');
        assert.equal(readFileSync(stage.path, 'utf8'), reviewed);
        assert.deepEqual(readFileSync(file), original, 'stagingFlushed must stop synchronously before rename');
      }
      if (config.boundary === 'admitted' || config.boundary === 'after_response') assert.equal(row.recovery, null);
      else assert(row.recovery, 'interrupted publication must retain its recovery record');
      await assertConservation(engine);
      startPersistenceConsumer(engine, engineConfig(config));
      let receipt: Record<string, unknown> | undefined;
      const deadline = Date.now() + 30_000;
      while (!receipt && Date.now() < deadline) {
        try { receipt = await runReconcileApply(engine, params); }
        catch (error) { if ((error as { code?: string }).code !== 'write_pending') throw error; }
      }
      assert(receipt, 'same-ID normal apply must complete after restart');
      assert.equal(receipt.state, 'committed');
      assert.equal(receipt.request_id, config.requestId);
      assert.equal((receipt.persistence as Record<string, unknown>).mode, 'filesystem');
      assert.equal((receipt.persistence as Record<string, unknown>).file_written, true);
      assert.equal((receipt.outcome as Record<string, unknown>).result_digest, params.preview.result_digest);
      assert.equal((receipt.outcome as Record<string, unknown>).backup_reference, fixture.backupReference);
      assert.equal((receipt.outcome as Record<string, unknown>).database_changed, true);
      assert.equal((receipt.outcome as Record<string, unknown>).file_changed, true);
      if (committedBoundary) assert.deepEqual(receipt.write_request, receiptFor(row));
      if (config.boundary === 'after_response') {
        assert.deepEqual(receipt, JSON.parse(readFileSync(join(config.root, 'received.json'), 'utf8')));
      }
      const cleanupDeadline = Date.now() + 5000;
      while (Date.now() < cleanupDeadline) {
        const unresolved = await engine.executeRaw('SELECT 1 FROM persistence_requests WHERE recovery IS NOT NULL');
        if (!unresolved.length) break;
        await Bun.sleep(25);
      }
      await disposePersistenceConsumer(engine);
      const final = (await engine.readPageSnapshot(slug, { sourceId }))!;
      assert.deepEqual(reconcileCanonical(final.page, final.tags), params.preview.result);
      assert.equal(final.revision, receipt.revision);
      assert.notEqual(final.revision, params.preview.preimages.database.revision);
      assert.equal(await versionCount(engine), fixture.versions + 1, 'exactly one canonical version must be committed');
      assert.equal(readFileSync(file, 'utf8'), reviewed);
      const parsed = parseMarkdown(readFileSync(file, 'utf8'), slug);
      assert.deepEqual(reconcileCanonical(parsed, parsed.tags), params.preview.result);
      const fileStat = statSync(file);
      assert.deepEqual(await runReconcileApply(engine, params), receipt, 'same-ID replay must preserve the complete receipt');
      assert.equal((await engine.readPageSnapshot(slug, { sourceId }))!.revision, final.revision);
      assert.equal(await versionCount(engine), fixture.versions + 1);
      assert.equal(statSync(file).mtimeMs, fileStat.mtimeMs, 'replay must not republish the canonical file');
      const requests = await engine.executeRaw<{ id: string; state: string; recovery: unknown; recovery_bytes: string }>('SELECT id,state,recovery,recovery_bytes FROM persistence_requests');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].id, fixture.rowId);
      assert.equal(requests[0].state, 'committed');
      assert.equal(requests[0].recovery, null);
      assert.equal(Number(requests[0].recovery_bytes), 0);
      assert.equal((await engine.executeRaw('SELECT 1 FROM persistence_effects WHERE recovery IS NOT NULL')).length, 0);
      if (stage) assert.equal(existsSync(stage.path), false);
      assert.deepEqual(readdirSync(join(config.root, 'source', 'notes')).sort(), ['example.md']);
      const backups = join(configDir(), 'reconciliation-previews');
      assert.deepEqual(readdirSync(backups).filter(name => name !== '.capacity.lock'), [fixture.backupReference]);
      const backup = join(backups, fixture.backupReference);
      assert.equal(sha256(readFileSync(backup)), fixture.backupHash);
      assert.equal(statSync(backup).mode & 0o777, 0o600);
      assert.equal(statSync(backups).mode & 0o777, 0o700);
      assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')).preview.preimages, params.preview.preimages);
      assert.deepEqual(JSON.parse(stableJson(await getWorktreeBinding(engine, sourceId))), fixture.binding);
      assert.deepEqual(await sourceState(engine), fixture.source);
      assert.equal((await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1'))[0].enabled, config.enabled);
      await assertConservation(engine);
      return { boundary: config.boundary, enabled: config.enabled, initial_state: row.state, request_id: config.requestId,
        row_id: fixture.rowId, terminal_state: 'committed', committed_requests: 1, added_versions: 1,
        result_digest: digest(reconcileCanonical(final.page, final.tags)), originals_retained: true,
        normal_apply_replay: true, receipt_unchanged: true, recovery_cleared: true, staging_cleaned: true,
        topology_unchanged: true, counters_conserved: true,
        ...(config.boundary === 'staging_flushed' ? { flushed_before_rename_verified: true } : {}) };
    });
  } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
}

function spawnWorker(configPath: string, home: string, mode: 'crash' | 'recover') {
  const child = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.path), mode, configPath],
    { cwd: home, env: childEnvironment(home), stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
  const events: WorkerEvent[] = [];
  const waiters = new Set<() => void>();
  let ended = false;
  const reading = (async () => {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try { const event = JSON.parse(line); if (typeof event.event === 'string') events.push(event); } catch {}
        for (const wake of waiters) wake();
      }
    }
    ended = true;
    for (const wake of waiters) wake();
  })();
  return {
    child,
    async event(name: string): Promise<WorkerEvent> {
      const deadline = Date.now() + 90_000;
      for (;;) {
        const found = events.find(event => event.event === name);
        if (found) return found;
        const failure = events.find(event => event.event === 'failure');
        assert(!failure, `${mode}: ${failure?.message}`);
        assert(!ended, `${mode} exited before ${name}`);
        assert(Date.now() < deadline, `${mode} timed out before ${name}`);
        await new Promise<void>(done => {
          const timer = setTimeout(wake, 500);
          function wake() { clearTimeout(timer); waiters.delete(wake); done(); }
          waiters.add(wake);
        });
      }
    },
    async kill() { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; await reading; },
  };
}

export async function runReconcileCrashCase(options: CaseOptions): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-crash-'));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const children: ReturnType<typeof spawnWorker>[] = [];
  let admin: ReturnType<typeof postgres> | undefined;
  let database: string | undefined;
  const manifest: Record<string, unknown> = { engine: options.kind, boundary: options.boundary, enabled: options.enabled,
    runtime: `bun-${Bun.version}`, platform: process.platform, status: 'running' };
  try {
    let databaseUrl: string | undefined;
    if (options.kind === 'postgres') {
      assert(options.databaseUrl, 'Postgres crash coverage requires an explicit test DATABASE_URL');
      assertSafeE2eDatabaseUrl(options.databaseUrl);
      admin = postgres(options.databaseUrl, { max: 1, prepare: false, onnotice() {} });
      const name = `gbrain_test_reconcile_crash_${randomUUID().replaceAll('-', '')}`;
      await admin.unsafe(`CREATE DATABASE ${name}`);
      database = name;
      const url = new URL(options.databaseUrl);
      url.pathname = `/${database}`;
      databaseUrl = url.toString();
    }
    const config: WorkerConfig = { ...options, databaseUrl, root, dataDir: join(root, 'data'), requestId: randomUUID() };
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const killed = spawnWorker(configPath, home, 'crash');
    children.push(killed);
    const reached = await killed.event(options.boundary === 'after_response' ? 'response_ready' : 'boundary');
    assert.equal(reached.boundary, options.boundary);
    assert.equal(reached.request_id, config.requestId);
    if (options.boundary === 'after_response') {
      const response = await fetch(reached.url!, { signal: AbortSignal.timeout(5000) });
      assert(response.ok);
      const receipt = await response.json() as Record<string, unknown>;
      assert.equal(receipt.request_id, config.requestId);
      assert.equal(receipt.state, 'committed');
      assert.equal((receipt.persistence as Record<string, unknown>).mode, 'filesystem');
      assert.equal((receipt.persistence as Record<string, unknown>).file_written, true);
      writeFileSync(join(root, 'received.json'), JSON.stringify(receipt), { mode: 0o600 });
      manifest.response_read_before_kill = true;
    }
    assert.equal(killed.child.exitCode, null, 'boundary must be a live blocked process, not a thrown exception');
    await killed.kill();
    assert.equal(killed.child.signalCode, 'SIGKILL');
    const restarted = spawnWorker(configPath, home, 'recover');
    children.push(restarted);
    const recovered = await restarted.event('done');
    assert.equal(await restarted.child.exited, 0);
    assert.equal(recovered.result?.row_id, reached.row_id);
    Object.assign(manifest, recovered.result, { status: 'passed', killed_signal: killed.child.signalCode });
    return manifest;
  } catch (error) {
    manifest.status = 'failed';
    throw error;
  } finally {
    try { await Promise.all(children.map(child => child.kill())); }
    finally {
      try { if (database && admin) await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`); }
      finally {
        await admin?.end({ timeout: 1 });
        rmSync(root, { recursive: true, force: true });
        const directory = process.env.GBRAIN_TEST_RECONCILE_CRASH_MANIFEST_DIR;
        if (directory) {
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, `${options.kind}-${options.enabled ? 'enabled' : 'claimed'}-${options.boundary}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
        }
      }
    }
  }
}

if (import.meta.main) {
  const [mode, configPath] = process.argv.slice(2);
  const config: WorkerConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  try {
    assert(CRASH_BOUNDARIES.includes(config.boundary));
    assert.equal(process.env.HOME, join(config.root, 'home'));
    assert.equal(process.env.GBRAIN_HOME, process.env.HOME);
    if (mode === 'crash') await crash(config);
    else { assert.equal(mode, 'recover'); emit({ event: 'done', result: await recover(config) }); }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown worker failure';
    emit({ event: 'failure', message: config.databaseUrl ? message.replaceAll(config.databaseUrl, '[test database]') : message });
    process.exit(1);
  }
}
