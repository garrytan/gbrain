import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { runSync } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { maybeDelegateManagedSyncToServe } from '../src/commands/sync-delegate.ts';
import { errorCodeRow } from '../src/core/error-docs.ts';
import '../src/core/agent-output.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';

// #6696 C2: a managed source keeps every failed-receipt and ignored-file guard, so `--skip-failed` and
// `--include-gitignored` are refused. They used to pass parse, get forwarded to a resident serve and fail inside
// its job with a message naming neither flag. Now the refusal is `managed_sync_flag_refused`, names the flag,
// and comes before anything runs: at parse in `gbrain sync`, before the socket call in the delegation ladder,
// and in the managed-sync guard every other caller (jobs, MCP, the cycle) reaches.
//
// Regression guarded: the parse-time check removed (the job runs and fails), the ladder forwarding the flag to
// the serve, or the deep guard falling back to the anonymous writer_coordinator_required refusal.

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-flags-'));
let engine: BrainEngine;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_BACKUP_CHECK: 'off', GBRAIN_SYNC_NO_EXTRACT_NUDGE: '1', OPENAI_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});
async function fixture(): Promise<string> {
  const id = `flags-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  writeFileSync(join(root, 'a.md'), '---\ntitle: a\n---\nA durable observation about acme-example.\n');
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await engine.executeRaw("UPDATE sources SET config=jsonb_set(config,'{syncEnabled}','false'::jsonb) WHERE id<>$1", [id]);
  return id;
}
/** Nothing ran: no request admitted, no cursor written for the source. */
async function untouched(id: string): Promise<void> {
  expect(await engine.executeRaw('SELECT 1 FROM persistence_requests WHERE source_id=$1', [id])).toEqual([]);
  expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [id])).toEqual([]);
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const origError = console.error, origLog = console.log, origWrite = process.stderr.write.bind(process.stderr);
  console.error = () => {}; console.log = () => {}; process.stderr.write = (() => true) as typeof process.stderr.write;
  try { return await fn(); } finally { console.error = origError; console.log = origLog; process.stderr.write = origWrite; }
};

test.each(['--skip-failed', '--include-gitignored'])('gbrain sync %s on a managed source is refused at parse, naming the flag, with a runnable fix', async flag => withEnv(env, async () => {
  const id = await fixture();
  const error = await quiet(() => runSync(engine, ['--source', id, '--no-pull', '--no-embed', flag])).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(OperationError);
  expect((error as OperationError).code).toBe('managed_sync_flag_refused');
  expect((error as OperationError).message).toContain(flag);
  expect((error as OperationError).detail).toBe(flag);
  const fix = (error as OperationError).toJSON().fix as { argv: string[]; next: string; verify?: { argv?: string[] } };
  expect(fix.argv).toEqual(['gbrain', 'sync', '--source', id, '--no-pull', '--no-embed']);
  expect(fix.next).toBe('run');
  expect(fix.verify?.argv).toEqual(['gbrain', 'sync', 'status', '--source', id, '--json']);
  await untouched(id);
}), 120_000);

test('gbrain sync --all --skip-failed on a managed brain is refused before any source runs', async () => withEnv(env, async () => {
  const id = await fixture();
  const error = await quiet(() => runSync(engine, ['--all', '--no-pull', '--no-embed', '--skip-failed'])).then(() => null, (e: unknown) => e);
  expect(error).toMatchObject({ code: 'managed_sync_flag_refused', detail: '--skip-failed' });
  await untouched(id);
}), 120_000);

test('the delegation ladder refuses before it looks for the serve\'s socket', async () => withEnv(env, async () => {
  const id = await fixture();
  let socketLookups = 0;
  const error = await quiet(() => maybeDelegateManagedSyncToServe(engine, ['--source', id, '--no-pull', '--include-gitignored'],
    { sourceId: id, noPull: true, includeGitignored: true, drain: true } as SyncOpts, {
      config: { engine: 'postgres', database_url: 'postgresql://example.invalid/brain' },
      probe: async () => ({ host_id: 'host', pid: 4242, nonce: 'n1', pid_ns: null, kind: 'serve', mode: 'full', started_at: new Date().toISOString(),
        renewed_at: new Date().toISOString(), restart_required: false, root_barrier_age_ms: null, pool: null, host_json_path: '/tmp/host.json',
        persistence_home: '/tmp', minted_under: null, version: 'test' }),
      socket: async () => { socketLookups++; return { sock: null, secret: null }; }, env: {},
    })).then(() => null, (e: unknown) => e);
  expect(error).toMatchObject({ code: 'managed_sync_flag_refused', detail: '--include-gitignored' });
  expect(socketLookups).toBe(0);
  await untouched(id);
}), 120_000);

test('every other managed caller (jobs, MCP, the cycle) gets the same named refusal from the managed-sync guard', async () => withEnv(env, async () => {
  const id = await fixture();
  const error = await performManagedSync(engine, { sourceId: id, noPull: true, skipFailed: true } as SyncOpts).then(() => null, (e: unknown) => e);
  expect(error).toMatchObject({ code: 'managed_sync_flag_refused', detail: '--skip-failed' });
  await untouched(id);
}), 120_000);

test('gbrain errors managed_sync_flag_refused resolves offline', () => {
  expect(errorCodeRow('managed_sync_flag_refused')).toMatchObject({ code: 'managed_sync_flag_refused', class: 'caller', docs: 'docs/guides/write-refusals.md#managed_sync_flag_refused' });
});
