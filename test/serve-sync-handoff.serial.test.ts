/**
 * #6317 (D1 a′): serve-delegated managed sync with a verified CLI-registration
 * hand-off — the runner's authorization seam and the Postgres ladder's client
 * half, hermetic on PGLite (the ladder takes its brain config, heartbeat probe
 * and socket through seams; the serve half is the real resolve-IPC server
 * bound to the real runner).
 *
 * What these tests protect:
 *   - the gate is NOT lifted: a shared-secret sync_start on a managed brain
 *     still fails `writer_coordinator_required` (assertDurableSyncCaller /
 *     assertUnmanagedCanonicalWriter by design);
 *   - the hand-off refuses a denied, revoked or stdio registration at
 *     sync_start with `permission_denied` and the OperationError envelope;
 *   - a verified `cli` registration runs the managed drain inside the serve:
 *     sync_status carries the drain's own lines (the `[sync] managed catch-up`
 *     start line), the DrainReport and `next`; the line cursor never resends;
 *   - the Postgres ladder: `--no-delegate` bypasses it before the classifier,
 *     an unsupported flag / a non-serve owner / no socket / GBRAIN_SERVE_SYNC_IPC=0
 *     / an older serve (`unknown_kind`, `stale_serve`) each keep the CLI's own
 *     consumer with ONE actionable line, and a live serve runs the drain and
 *     hands back the SyncResult the in-process printers take, with
 *     `gbrain sync --source <id> --no-pull --json` admitted unchanged.
 *
 * Marked .serial.test.ts: the runner is a module singleton
 * (__resetDelegatedSyncForTests) and the tests bind local sockets.
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
import { ownConsumerForcedReason, resetOwnConsumerForTest } from '../src/core/persistence/consumer-election.ts';
import { registerLocalWriter, revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { startResolveIpcServer, type IpcHandlers } from '../src/core/context/resolve-ipc.ts';
import { localIpcSocketPath } from '../src/core/context/ipc-path.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import {
  __resetDelegatedSyncForTests,
  getDelegatedSyncStatus,
  startDelegatedSync,
} from '../src/core/serve-sync-runner.ts';
import { maybeDelegateManagedSyncToServe, type ManagedDelegationDeps } from '../src/commands/sync-delegate.ts';
import { implyManagedNoPull } from '../src/commands/sync/managed-no-pull.ts';
import type { ConsumerRow } from '../src/core/persistence/consumer-heartbeat.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-handoff-'));
const sources: string[] = [];
let engine: BrainEngine;
const SECRET = randomBytes(32).toString('hex');
const servers: net.Server[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A managed source: a claimed git worktree of `count` notes on an activated brain (the managed-sync-drain fixture). */
async function fixture(count: number): Promise<{ id: string; root: string }> {
  const id = `handoff-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nA durable observation number ${i}.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}

async function waitTerminal(jobId: string, timeoutMs = 120_000): Promise<ReturnType<typeof getDelegatedSyncStatus>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = getDelegatedSyncStatus(jobId);
    if (!s.ok || s.state === 'done' || s.state === 'error') return s;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle: ${JSON.stringify(s)}`);
    await Bun.sleep(50);
  }
}

/** The serve half: the real resolve-IPC server with the real runner's sync handlers (the binding's wiring). */
async function serveSocket(handlers?: Partial<IpcHandlers>, secret = SECRET): Promise<string> {
  const sock = localIpcSocketPath(join(mkdtempSync(join(tmpdir(), 'handoff-sock-')), 'resolve.sock'));
  const base: IpcHandlers = {
    resolve: async () => null,
    sync_start: (req) => startDelegatedSync(engine, req.options, req.clientToken, { registration: req.registration }),
    sync_status: (req) => getDelegatedSyncStatus(req.jobId, typeof req.afterLine === 'number' ? req.afterLine : 0),
    sync_abort: () => ({ ok: true, protocol: 2 as const }),
  };
  const server = await startResolveIpcServer(sock, { ...base, ...handlers }, { secret });
  if (!server) throw new Error('could not bind the test IPC socket');
  servers.push(server);
  return sock;
}

