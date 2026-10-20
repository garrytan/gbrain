/**
 * #6696 C1: delegated managed sync keeps the processing-option contract of the
 * in-process path.
 *
 * What these tests protect:
 *   - a flagless delegated run adopts an unfinished cursor's stored options,
 *     exactly as the in-process CLI does (#6712 PR 1: neither side sends nor
 *     reads an explicit-processing list any more; a resume inherits the
 *     cursor's opt-outs);
 *   - an older CLI's typed `--no-embed` never resumes a cursor storing
 *     `noEmbed=false` into embedding: the opt-out applies to the requests the
 *     run freezes (it used to refuse the resume with `invalid_params`);
 *   - a runtime embedding deferral (the cost gate's auto-defer) is not a
 *     processing option: adopting a cursor that stores `noEmbed=false` never
 *     turns embedding back on for the run, in-process or delegated, and the
 *     cursor does not keep the deferral. A provider spy sees zero embedding
 *     calls and no embedding effect is queued.
 *
 * Regression each guards: a list reappearing on either builder, and the
 * deferral riding only as `noEmbed`.
 * Existing coverage (`serve-sync-handoff.serial.test.ts`) delegates only onto
 * fresh sources, so a resume never crossed the wire there.
 *
 * #6712 PR 4b: a non-company source runs the live pass, which keeps no cursor; the
 * opt-outs a flagless run inherits live on the pass row's open episode.
 *
 * Serial: the runner is a module singleton and the tests bind local sockets.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type net from 'node:net';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { startResolveIpcServer, type IpcHandlers } from '../src/core/context/resolve-ipc.ts';
import { localIpcSocketPath } from '../src/core/context/ipc-path.ts';
import { __resetDelegatedSyncForTests, getDelegatedSyncStatus, startDelegatedSync } from '../src/core/serve-sync-runner.ts';
import { maybeDelegateManagedSyncToServe, parseDelegatedSyncArgs, type ManagedDelegationDeps } from '../src/commands/sync-delegate.ts';
import { runSync, type SyncOpts } from '../src/commands/sync.ts';
import type { ConsumerRow } from '../src/core/persistence/consumer-heartbeat.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-delegated-options-'));
const SECRET = randomBytes(32).toString('hex');
const servers: net.Server[] = [];
const sources: string[] = [];
let engine: BrainEngine;
const embedded: string[] = [];
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_BACKUP_CHECK: 'off', GBRAIN_SYNC_NO_EXTRACT_NUDGE: '1', OPENAI_API_KEY: 'sk-test-delegated-options' };

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture(count: number): Promise<{ id: string; root: string }> {
  const id = `options-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nA durable observation number ${i} about acme-example.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}

/** An unfinished cursor: one page of `count` committed under the given options, the rest still to freeze. */
async function partialCursor(id: string, opts: Partial<SyncOpts>): Promise<void> {
  expect(await performManagedSync(engine, { sourceId: id, noPull: true, ...opts } as SyncOpts, { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  await drainEffects();
  embedded.length = 0;
}

/** The opt-outs of the pass row's open episode (what a flagless pass inherits), or null when no episode is open. */
const episodeOptions = async (id: string) => (await engine.executeRaw<{ inherited: { noEmbed: boolean; noExtract: boolean; noSchemaPack: boolean } | null }>(
  "SELECT completed_keys->0->'obligations'->'episode'->'inherited' AS inherited FROM op_checkpoints WHERE op='managed-sync-pass' AND completed_keys->0->>'source_id'=$1", [id]))[0]?.inherited ?? null;
/** Embedding effects queued for this source's page requests (any state): zero means no provider call can follow. */
const embeddingEffects = async (id: string) => (await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM persistence_effects WHERE source_id=$1 AND kind='embedding'", [id]))[0]!.n;

/** Runs the effect worker the way the owner does, with the embedding provider replaced by the spy. */
async function drainEffects(): Promise<void> {
  await disposePersistenceConsumer(engine);
  for (let i = 0; i < 10; i++) {
    const n = await runPersistenceEffects(engine, { engine: 'pglite', embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536 }, { hostId: localHostId(), limit: 20 });
    if (!n) break;
  }
}

async function waitTerminal(jobId: string): Promise<ReturnType<typeof getDelegatedSyncStatus>> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const s = getDelegatedSyncStatus(jobId);
    if (!s.ok || s.state === 'done' || s.state === 'error') return s;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle: ${JSON.stringify(s)}`);
    await Bun.sleep(50);
  }
}

async function serveSocket(): Promise<string> {
  const sock = localIpcSocketPath(join(mkdtempSync(join(tmpdir(), 'options-sock-')), 'resolve.sock'));
  const handlers: IpcHandlers = {
    resolve: async () => null,
    sync_start: (req) => startDelegatedSync(engine, req.options, req.clientToken, { registration: req.registration }),
    sync_status: (req) => getDelegatedSyncStatus(req.jobId, typeof req.afterLine === 'number' ? req.afterLine : 0),
    sync_abort: () => ({ ok: true, protocol: 2 as const }),
  };
  const server = await startResolveIpcServer(sock, handlers, { secret: SECRET });
  if (!server) throw new Error('could not bind the test IPC socket');
  servers.push(server);
  return sock;
}

const serveRow = (): ConsumerRow => ({
  host_id: 'host', pid: 4242, nonce: 'n1', pid_ns: null, kind: 'serve', mode: 'full', started_at: new Date().toISOString(),
  renewed_at: new Date().toISOString(), restart_required: false, root_barrier_age_ms: null, pool: null,
  host_json_path: '/tmp/host.json', persistence_home: '/tmp', minted_under: null, version: 'test',
});
const deps = (sock: string): ManagedDelegationDeps => ({
  config: { engine: 'postgres', database_url: 'postgresql://example.invalid/brain' },
  probe: async () => serveRow(), socket: async () => ({ sock, secret: SECRET }), env: {},
});
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const origError = console.error, origLog = console.log, origWrite = process.stderr.write.bind(process.stderr), origOut = process.stdout.write.bind(process.stdout);
  console.error = () => {}; console.log = () => {};
  process.stderr.write = (() => true) as typeof process.stderr.write; process.stdout.write = (() => true) as typeof process.stdout.write;
  try { return await fn(); } finally { console.error = origError; console.log = origLog; process.stderr.write = origWrite; process.stdout.write = origOut; }
};

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: env.OPENAI_API_KEY } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    embedded.push(...values);
    return { embeddings: values.map(() => [1, ...new Array(1535).fill(0)]) };
  }) as never);
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite;
}, 120_000);
afterEach(() => { __resetDelegatedSyncForTests(); _resetCliExitVerdictForTests(); process.exitCode = 0; });
afterAll(async () => {
  for (const server of servers) { try { server.close(); } catch { /* noop */ } }
  await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
  });
  __setEmbedTransportForTests(null);
  resetGateway();
  rmSync(home, { recursive: true, force: true });
});

describe('the client builders send no explicit-processing list (#6712 PR 1)', () => {
  test('parseDelegatedSyncArgs: a flagless argv sends no list; a processing flag sends exactly its option', () => {
    const flagless = parseDelegatedSyncArgs(['--source', 'acme-example', '--no-pull']);
    // #6712 PR 1: no list crosses the wire; the serve's resume inherits the cursor's opt-outs, as in-process.
    expect(flagless.ok && 'explicitProcessing' in flagless.options).toBe(false);
    const flagged = parseDelegatedSyncArgs(['--source', 'acme-example', '--no-pull', '--no-extract']);
    expect(flagged.ok && flagged.options).toEqual({ noPull: true, noExtract: true });
  });

  test('a flagless delegated run adopts the unfinished cursor\'s stored options (noEmbed=true) instead of refusing', async () => withEnv(env, async () => {
    const f = await fixture(3);
    await partialCursor(f.id, { noEmbed: true, noExtract: true });
    expect(await episodeOptions(f.id)).toMatchObject({ noEmbed: true, noExtract: true, noSchemaPack: false });
    const sock = await serveSocket();
    const delegated = await quiet(() => maybeDelegateManagedSyncToServe(engine, ['--source', f.id, '--no-pull'],
      { sourceId: f.id, noPull: true, drain: true } as SyncOpts, deps(sock)).catch((error: unknown) => error));
    expect(delegated).toMatchObject({ kind: 'delegated', result: { status: 'first_sync' } });
    expect(await engine.getPage('notes/n2', { sourceId: f.id })).not.toBeNull();
    // The adopted options are the cursor's: no page request of this source embeds.
    expect(await embeddingEffects(f.id)).toBe(0);
  }), 180_000);
});

describe('the serve infers a missing list from an older CLI\'s true-valued flags', () => {
  test('sync_start without explicitProcessing (older CLI) adopts the stored options', async () => withEnv(env, async () => {
    const f = await fixture(3);
    await partialCursor(f.id, { noEmbed: true, noExtract: true });
    const local = await registerLocalWriter(engine, 'cli');
    const start = await startDelegatedSync(engine, { sourceId: f.id, noPull: true, timeoutSeconds: 120 }, randomUUID(),
      { registration: { id: local.id, credential: local.credential, lane: 'cli' } });
    expect(start.ok).toBe(true);
    const done = await quiet(() => waitTerminal(start.jobId!));
    expect(done.jobErrorEnvelope).toBeUndefined();
    expect(done).toMatchObject({ state: 'done', result: { status: 'first_sync' } });
  }), 180_000);

  // #6712 PR 1 (#6552 §1): the refusal is gone. The typed opt-out applies to the requests this run freezes, so it still embeds nothing.
  test('an older CLI\'s --no-embed (noEmbed: true, no list) never resumes a noEmbed=false cursor into embedding', async () => withEnv(env, async () => {
    const f = await fixture(3);
    await partialCursor(f.id, {});
    expect(await episodeOptions(f.id)).toBeNull();
    const before = await embeddingEffects(f.id);
    const local = await registerLocalWriter(engine, 'cli');
    const start = await startDelegatedSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, timeoutSeconds: 120 }, randomUUID(),
      { registration: { id: local.id, credential: local.credential, lane: 'cli' } });
    expect(start.ok).toBe(true);
    const done = await quiet(() => waitTerminal(start.jobId!));
    expect(done.jobErrorEnvelope).toBeUndefined();
    expect(done).toMatchObject({ state: 'done', result: { status: 'first_sync' } });
    // The --no-embed pass converged, so the opt-out episode it opened is closed.
    expect(await episodeOptions(f.id)).toBeNull();
    await drainEffects();
    expect(await embeddingEffects(f.id)).toBe(before);
    expect(embedded).toEqual([]);
  }), 180_000);
});

describe('a runtime embedding deferral is never lifted by cursor adoption', () => {
  test('delegated: the deferral crosses the wire; a cursor storing noEmbed=false embeds nothing in this run', async () => withEnv(env, async () => {
    const f = await fixture(3);
    await partialCursor(f.id, {});
    expect(await episodeOptions(f.id)).toBeNull();
    const before = await embeddingEffects(f.id);
    const sock = await serveSocket();
    const delegated = await quiet(() => maybeDelegateManagedSyncToServe(engine, ['--source', f.id, '--no-pull'],
      { sourceId: f.id, noPull: true, noEmbed: true, embedDeferred: true, drain: true } as SyncOpts, deps(sock)).catch((error: unknown) => error));
    expect(delegated).toMatchObject({ kind: 'delegated', result: { status: 'first_sync' } });
    await drainEffects();
    expect(await embeddingEffects(f.id)).toBe(before);
    expect(embedded).toEqual([]);
    // No episode keeps the deferral: it is a property of this run, not of the source.
    expect(await episodeOptions(f.id)).toBeNull();
  }), 180_000);

  test('in-process CLI: the cost gate auto-defers (non-TTY, floor $0); adoption of noEmbed=false still makes zero embedding calls', async () => withEnv(env, async () => {
    const f = await fixture(3);
    await engine.setConfig('sync.cost_gate_min_usd', '0');
    try {
      await engine.executeRaw("UPDATE sources SET config=jsonb_set(config,'{syncEnabled}','false'::jsonb) WHERE id<>$1", [f.id]);
      await partialCursor(f.id, {});
      const before = await embeddingEffects(f.id);
      await quiet(() => runSync(engine, ['--source', f.id, '--no-pull', '--no-auto-embed']));
      expect(await engine.getPage('notes/n2', { sourceId: f.id })).not.toBeNull();
      await drainEffects();
      expect(await embeddingEffects(f.id)).toBe(before);
      expect(embedded).toEqual([]);
    } finally {
      await engine.executeRaw("DELETE FROM config WHERE key='sync.cost_gate_min_usd'");
      await engine.executeRaw("UPDATE sources SET config=config-'syncEnabled'");
    }
  }), 180_000);
});
