/**
 * Managed sync delegation to a serve of an older build: when the serve's hand-off
 * fails with a bare internal_error (a symbol the older module graph lacks), the CLI
 * falls back to its own consumer with a line naming both builds instead of
 * surfacing the raw error.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
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
import { startResolveIpcServer, type IpcHandlers } from '../src/core/context/resolve-ipc.ts';
import { localIpcSocketPath } from '../src/core/context/ipc-path.ts';
import { maybeDelegateManagedSyncToServe } from '../src/commands/sync-delegate.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import type { ConsumerRow } from '../src/core/persistence/consumer-heartbeat.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-build-skew-'));
const SECRET = randomBytes(32).toString('hex');
const env = { GBRAIN_HOME: home, GBRAIN_BACKUP_CHECK: 'off' };
let engine: BrainEngine;
let server: net.Server | null = null;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite;
}, 120_000);
afterAll(async () => {
  try { server?.close(); } catch { /* noop */ }
  await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  _resetCliExitVerdictForTests();
  rmSync(home, { recursive: true, force: true });
});

test('a serve of an older build failing the hand-off with internal_error falls back with a restart notice', async () => withEnv(env, async () => {
  const id = `skew-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  git('init', '-q'); writeFileSync(join(root, 'notes', 'n.md'), '---\ntitle: N\n---\nbody\n');
  git('add', '.'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'n');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

  const sock = localIpcSocketPath(join(mkdtempSync(join(tmpdir(), 'skew-sock-')), 'resolve.sock'));
  const handlers: IpcHandlers = {
    resolve: async () => null,
    sync_start: () => ({ ok: false, protocol: 2 as const, error: 'internal_error',
      refusal: { error: 'internal_error', message: "Export named 'hostIdFor' not found in module 'identity.ts'." } }) as never,
    sync_status: () => ({ ok: false, protocol: 2 as const }) as never,
    sync_abort: () => ({ ok: true, protocol: 2 as const }),
  };
  server = await startResolveIpcServer(sock, handlers, { secret: SECRET });
  if (!server) throw new Error('could not bind the test IPC socket');
  const row: ConsumerRow = {
    host_id: 'host', pid: 4242, nonce: 'n1', pid_ns: null, kind: 'serve', mode: 'full', started_at: new Date().toISOString(),
    renewed_at: new Date().toISOString(), restart_required: false, root_barrier_age_ms: null, pool: null,
    host_json_path: '/tmp/host.json', persistence_home: '/tmp', minted_under: null, version: '0.0.1',
  };
  const lines: string[] = [];
  const origError = console.error; console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
  let outcome: unknown;
  try {
    outcome = await maybeDelegateManagedSyncToServe(engine, ['--source', id, '--no-pull'], { sourceId: id, noPull: true, drain: true } as SyncOpts, {
      config: { engine: 'postgres', database_url: 'postgresql://example.invalid/brain' },
      probe: async () => row, socket: async () => ({ sock, secret: SECRET }), env: {},
    }).catch((error: unknown) => error);
  } finally { console.error = origError; }
  expect(outcome).toMatchObject({ kind: 'own_consumer', reason: 'older_serve' });
  expect(lines.join('\n')).toMatch(/v0\.0\.1.*this CLI is v/);
}), 120_000);