/** Drop a revoked cli registration (row + private file) so the next test registers a fresh principal; host.json stays (the consumer's host identity). */
async function forgetCliRegistration(id: string): Promise<void> {
  await engine.executeRaw('DELETE FROM persistence_local_writers WHERE id=$1::uuid', [id]);
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  rmSync(join(home, '.gbrain', 'persistence', `${brain.brain_id}.cli.json`), { force: true });
}

const serveRow = (over: Partial<ConsumerRow> = {}): ConsumerRow => ({
  host_id: 'host', pid: 4242, nonce: 'n1', pid_ns: null, kind: 'serve', mode: 'full', started_at: new Date().toISOString(),
  renewed_at: new Date().toISOString(), restart_required: false, root_barrier_age_ms: null, pool: null,
  host_json_path: '/tmp/host.json', persistence_home: '/tmp', minted_under: null, version: 'test', ...over,
});

const captured: string[] = [];
const origError = console.error;
const origWrite = process.stderr.write.bind(process.stderr);
function captureStderr(): void {
  captured.length = 0;
  console.error = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
  process.stderr.write = ((chunk: string | Uint8Array) => { captured.push(String(chunk).replace(/\n$/, '')); return true; }) as typeof process.stderr.write;
}
function releaseStderr(): void { console.error = origError; process.stderr.write = origWrite; }

function deps(over: Partial<ManagedDelegationDeps> & { sock?: string | null; secret?: string | null; row?: ConsumerRow | null }): ManagedDelegationDeps {
  return {
    config: { engine: 'postgres', database_url: 'postgresql://example.invalid/brain' },
    probe: async () => over.row === undefined ? serveRow() : over.row,
    socket: async () => ({ sock: over.sock ?? null, secret: over.secret === undefined ? SECRET : over.secret }),
    env: over.env ?? {},
    ...(over.config !== undefined ? { config: over.config } : {}),
  };
}

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite;
}, 120_000);
afterEach(() => { __resetDelegatedSyncForTests(); releaseStderr(); });
afterAll(async () => {
  for (const server of servers) { try { server.close(); } catch { /* noop */ } }
  await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
    await engine.disconnect();
  });
  rmSync(home, { recursive: true, force: true });
});

describe('sync_start authorization hand-off (serve half)', () => {
  test('the shared-secret lane still refuses a managed brain: the gate is a hand-off, not a lift', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    const start = startDelegatedSync(engine, { sourceId: f.id, noPull: true, timeoutSeconds: 60 }, randomUUID());
    expect(start.ok).toBe(true);
    const done = await waitTerminal(start.jobId!);
    expect(done.state).toBe('error');
    expect(done.jobErrorEnvelope).toMatchObject({ error: 'writer_coordinator_required' });
    expect(done.managed).toBeUndefined();
  }), 120_000);

  test('a registration that never existed is refused at sync_start with permission_denied and the envelope', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    const start = await startDelegatedSync(engine, { sourceId: f.id, noPull: true, timeoutSeconds: 60 }, randomUUID(),
      { registration: { id: randomUUID(), credential: randomBytes(32).toString('hex'), lane: 'cli' } });
    expect(start.ok).toBe(false);
    expect(start.error).toBe('permission_denied');
    expect(start.refusal).toMatchObject({ error: 'permission_denied', code: 'permission_denied' });
    expect(typeof start.refusal!.message).toBe('string');
    expect((start.refusal!.fix as { argv: string[] }).argv).toEqual(['gbrain', 'auth', 'local-writer', 'list', '--json']);
    // The slot is retained terminal (a token retry attaches to the refusal, never a duplicate run), and the status says error.
    const status = getDelegatedSyncStatus(start.jobId!);
    expect(status.state).toBe('error');
    expect(status.jobErrorEnvelope).toMatchObject({ error: 'permission_denied' });
  }), 120_000);

  test('a revoked cli registration is refused with permission_denied', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    const local = await registerLocalWriter(engine, 'cli');
    expect(await revokeLocalWriter(engine, local.id)).toBe(true);
    try {
      const start = await startDelegatedSync(engine, { sourceId: f.id, noPull: true, timeoutSeconds: 60 }, randomUUID(),
        { registration: { id: local.id, credential: local.credential, lane: 'cli' } });
      expect(start.ok).toBe(false);
      expect(start.error).toBe('permission_denied');
      expect(start.refusal).toMatchObject({ error: 'permission_denied' });
      expect(String(start.refusal!.message)).toMatch(/revoked/);
    } finally {
      // The revocation persists in the row; re-register a fresh cli principal for the tests that follow.
      await forgetCliRegistration(local.id);
    }
  }), 120_000);

  test('a stdio-principal registration is refused: by shape (lane stdio) and by lane mismatch (a stdio row presented as cli)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    const stdio = await registerLocalWriter(engine, 'stdio');
    const shaped = await startDelegatedSync(engine, { sourceId: f.id, noPull: true, timeoutSeconds: 60 }, randomUUID(),
      { registration: { id: stdio.id, credential: stdio.credential, lane: 'stdio' } });
    expect(shaped).toEqual({ ok: false, protocol: 2, error: 'invalid_options:registration' });
    const forged = await startDelegatedSync(engine, { sourceId: f.id, noPull: true, timeoutSeconds: 60 }, randomUUID(),
      { registration: { id: stdio.id, credential: stdio.credential, lane: 'cli' } });
    expect(forged.ok).toBe(false);
    expect(forged.error).toBe('permission_denied');
    expect(forged.refusal).toMatchObject({ error: 'permission_denied' });
  }), 120_000);

  test('a verified cli registration runs the managed drain inside the serve; sync_status carries its lines, the DrainReport and next', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(4);
    const local = await registerLocalWriter(engine, 'cli');
    const start = await startDelegatedSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, timeoutSeconds: 120 }, randomUUID(),
      { registration: { id: local.id, credential: local.credential, lane: 'cli' } });
    expect(start.ok).toBe(true);
    const done = await waitTerminal(start.jobId!);
    expect(done.state).toBe('done');
    expect(done.managed).toBe(true);
    expect(done.result).toMatchObject({ status: 'first_sync', added: 4 });
    expect(done.drain).toMatchObject({ outcome: 'synced', written: 4, remaining: 0 });
    expect(done.next).toBeNull();
    const lines = (done.lines ?? []).map(l => l.text);
    expect(lines.some(l => l.startsWith('[sync] managed catch-up: 4 entries frozen'))).toBe(true);
    expect(done.lineSeq).toBe(lines.length);
    // The line cursor: a poll after the newest sequence resends nothing; one before it resends the tail only.
    expect(getDelegatedSyncStatus(start.jobId!, done.lineSeq!).lines).toEqual([]);
    expect(getDelegatedSyncStatus(start.jobId!, done.lineSeq! - 1).lines).toHaveLength(1);
    // The writer is this CLI principal: the committed requests carry it, not a shared-secret lane.
    const rows = await engine.executeRaw<{ principal_id: string; n: number }>(
      'SELECT principal_id, count(*)::int AS n FROM persistence_requests WHERE source_id=$1 GROUP BY principal_id', [f.id]);
    expect(rows.map(r => r.principal_id)).toEqual([local.id]);
  }), 180_000);

  test('#6712: an older CLI\'s retired field is dropped and its notice reaches that CLI as the first job line', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    const local = await registerLocalWriter(engine, 'cli');
    const start = await startDelegatedSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, explicitProcessing: ['noEmbed'], timeoutSeconds: 120 }, randomUUID(),
      { registration: { id: local.id, credential: local.credential, lane: 'cli' } });
    expect(start.ok).toBe(true);
    const done = await waitTerminal(start.jobId!);
    expect(done.state).toBe('done');
    const first = done.lines?.[0]?.text ?? '';
    expect(first).toStartWith('[gbrain notice]');
    expect(first).toContain('`explicitProcessing`');
  }), 180_000);
});

describe('maybeDelegateManagedSyncToServe (the Postgres ladder, client half)', () => {
  const baseOpts = (sourceId: string): SyncOpts => ({ sourceId, noPull: true, noEmbed: true, drain: true });

  test('--no-delegate and GBRAIN_SYNC_NO_DELEGATE=1 bypass the ladder before anything is probed', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    let probed = 0;
    const d = { ...deps({}), probe: async () => { probed++; return serveRow(); } };
    resetOwnConsumerForTest();
    expect(await maybeDelegateManagedSyncToServe(engine, ['--no-delegate', '--repo', '/x'], baseOpts(f.id), d)).toEqual({ kind: 'own_consumer', reason: 'opted_out', line: null });
    // #6543: the opt-out makes this process a full consumer even under persistence.single_consumer.
    expect(ownConsumerForcedReason()).toBe('opted_out');
    resetOwnConsumerForTest();
    expect(await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), { ...d, env: { GBRAIN_SYNC_NO_DELEGATE: '1' } })).toEqual({ kind: 'own_consumer', reason: 'opted_out', line: null });
    expect(probed).toBe(0);
  }), 120_000);

  test('no live owner, or a non-serve owner, keeps the CLI\'s own consumer (one line names a non-serve owner)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    captureStderr();
    expect(await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), deps({ row: null }))).toEqual({ kind: 'own_consumer', reason: 'no_owner', line: null });
    const jobs = await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), deps({ row: serveRow({ kind: 'jobs', pid: 777 }) }));
    releaseStderr();
    expect(jobs).toMatchObject({ kind: 'own_consumer', reason: 'owner_not_serve' });
    expect(jobs.kind === 'own_consumer' && jobs.line).toMatch(/jobs process \(PID 777\).*own consumer/);
    expect(captured.filter(l => l.includes('PID 777'))).toHaveLength(1);
  }), 120_000);

  test('an unsupported flag, the kill switch and a missing socket each fall back with one actionable line, never a refusal', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    resetOwnConsumerForTest();
    captureStderr();
    const flag = await maybeDelegateManagedSyncToServe(engine, ['--exclude', 'x'], baseOpts(f.id), deps({ sock: await serveSocket() }));
    const kill = await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), { ...deps({ sock: await serveSocket() }), env: { GBRAIN_SERVE_SYNC_IPC: '0' } });
    const noSock = await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), deps({ sock: null }));
    releaseStderr();
    expect(flag).toMatchObject({ kind: 'own_consumer', reason: 'unsupported_flag' });
    expect(flag.kind === 'own_consumer' && flag.line).toMatch(/`--exclude` isn't supported through serve-delegated sync; this run does not delegate to the serve \(PID 4242\): it admits its own writes, and with persistence.single_consumer on the serve's consumer publishes them/);
    expect(kill).toMatchObject({ kind: 'own_consumer', reason: 'kill_switch' });
    expect(kill.kind === 'own_consumer' && kill.line).toMatch(/GBRAIN_SERVE_SYNC_IPC=0.*does not delegate to the serve \(PID 4242\)/);
    expect(kill.kind === 'own_consumer' && kill.line).not.toContain('own consumer beside');
    expect(noSock).toMatchObject({ kind: 'own_consumer', reason: 'no_socket' });
    expect(noSock.kind === 'own_consumer' && noSock.line).toMatch(/exposes no sync IPC socket.*Restart that serve on this gbrain version/);
    expect(captured).toHaveLength(3);
    // #6543: none of these rungs forces this process's own consumer beside the serve.
    expect(ownConsumerForcedReason()).toBeNull();
  }), 120_000);

  test('#6543: a serve whose IPC socket does not answer cannot take the run, so this process consumes itself (forced past single_consumer)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    const dead = join(home, `dead-${randomUUID().slice(0, 8)}.sock`);
    writeFileSync(dead, '');
    resetOwnConsumerForTest();
    captureStderr();
    const silent = await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), deps({ sock: dead }));
    releaseStderr();
    expect(silent).toMatchObject({ kind: 'own_consumer', reason: 'no_socket' });
    expect(silent.kind === 'own_consumer' && silent.line).toMatch(/not answering its IPC socket/);
    expect(ownConsumerForcedReason()).toBe('no_socket');
    resetOwnConsumerForTest();
  }), 120_000);

  test('skew (T1c): a stale serve without the protocol echo forces this process\'s own consumer; a current serve answering unsupported_kind (kinds absent or disabled) falls back without forcing', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    // A pre-delegation serve answers `unknown_kind:sync_start` without a protocol echo → stale_serve (degraded) on the client.
    const legacy = await serveSocket({ sync_start: (() => ({ ok: false, error: 'unknown_kind:sync_start' })) as unknown as IpcHandlers['sync_start'] });
    // A serve of this family without the sync kinds, or with them disabled (GBRAIN_SERVE_SYNC_IPC=0 on the serve) → `unsupported_kind` with the echo.
    const absent = await serveSocket({ sync_start: undefined, sync_status: undefined, sync_abort: undefined });
    const disabled = await serveSocket({ sync_start: () => ({ ok: false, protocol: 2, error: 'unsupported_kind' }) });
    resetOwnConsumerForTest();
    captureStderr();
    const stale = await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), deps({ sock: legacy }));
    releaseStderr();
    expect(stale).toMatchObject({ kind: 'own_consumer', reason: 'older_serve' });
    expect(stale.kind === 'own_consumer' && stale.line).toMatch(/predates serve-delegated managed sync.*own consumer beside the serve \(PID 4242\).*Restart that serve/);
    // #6543: the stale serve cannot take the run, so this process consumes itself.
    expect(ownConsumerForcedReason()).toBe('older_serve');
    resetOwnConsumerForTest();
    captureStderr();
    const withoutKinds = await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), deps({ sock: absent }));
    const unsupported = await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), deps({ sock: disabled }));
    releaseStderr();
    for (const outcome of [withoutKinds, unsupported]) {
      expect(outcome).toMatchObject({ kind: 'own_consumer', reason: 'older_serve' });
      expect(outcome.kind === 'own_consumer' && outcome.line).toMatch(/runs with serve-delegated managed sync off.*does not delegate to the serve \(PID 4242\)/);
    }
    expect(captured).toHaveLength(2);
    // #6543: a healthy current serve with delegation off keeps consuming, so neither fallback forces a second consumer.
    expect(ownConsumerForcedReason()).toBeNull();
    // Nothing was admitted by the serve: the source's cursor is untouched.
    const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1', [f.id]);
    expect(n).toBe(0);
  }), 120_000);

  test('#6696 (A5): the CLI sends origin interactive in the delegation payload', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    const origins: unknown[] = [];
    captureStderr();
    const result = await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), deps({ sock: await serveSocket({ sync_start: (req) => {
      origins.push((req.options as { origin?: unknown }).origin);
      return { ok: false, protocol: 2 as const, error: 'busy' };
    } }) }));
    releaseStderr();
    expect(origins).toEqual(['interactive']);
    expect(result).toMatchObject({ kind: 'own_consumer', reason: 'serve_refused' });
  }), 120_000);

  test('a wrong IPC secret (unauthorized) falls back; the serve bound to another source (source_mismatch) falls back', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    captureStderr();
    const unauthorized = await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), deps({ sock: await serveSocket(), secret: randomBytes(32).toString('hex') }));
    const mismatch = await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id),
      deps({ sock: await serveSocket({ sync_start: (req) => startDelegatedSync(engine, req.options, req.clientToken, { boundSourceId: 'other', registration: req.registration }) }) }));
    releaseStderr();
    expect(unauthorized).toMatchObject({ kind: 'own_consumer', reason: 'serve_refused' });
    expect(mismatch).toMatchObject({ kind: 'own_consumer', reason: 'serve_refused' });
    expect(mismatch.kind === 'own_consumer' && mismatch.line).toMatch(/bound to a different source/);
  }), 120_000);

  test('the hand-off refusal is terminal: a revoked CLI registration throws the permission_denied OperationError the in-process path throws', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    const local = await registerLocalWriter(engine, 'cli');
    await revokeLocalWriter(engine, local.id);
    try {
      captureStderr();
      const thrown = await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), deps({ sock: await serveSocket() })).catch(e => e);
      releaseStderr();
      // The CLI reads its own registration before the hand-off, so a revoked one fails here exactly as the in-process path does.
      expect(thrown).toBeInstanceOf(OperationError);
      expect((thrown as OperationError).code).toBe('permission_denied');
      expect((thrown as OperationError).message).toMatch(/revoked/);
    } finally {
      await forgetCliRegistration(local.id);
    }
  }), 120_000);

  test('a refusal the serve answers (its verification lost the race with a revocation) is rethrown with the envelope\'s code, reason and fix', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(1);
    const refusal = { error: 'permission_denied', code: 'permission_denied', message: 'Local writer registration is unavailable or revoked.', suggestion: 'Review it.',
      reason: 'trusted_cli_required', why: 'The row was revoked.', fix: { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists registrations.' }, contract_version: 1 };
    const sock = await serveSocket({ sync_start: () => ({ ok: false, protocol: 2, error: 'permission_denied', refusal }) });
    captureStderr();
    const thrown = await maybeDelegateManagedSyncToServe(engine, [], baseOpts(f.id), deps({ sock })).catch(e => e);
    releaseStderr();
    expect(thrown).toBeInstanceOf(OperationError);
    expect((thrown as OperationError).toJSON()).toMatchObject({ error: 'permission_denied', message: refusal.message, suggestion: 'Review it.', reason: 'trusted_cli_required', why: 'The row was revoked.', contract_version: 1 });
    expect((thrown as OperationError).fix?.argv).toEqual(refusal.fix.argv);
  }), 120_000);

  test('`gbrain sync --source <id> --no-pull --json` delegates unchanged: the serve drains, the CLI prints the drain\'s lines and gets the SyncResult back', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(5);
    const sock = await serveSocket();
    captureStderr();
    const outcome = await maybeDelegateManagedSyncToServe(engine, ['--source', f.id, '--no-pull', '--json'], { ...baseOpts(f.id), noEmbed: undefined }, deps({ sock }));
    releaseStderr();
    expect(outcome.kind).toBe('delegated');
    if (outcome.kind !== 'delegated') throw new Error('unreachable');
    expect(outcome.pid).toBe(4242);
    expect(outcome.result).toMatchObject({ status: 'first_sync', added: 5, pagesAffected: expect.any(Array) });
    expect(outcome.result.drain).toMatchObject({ outcome: 'synced', written: 5, remaining: 0 });
    expect(outcome.result.managedCursor).toMatchObject({ index: 5, total: 5 });
    expect(captured.some(l => l.includes('running the managed catch-up inside it as this CLI\'s writer'))).toBe(true);
    expect(captured.some(l => l.startsWith('[sync] managed catch-up: 5 entries frozen'))).toBe(true);
    // Every request the drain admitted carries this CLI's registration, so the in-process grant and revocation checks applied.
    const local = await registerLocalWriter(engine, 'cli');
    const rows = await engine.executeRaw<{ principal_id: string }>('SELECT DISTINCT principal_id FROM persistence_requests WHERE source_id=$1', [f.id]);
    expect(rows.map(r => r.principal_id)).toEqual([local.id]);
  }), 180_000);

  test('#6543 C1: `gbrain sync --source <id>` without --no-pull on a managed brain delegates with --no-pull implied and the serve drains it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await fixture(2);
    const sock = await serveSocket();
    const flags = { noPull: false, dryRun: false };
    captureStderr();
    await implyManagedNoPull(engine, flags, f.id);
    const outcome = await maybeDelegateManagedSyncToServe(engine, ['--source', f.id, '--json'], { ...baseOpts(f.id), noPull: flags.noPull, noEmbed: undefined }, deps({ sock }));
    releaseStderr();
    expect(captured.some(l => l.includes('--no-pull is implied') && l.includes(`gbrain sources refresh ${f.id}`))).toBe(true);
    expect(outcome.kind).toBe('delegated');
    if (outcome.kind !== 'delegated') throw new Error('unreachable');
    expect(outcome.result).toMatchObject({ status: 'first_sync', added: 2 });
  }), 180_000);
});
