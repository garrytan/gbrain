/**
 * Rust engine owner IPC (src/core/rust-engine/owner-ipc/): a second process on a Rust brain becomes a client of the
 * owner process and sends its BrainEngine calls over the owner socket. Most owners here host a PGLite engine (the
 * server takes any BrainEngine); the write-journal blocks with the built addon run a real Rust owner, so a forwarded
 * put_page runs the real Rust journal and the test pins where it stops today (the publication effects step).
 *
 * 1. Protects: two or more client processes read and write one brain through its owner; their results and errors are
 *    byte-identical to the same calls made in-process; calls end with `timeout` / `cancelled` within the caller's
 *    deadline or signal and never leak a permit (a request already past its deadline never runs); closing the owner
 *    waits for running engine calls; members outside the cut refuse at once; a dead owner gives
 *    `owner_unavailable` to the calls in flight, and a Rust engine's next call reaches the new owner or makes it the
 *    owner, with no restart.
 * 2. Fails on: a codec that drops a type (Date, Float32Array, error codes), a server that frees a permit before the
 *    engine call settles, a client that hangs on an owner that died, a client that stays stuck on a dead owner, or a
 *    route table that forwards transaction().
 * 3. Existing coverage: none; the owner socket is new. rust-engine-shell.test.ts covers only the lifecycle.
 * 4. Seam: none beyond the public `serveOwnerEngine` / `connectOwner` / `installOwnerClient` and the OpenRustEngine
 *    `ownerWaitMs` option the CLI path also reads.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { electOwner, type OwnerRole } from '../src/core/rust-engine/owner-ipc/election.ts';
import { ownerWholeOperations } from '../src/core/rust-engine/owner-ipc/owner-ops.ts';
import { connectOwner, installOwnerClient, ownerConnectionFor } from '../src/core/rust-engine/owner-ipc/client.ts';
import { serveOwnerEngine } from '../src/core/rust-engine/owner-ipc/server.ts';
import { OWNER_IPC_ROUTES } from '../src/core/rust-engine/owner-ipc/routes.ts';
import { waitFor } from './helpers/wait-for.ts';
import { OWNER_IPC_VERSION, ownerLockPath, ownerSocketPath, readFrames } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { forwardWholeOperation } from '../src/core/rust-engine/owner-ipc/whole-op.ts';
import { importFromContent, type ImportResult } from '../src/core/import-file.ts';
import { callerAccessRecord, currentCallerAccess, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { storePagePolicy } from '../src/core/rust-engine/store-members/private-provenance.ts';
import { decodeError, decodeValue, encodeValue } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { withReadDeadline } from '../src/core/read-deadline.ts';
import { requestSignal } from '../src/core/request-signal.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { maybeDelegateLocalOperation } from '../src/core/persistence/local-client.ts';
import { persistenceSocketPathForConfig, startPersistenceIpcServer } from '../src/core/persistence/ipc.ts';
import { withEnv } from './helpers/with-env.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { openRustEngine, RustEngine } from '../src/core/rust-engine.ts';
import { STORE_MEMBERS } from '../src/core/rust-engine/store-members/index.ts';
import { servedCapabilities } from '../src/core/rust-engine/store-capabilities.ts';
import { bindResolveIpcForServe } from '../src/mcp/resolve-ipc-binding.ts';
import { EventEmitter, once } from 'node:events';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { errorShape, readScript } from './helpers/owner-ipc-child.ts';
import { migrateAccessStore } from '../src/core/access/policy-migrate.ts';
import { readAccessStore } from '../src/core/access/policy.ts';
import { currentSubmissionAuthority, withSubmissionAuthority, type SubmissionAuthority } from '../src/core/minions/submission-authority.ts';

const CHILD = join(import.meta.dir, 'helpers', 'owner-ipc-child.ts');

function runChild(mode: string, databasePath: string, worker = 0): Promise<{ code: number | null; out: Record<string, unknown>; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, mode, databasePath, String(worker)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      const line = stdout.trim().split('\n').pop() ?? '';
      try { resolve({ code, out: JSON.parse(line), stderr }); }
      catch { reject(new Error(`child ${mode} printed no JSON (exit ${code}): ${stdout}\n${stderr}`)); }
    });
  });
}

/** A client engine in this process: a bare object with the owner members installed, as RustEngine.connect does. */
async function clientOf(socketPath: string): Promise<{ engine: BrainEngine; close: () => void }> {
  const connection = await connectOwner(socketPath);
  const engine = { kind: 'rust', capabilities: new Set<string>() } as unknown as BrainEngine;
  const close = installOwnerClient(engine, connection);
  return { engine, close };
}

describe('owner socket codec', () => {
  test('round-trips the values BrainEngine results carry', () => {
    const value = {
      date: new Date('2026-11-17T15:00:00.000Z'), big: 12345678901234567890n, vec: new Float32Array([1.5, -2]),
      f64: new Float64Array([0.25]), bytes: new Uint8Array([1, 2, 3]), map: new Map([['a', 1]]), set: new Set(['x']),
      nothing: undefined, nan: Number.NaN, neg0: -0, nested: [{ deep: null }],
    };
    const back = decodeValue(JSON.parse(JSON.stringify(encodeValue(value)))) as typeof value;
    expect(back.date).toEqual(value.date);
    expect(back.big).toBe(value.big);
    expect(back.vec).toBeInstanceOf(Float32Array);
    expect([...back.vec]).toEqual([1.5, -2]);
    expect([...back.f64]).toEqual([0.25]);
    expect([...back.bytes]).toEqual([1, 2, 3]);
    expect(back.map.get('a')).toBe(1);
    expect(back.set.has('x')).toBe(true);
    expect('nothing' in back).toBe(true);
    expect(Number.isNaN(back.nan)).toBe(true);
    expect(Object.is(back.neg0, -0)).toBe(true);
    expect(back.nested).toEqual([{ deep: null }]);
  });
  test('keeps an own __proto__ field, top level and nested, as JSON.parse made it', () => {
    const value = JSON.parse('{"__proto__":{"polluted":1},"keep":true,"nested":[{"__proto__":"x","$t":"tag"}]}');
    const back = decodeValue(JSON.parse(JSON.stringify(encodeValue(value)))) as Record<string, unknown>;
    expect(JSON.stringify(back)).toBe(JSON.stringify(value));
    expect(Object.hasOwn(back, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('two or more client processes on one owner', () => {
  let dir: string;
  let db: string;
  let owner: PGLiteEngine;
  let role: OwnerRole;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-'));
    db = join(dir, 'brain.rust');
    owner = new PGLiteEngine();
    await owner.connect({});
    await owner.initSchema();
    role = await electOwner(owner, db, { wholeOperations: ownerWholeOperations() });
  }, 120_000);

  afterAll(async () => {
    if (role?.role === 'owner') { await role.server.close(); await role.lock.release(); }
    await owner?.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('this process owns the brain', () => {
    expect(role.role).toBe('owner');
  });

  test('a symlink alias of the brain directory reaches the same owner as a client', async () => {
    const alias = join(dir, 'alias.rust');
    symlinkSync(db, alias, 'dir');
    expect(ownerLockPath(alias)).toBe(ownerLockPath(db));
    expect(ownerSocketPath(alias)).toBe(ownerSocketPath(db));
    // A directory not created yet under a symlinked parent resolves through that parent.
    const parentAlias = join(dir, 'parent-alias');
    symlinkSync(dir, parentAlias, 'dir');
    expect(ownerLockPath(join(parentAlias, 'new.rust'))).toBe(ownerLockPath(join(dir, 'new.rust')));
    const second = await electOwner(owner, alias, { waitMs: 3_000 });
    try {
      expect(second.role).toBe('client');
      if (second.role === 'client') expect(await second.connection.request('call', 'getPage', ['nothing-here'])).toBeNull();
    } finally {
      if (second.role === 'client') second.connection.close();
      else { await second.server.close(); await second.lock.release(); }
    }
  });

  test('two writer processes put pages, links, timeline and a whole import through the owner', async () => {
    const results = await Promise.all([runChild('write', db, 0), runChild('write', db, 1)]);
    for (const [worker, r] of results.entries()) {
      expect(r.out.fatal, r.stderr).toBeUndefined();
      expect(r.code).toBe(0);
      expect(r.out.role).toBe('client');
      expect(r.out.imported).toEqual({ slug: `ipc/imported-${worker}`, status: 'imported' });
      expect(r.out.fromFile).toEqual({ slug: `ipc/file-${worker}`, status: 'imported' });
    }
    const pages = await owner.listPages({ limit: 100 });
    expect(pages.map(p => p.slug).sort()).toEqual([
      'ipc/imported-0', 'ipc/imported-1', 'ipc/file-0', 'ipc/file-1',
      ...[0, 1].flatMap(w => [0, 1, 2, 3, 4].map(n => `ipc/w${w}-${n}`)),
    ].sort());
    expect((await owner.getBacklinks('ipc/w1-0')).length).toBe(4);
    expect((await owner.getTimeline('ipc/w0-0')).length).toBe(1);
    // The owner sees each client's socket close a moment after the client process exits.
    const stats = () => role.role === 'owner' ? role.server.stats() : null;
    for (let i = 0; i < 100 && stats()?.connections !== 0; i++) await Bun.sleep(10);
    expect(stats()).toEqual({ active: 0, queued: 0, connections: 0, inflightBytes: 0 });
  }, 120_000);

  test('two reader processes get results byte-identical to in-process calls', async () => {
    const local = JSON.stringify(await readScript(owner));
    const results = await Promise.all([runChild('read', db, 0), runChild('read', db, 1)]);
    for (const r of results) {
      expect(r.out.fatal, r.stderr).toBeUndefined();
      expect(r.out.role).toBe('client');
      delete r.out.role;
      expect(JSON.stringify(r.out)).toBe(local);
    }
    const parsed = JSON.parse(local) as Record<string, { ok?: unknown }>;
    expect(parsed.get.ok).toMatchObject({ slug: 'ipc/w0-0' });
    expect(parsed.missing.ok).toBeNull();
    expect((parsed.keyword.ok as unknown[]).length).toBeGreaterThan(0);
    expect((parsed.hybrid.ok as unknown[]).length).toBeGreaterThan(0);
  }, 120_000);

  test('an engine error crosses the socket with the same code, message and fields', async () => {
    const { engine, close } = await clientOf(ownerSocketPath(db));
    try {
      const local = await owner.putPage('', { type: 'note', title: 'x', compiled_truth: 'x' }).then(() => null, e => errorShape(e));
      const remote = await engine.putPage('', { type: 'note', title: 'x', compiled_truth: 'x' }).then(() => null, e => errorShape(e));
      expect(local).not.toBeNull();
      expect(JSON.stringify(remote)).toBe(JSON.stringify(local));
    } finally { close(); }
  });

  test('transaction() and other members outside the cut refuse at once with the typed error', async () => {
    const { engine, close } = await clientOf(ownerSocketPath(db));
    try {
      const started = Date.now();
      const error = await engine.transaction(async () => 1).then(() => null, e => e);
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('engine_capability_missing');
      expect((error as OperationError).detail).toContain('via=owner_ipc');
      const reserved = await engine.withReservedConnection(async () => 1).then(() => null, e => e);
      expect((reserved as OperationError).code).toBe('engine_capability_missing');
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally { close(); }
  });

  // Value: protects=the two store getters hand a caller an object whose calls must run inside the owner's transaction, so a client refuses them at once and nothing runs; fails_when=worktreeClaimStore or writerAdminStore is forwarded (the owner would return a store the client cannot send) or refuses with another code; why_new=the two getters came with the port's typed members; seam=none; no_claim=what the owner's transaction does with them
  test('worktreeClaimStore() and writerAdminStore() refuse at once with engine_capability_missing, as transaction() does', async () => {
    const { engine, close } = await clientOf(ownerSocketPath(db));
    try {
      expect(OWNER_IPC_ROUTES.worktreeClaimStore).toBe('refuse');
      expect(OWNER_IPC_ROUTES.writerAdminStore).toBe('refuse');
      for (const member of ['worktreeClaimStore', 'writerAdminStore'] as const) {
        const error = await engine[member]().then(() => null, e => e);
        expect(error).toBeInstanceOf(OperationError);
        expect((error as OperationError).code).toBe('engine_capability_missing');
        expect((error as OperationError).detail).toContain(`member=${member}`);
        expect((error as OperationError).detail).toContain('via=owner_ipc');
      }
    } finally { close(); }
  });

  // The store switch of `gbrain access rule migrate` runs in a transaction, which does not cross the owner socket: a
  // client refuses before any write, so no journal row or policy file is left behind to block a later migration.
  test('access rule migrate from a client refuses before any write', async () => {
    await owner.executeRaw("INSERT INTO sources (id, name) VALUES ('migr', 'migr') ON CONFLICT (id) DO NOTHING");
    const { engine, close } = await clientOf(ownerSocketPath(db));
    try {
      const error = await migrateAccessStore(engine, 'migr', 'database').then(() => null, e => e);
      expect([(error as OperationError).code, (error as OperationError).detail?.includes('via=owner_ipc')]).toEqual(['engine_capability_missing', true]);
      expect([await owner.readUnfinishedAccessMigration('migr'), await readAccessStore(owner, 'migr')]).toEqual([null, null]);
    } finally { close(); }
  });

  test('a whole import carries the client\'s holdNoncanonicalPrivate option to the owner\'s importFromContent unchanged', async () => {
    const { engine, close } = await clientOf(ownerSocketPath(db));
    try {
      const content = '---\ntitle: Held upper value\ntype: note\nvisibility: Private\n---\nA note about acme-example.\n';
      const held = await forwardWholeOperation<ImportResult>(engine, 'importFromContent', ['ipc/held-upper', content, { noEmbed: true, holdNoncanonicalPrivate: true }]);
      // The owner's importFromContent saw the option: it held the page with the in-process refusal and stored nothing.
      expect(held?.status).toBe('error');
      expect(held?.refusal?.code).toBe('visibility_noncanonical');
      expect(await owner.getPage('ipc/held-upper')).toBeNull();
      const local = await importFromContent(owner, 'ipc/held-upper', content, { noEmbed: true, holdNoncanonicalPrivate: true });
      expect(JSON.stringify(held)).toBe(JSON.stringify(local));
    } finally { close(); }
  });
});

describe('deadlines, cancel and permits', () => {
  let dir: string;
  let owner: PGLiteEngine;
  let server: NonNullable<Awaited<ReturnType<typeof serveOwnerEngine>>>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-dl-'));
    owner = new PGLiteEngine();
    await owner.connect({});
    await owner.initSchema();
    // A slow member that ends only when its request signal aborts: the permit stays held until then.
    (owner as unknown as Record<string, unknown>).getHealth = () => new Promise((_resolve, reject) => {
      requestSignal()?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    // A write that ends only when its request signal aborts, like getHealth: the owner may still commit it.
    (owner as unknown as Record<string, unknown>).insertFact = () => new Promise((_resolve, reject) => {
      requestSignal()?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    // getRecentSalience answers with the caller access the owner ran it under, after the Rust store's own privacy gate.
    (owner as unknown as Record<string, unknown>).getRecentSalience = async (opts?: { excludePrivate?: boolean }) => {
      storePagePolicy('getRecentSalience', opts?.excludePrivate);
      const record = callerAccessRecord();
      return record ? { identity: [...record.identity], labelledOnly: record.labelledOnly, owner: record.owner } : null;
    };
    const served = await serveOwnerEngine(owner, join(dir, 'owner.sock'), { permits: 2 });
    if (!served) throw new Error('no socket');
    server = served;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await owner?.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const settled = async () => {
    for (let i = 0; i < 100 && (server.stats().active > 0 || server.stats().queued > 0); i++) await Bun.sleep(10);
    return server.stats();
  };

  test('a call past its read deadline ends with timeout, queued calls too, and no permit leaks', async () => {
    const { engine, close } = await clientOf(server.socketPath);
    try {
      const started = Date.now();
      // One deadline for all four, so a queued call never takes a permit a running call released.
      const deadline = Date.now() + 300;
      const calls = [0, 1, 2, 3].map(() => withReadDeadline(deadline, () => engine.getHealth()).then(() => null, e => e));
      await Bun.sleep(100);
      expect(server.stats()).toMatchObject({ active: 2, queued: 2 });
      const errors = await Promise.all(calls);
      // The two that ran may have done their work (the store does not see the abort), so their outcome is unknown; the
      // two queued never ran and keep `timeout`.
      expect(errors.map(e => (e as OperationError).code)).toEqual(['owner_unavailable', 'owner_unavailable', 'timeout', 'timeout']);
      expect(errors.map(e => (e as OperationError).reason)).toEqual(['outcome_unknown', 'outcome_unknown', 'not_started', 'not_started']);
      // getHealth only reads, so a rerun is safe even after the send.
      expect(errors.map(e => (e as OperationError).retryable)).toEqual([true, true, true, true]);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await settled()).toMatchObject({ active: 0, queued: 0 });
      // The pool still serves: a fast call after the timeouts completes.
      expect(await engine.getPage('nothing-here')).toBeNull();
    } finally { close(); }
  });

  // Value: protects=a write whose answer never came back after the send is reported unknown with the read that confirms
  // it, never as safe to rerun; fails_when=a sent write's cancel or deadline says retryable or advises a rerun without
  // naming listFactsByEntity; why_new=the cancel and deadline tests above use getHealth, which writes nothing;
  // seam=none; no_claim=whether the owner committed the fact
  test('a write cancelled or past its deadline after the send is unknown, not retryable, and names the facts read for that entity', async () => {
    const { engine, close } = await clientOf(server.socketPath);
    const fact = [{ fact: 'x', entity_slug: 'people/alice-example', source: 'test' }, { source_id: 'default' }] as never[];
    try {
      const controller = new AbortController();
      const cancelled = withRequestSignal(controller.signal, () => (engine.insertFact as (...a: never[]) => Promise<unknown>)(...fact)).then(() => null, e => e);
      await waitFor(() => server.stats().active === 1, { label: 'insertFact running on the owner' });
      controller.abort();
      const timedOut = withReadDeadline(Date.now() + 150, () => (engine.insertFact as (...a: never[]) => Promise<unknown>)(...fact)).then(() => null, e => e);
      for (const error of [(await cancelled) as OperationError, (await timedOut) as OperationError]) {
        expect(error).toMatchObject({ code: 'owner_unavailable', reason: 'outcome_unknown', retryable: false });
        expect(error.suggestion).toBe('Before you rerun insertFact, run listFactsByEntity for that entity to see whether it committed; rerun it only if it did not.'
          + ' The owner answers that read only after the earlier insertFact call has ended, so what it finds is final.'
          + (error.message.includes('did not finish within') ? ' If calls keep timing out, the owner process is busy: check its log.' : ''));
      }
      // Before the send nothing ran, so the answers stay as they were: `cancelled`, and a retryable `timeout`.
      const early = (await withRequestSignal(AbortSignal.abort(), () => (engine.insertFact as (...a: never[]) => Promise<unknown>)(...fact)).then(() => null, e => e)) as OperationError;
      expect(early.code).toBe('cancelled');
      const late = (await withReadDeadline(Date.now() - 1, () => (engine.insertFact as (...a: never[]) => Promise<unknown>)(...fact)).then(() => null, e => e)) as OperationError;
      // Already past its deadline: it ends before it runs (at the client, or in the owner queue), so a retry is safe.
      expect(late).toMatchObject({ code: 'timeout', retryable: true });
      expect(['not_sent', 'not_started']).toContain(late.reason as string);
      expect(await settled()).toMatchObject({ active: 0, queued: 0 });
    } finally { close(); }
  });

  test('a labelled-only caller reads under its own access on the owner, and is refused as it is in process', async () => {
    const { engine, close } = await clientOf(server.socketPath);
    const labelled = { identity: ['member:alice-example'], labelledOnly: true, owner: false, applyRemoteReadPolicy: true, restricted: true };
    try {
      // No record in the caller: none on the owner either.
      expect(await engine.getRecentSalience({ excludePrivate: false } as never)).toBeNull();
      // The record crosses the socket: the owner sees the same member and the same labelled-only flag.
      const seen: unknown = await withCallerAccess(labelled, () => engine.getRecentSalience({ excludePrivate: false } as never));
      expect(seen).toEqual({ identity: ['member:alice-example'], labelledOnly: true, owner: false });
      // excludePrivate under that record: the owner refuses with the error the same call gets in process.
      const local = await withCallerAccess(labelled, async () => { storePagePolicy('getRecentSalience', true); return currentCallerAccess(); })
        .then(() => null, e => errorShape(e));
      const remote = await withCallerAccess(labelled, () => engine.getRecentSalience({ excludePrivate: true } as never)).then(() => null, e => errorShape(e));
      expect(local).not.toBeNull();
      expect(JSON.stringify(remote)).toBe(JSON.stringify(local));
    } finally { close(); }
  });

  test('a cancel after the call was sent reports an unknown outcome (the owner may still commit), a cancel before it was sent reports cancelled', async () => {
    const { engine, close } = await clientOf(server.socketPath);
    try {
      const controller = new AbortController();
      const call = withRequestSignal(controller.signal, () => engine.getHealth()).then(() => null, e => e);
      await Bun.sleep(50);
      expect(server.stats().active).toBe(1);
      controller.abort();
      const sent = (await call) as OperationError;
      // The owner does not stop a call it started, so `cancelled` ("cancelled before it committed") would be untrue and
      // "run it again" would repeat a write that may have committed (a second insertFact).
      expect(sent.code).not.toBe('cancelled');
      expect(sent.reason).toBe('outcome_unknown');
      expect(sent.message).toContain('may or may not have committed');
      // getHealth only reads, so the advice says so instead of naming a read that confirms a write.
      expect(sent.suggestion).toContain('it only reads, so nothing was written');
      expect(sent.suggestion).not.toContain('run the call again to repeat it');
      expect(sent.detail).toContain('sent=true');
      expect(await settled()).toMatchObject({ active: 0, queued: 0 });
      const already = await withRequestSignal(AbortSignal.abort(), () => engine.getPage('x')).then(() => null, e => e);
      expect((already as OperationError).code).toBe('cancelled');
      expect((already as OperationError).detail).toContain('sent=false');
    } finally { close(); }
  });

  test('a request that arrives after its deadline ends with timeout and never runs, so a write does not commit', async () => {
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = net.connect(server.socketPath);
      let buf = '';
      socket.on('error', reject);
      socket.on('data', chunk => {
        buf += chunk;
        for (const line of buf.split('\n').slice(0, -1)) {
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.t === 'result') { socket.destroy(); resolve(frame); }
        }
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      });
      socket.on('connect', () => socket.write(JSON.stringify({ t: 'hello', version: OWNER_IPC_VERSION }) + '\n' + JSON.stringify({
        t: 'call', id: 1, member: 'putPage', deadline_at: Date.now() - 1_000,
        args: encodeValue(['ipc/expired', { type: 'note', title: 'Expired', compiled_truth: 'must not be written' }]),
      }) + '\n'));
    });
    expect(reply.ok).toBe(false);
    expect((decodeError(reply.error as never) as OperationError).code).toBe('timeout');
    expect((decodeError(reply.error as never) as OperationError).reason).toBe('not_started');
    expect(await owner.getPage('ipc/expired')).toBeNull();
    expect(await settled()).toMatchObject({ active: 0, queued: 0 });
  });

  test('a client that disconnects aborts its running calls', async () => {
    const { engine, close } = await clientOf(server.socketPath);
    const call = engine.getHealth().then(() => null, e => e);
    await Bun.sleep(50);
    expect(server.stats().active).toBe(1);
    close();
    await call;
    expect(await settled()).toMatchObject({ active: 0, queued: 0 });
  });
});

describe('fair queueing across clients', () => {
  test('a client that floods the owner does not starve another client\'s single call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-fair-'));
    // One permit and a member that holds the permit until the test opens the gate. The queue order alone decides
    // who runs next, so the result does not depend on how fast this machine is.
    let finished = 0;
    let openGate!: () => void;
    const gate = new Promise<void>(resolve => { openGate = resolve; });
    const engine = {
      kind: 'fake', capabilities: new Set<string>(),
      getHealth: async () => { await gate; return { finished: ++finished }; },
    } as unknown as BrainEngine;
    const served = await serveOwnerEngine(engine, join(dir, 'owner.sock'), { permits: 1 });
    if (!served) throw new Error('no socket');
    const flood = await clientOf(served.socketPath);
    const single = await clientOf(served.socketPath);
    try {
      const flooded = Array.from({ length: 20 }, () => flood.engine.getHealth());
      // The first flood call holds the permit; the other nineteen wait in the flood's lane.
      await waitFor(() => served.stats().active === 1 && served.stats().queued === 19, { label: 'flood queued' });
      const mine = single.engine.getHealth() as unknown as Promise<{ finished: number }>;
      await waitFor(() => served.stats().queued === 20, { label: 'single call queued' });
      openGate();
      // Round-robin between connections: the flood's running call finishes first, the flood's next call takes the
      // freed permit, and the single call runs right after it. First come, first served would make it 21st.
      expect((await mine).finished).toBe(3);
      await Promise.all(flooded);
      expect(served.stats()).toMatchObject({ active: 0, queued: 0 });
    } finally {
      openGate();
      flood.close();
      single.close();
      await served.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('frame caps', () => {
  /** A stand-in socket: readFrames only listens for data and calls destroy. */
  const fakeSocket = () => Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });

  test.each([false, true])('a finished frame over the cap is refused, not parsed (split=%p)', split => {
    const socket = fakeSocket();
    const frames: unknown[] = [];
    const errors: string[] = [];
    readFrames(socket as unknown as net.Socket, f => frames.push(f), why => errors.push(why), 16);
    const line = Buffer.from('{"x":"12345678"}\n'); // 17 bytes with the newline
    if (split) { socket.emit('data', line.subarray(0, 15)); socket.emit('data', line.subarray(15)); }
    else socket.emit('data', line);
    expect(frames).toEqual([]);
    expect(errors).toEqual(['frame_too_large']);
    expect(socket.destroyed).toBe(true);
  });

  test('a frame exactly at the cap, newline included, is read', () => {
    const socket = fakeSocket();
    const frames: unknown[] = [];
    const errors: string[] = [];
    readFrames(socket as unknown as net.Socket, f => frames.push(f), why => errors.push(why), 16);
    socket.emit('data', Buffer.from('{"x":"1234567"}\n')); // 16 bytes with the newline
    expect(frames).toEqual([{ x: '1234567' }]);
    expect(errors).toEqual([]);
  });

  // Value: protects=a frame whose multibyte character arrives split across two socket reads is decoded whole and sized in bytes, so the frame cap and the owner's in-flight byte budget count what is on the wire; fails_when=the reader decodes each chunk on its own (the split character becomes U+FFFD) or counts characters instead of bytes; why_new=the cap tests above send ASCII only, where bytes and characters agree; seam=none; no_claim=the socket itself
  describe('a multibyte character split across two reads', () => {
    // 'é' is 2 bytes, '€' 3, the emoji 4, so the line is 5 bytes longer than its string length.
    const original = { t: 'call', id: 1, member: 'x', args: ['é€😀'] };
    const line = Buffer.from(JSON.stringify(original) + '\n');
    const euro = line.indexOf(Buffer.from('€'));
    const emoji = line.indexOf(Buffer.from('😀'));
    // The first cut lands one byte into '€', the second two bytes into the emoji.
    const parts = [line.subarray(0, euro + 1), line.subarray(euro + 1, emoji + 2), line.subarray(emoji + 2)];

    const read = (maxBytes: number, chunks: Buffer[]) => {
      const socket = fakeSocket();
      const frames: Array<{ frame: Record<string, unknown>; bytes: number }> = [];
      const errors: string[] = [];
      readFrames(socket as unknown as net.Socket, (frame, bytes) => frames.push({ frame, bytes }), why => errors.push(why), maxBytes);
      for (const chunk of chunks) socket.emit('data', chunk);
      return { frames, errors, destroyed: socket.destroyed };
    };

    test('the frame is decoded whole and its size is the byte length, not the character count', () => {
      expect(line.length).toBe(line.toString('utf8').length + 5);
      // The first cut really splits a character: read on its own, that chunk ends in U+FFFD.
      expect(parts[0]!.toString('utf8').endsWith('\ufffd')).toBe(true);
      const out = read(line.length, parts);
      expect(out.errors).toEqual([]);
      expect(out.frames).toEqual([{ frame: original, bytes: line.length }]);
    });

    test('a cap exactly at the frame bytes reads it, and one byte lower refuses it though the characters would fit', () => {
      expect(read(line.length, parts).frames).toHaveLength(1);
      const refused = read(line.length - 1, parts);
      expect(refused.frames).toEqual([]);
      expect(refused.errors).toEqual(['frame_too_large']);
      expect(refused.destroyed).toBe(true);
      // The character count of the whole line is far under that cap, so a reader that counted characters would accept it.
      expect(line.toString('utf8').length).toBeLessThan(line.length - 1);
    });

    test('a partial frame is refused as soon as its bytes pass the cap, before its newline arrives', () => {
      // The first chunk is 1 byte short of the cap in characters and over it in bytes, because it holds 'é' and half of '€'.
      const cap = parts[0]!.length - 1;
      expect(parts[0]!.toString('utf8').length).toBeLessThanOrEqual(cap);
      const out = read(cap, [parts[0]!]);
      expect(out.errors).toEqual(['frame_too_large']);
      expect(out.destroyed).toBe(true);
    });
  });

  test('a result over the cap ends the call with response_too_large and does not hang', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-cap-'));
    // A stand-in owner engine: only getConfig is called, and it answers more than the cap.
    const owner = { kind: 'pglite', getConfig: async () => 'x'.repeat(8192) } as unknown as BrainEngine;
    const served = await serveOwnerEngine(owner, join(dir, 'owner.sock'), { maxFrameBytes: 4096 });
    if (!served) throw new Error('no socket');
    const { engine, close } = await clientOf(served.socketPath);
    try {
      const outcome = await Promise.race([
        engine.getConfig('large').then(() => 'resolved', e => (e as OperationError).code),
        Bun.sleep(2_000).then(() => 'hung'),
      ]);
      expect(outcome).toBe('response_too_large');
    } finally {
      close();
      await served.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/** Wraps an owner's whole operations so a test can prove a refusal at the client sent nothing. */
function countedWholeOperations(ops: Record<string, (...a: never[]) => Promise<unknown>>, onRun: () => void): never {
  return Object.fromEntries(Object.entries(ops).map(([name, run]) => [name, (...a: never[]) => { onRun(); return run(...a); }])) as never;
}

const silentLogger = { info() {}, warn() {}, error() {} };
const localCtx = (engine: BrainEngine, extra: Record<string, unknown> = {}) =>
  ({ engine, sourceId: 'default', config: { engine: engine.kind }, remote: false, dryRun: false, logger: silentLogger, ...extra }) as never;
const wholePage = (title: string) => `---\ntitle: ${title}\ntype: note\n---\nSent whole to the owner.\n`;

describe('a page write sent whole to an owner that reports persistence_journal', () => {
  let dir: string;
  let owner: PGLiteEngine;
  let served: NonNullable<Awaited<ReturnType<typeof serveOwnerEngine>>>;
  let ran = 0;
  let putPage: (ctx: never, p: Record<string, unknown>) => Promise<unknown>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-whole-'));
    owner = new PGLiteEngine();
    await owner.connect({ database_path: join(dir, 'owner.pglite') });
    await owner.initSchema();
    const ops = ownerWholeOperations({ config: { engine: 'pglite' } as never });
    const server = await serveOwnerEngine(owner, ownerSocketPath(join(dir, 'brain.rust')), { wholeOperations: countedWholeOperations(ops as never, () => { ran++; }) });
    if (!server) throw new Error('no socket');
    served = server;
    putPage = (await import('../src/core/operations.ts')).operationsByName.put_page!.handler as never;
  }, 120_000);

  afterAll(async () => {
    await served?.close();
    await disposePersistenceConsumer(owner);
    await owner?.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('put_page from a client commits through the owner and returns the receipt the owner gives in process', async () => {
    expect(owner.capabilities.has('persistence_journal')).toBe(true);
    const { engine, close } = await clientOf(served.socketPath);
    try {
      const local = await putPage(localCtx(owner), { slug: 'whole/local', content: wholePage('Local'), request_id: crypto.randomUUID() }) as Record<string, unknown>;
      const before = ran;
      const remote = await putPage(localCtx(engine), { slug: 'whole/remote', content: wholePage('Remote'), request_id: crypto.randomUUID() }) as Record<string, unknown>;
      expect(ran - before).toBe(1);
      expect(Object.keys(remote).sort()).toEqual(Object.keys(local).sort());
      expect(remote).toMatchObject({ slug: 'whole/remote', state: 'committed', status: local.status, source_id: local.source_id,
        persistence: local.persistence, noop: false });
      expect((await owner.getPage('whole/remote'))?.title).toBe('Remote');
      // A retried write with the same request_id gets the stored receipt, byte for byte the one the owner replays itself.
      const again = { slug: 'whole/remote', content: wholePage('Remote'), request_id: remote.request_id };
      const replayed = await putPage(localCtx(engine), again);
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(await putPage(localCtx(owner), again)));
      expect(served.stats()).toMatchObject({ active: 0, queued: 0 });
    } finally { close(); }
  }, 120_000);

  test('a refused write gives the client the error the owner gives in process', async () => {
    const { engine, close } = await clientOf(served.socketPath);
    try {
      const bad = { slug: '../escape', content: wholePage('Bad'), request_id: '10000000-0000-4000-8000-0000000000aa' };
      const local = await putPage(localCtx(owner), bad).then(() => null, e => errorShape(e));
      const remote = await putPage(localCtx(engine), bad).then(() => null, e => errorShape(e));
      expect(local).not.toBeNull();
      expect(JSON.stringify(remote)).toBe(JSON.stringify(local));
    } finally { close(); }
  });

  test('a caller other than the trusted local CLI is refused at the client and nothing is sent', async () => {
    const { engine, close } = await clientOf(served.socketPath);
    try {
      const before = ran;
      for (const extra of [{ remote: true }, { auth: { token: '', clientId: 'x', scopes: ['write'] } }, { viaSubagent: true }]) {
        const error = await putPage(localCtx(engine, extra), { slug: 'whole/refused', content: wholePage('No') }).then(() => null, e => e) as OperationError;
        expect(error?.code).toBe('engine_capability_missing');
        expect(error.detail).toContain('via=owner_ipc');
      }
      expect(ran).toBe(before);
      expect(await owner.getPage('whole/refused')).toBeNull();
    } finally { close(); }
  });
});

/**
 * The explicit no-journal fixture: a Rust engine with persistence_journal and managed_persistence taken off this one
 * instance, as an owner on a build whose store did not serve them reports. The store reports the journal now
 * (store-capabilities.ts), so the describes that pin the refusal take it off here.
 */
function withoutJournal<E extends { capabilities: ReadonlySet<string> }>(engine: E): E {
  for (const capability of ['persistence_journal', 'managed_persistence']) (engine.capabilities as Set<string>).delete(capability);
  return engine;
}

// A real Rust owner, built from the addon `bun run rust:build` writes (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing
// addon an error). The store reports persistence_journal (store-capabilities.ts), so a forwarded put_page runs the real
// Rust journal end to end: the journal admits the write, the page store writes inside
// the publication transaction, the store keeps the publication's effects (insertPublicationEffects), and the request
// commits. No raw SQL is asked for inside the publication.
const ADDON_TARGET = detectAddonTarget();
const ADDON_BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${ADDON_TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = ADDON_TARGET !== null && existsSync(ADDON_BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON_BUILT} does not exist; run bun run rust:build`);
}

describe.skipIf(!HAVE_ADDON)('a page write sent whole to a real Rust owner on the real write journal', () => {
  let dir: string;
  let owner: RustEngine;
  let socketPath: string;
  const refusals: Array<{ inTransaction: boolean; code: unknown; reason: unknown; sql: string }> = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-rust-journal-'));
    const db = join(dir, 'brain.rust');
    mkdirSync(db, { recursive: true });
    const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: ADDON_BUILT } });
    owner = openRustEngine({ addon, databasePath: db });
    // The released state: the store reports the journal before connect, so the owner socket's hello names it.
    expect(owner.capabilities.has('persistence_journal')).toBe(true);
    // Record each executeRaw refusal, on the owner and on its transaction-bound clones (they inherit this property). The
    // owner's background writer loops also ask for raw SQL outside any transaction; the publication runs inside one.
    const refuse = (RustEngine.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).executeRaw!;
    Object.defineProperty(owner, 'executeRaw', { configurable: true, writable: true, value(this: RustEngine, ...a: unknown[]) {
      return refuse.apply(this, a).catch((e: OperationError) => {
        refusals.push({ inTransaction: this !== owner, code: e?.code, reason: e?.reason, sql: String(a[0]).trim().split(/\s+/).slice(0, 3).join(' ') });
        throw e;
      });
    } });
    await owner.connect({ engine: 'rust', database_path: db } as never);
    // The connected engine won the owner election, so it already serves the owner socket with the real whole operations.
    socketPath = ownerSocketPath(db);
    expect(existsSync(socketPath)).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (owner) await disposePersistenceConsumer(owner as unknown as BrainEngine);
    await owner?.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test('put_page reaches the journal and commits through the real Rust owner; no raw SQL inside the publication', async () => {
    const { engine, close } = await clientOf(socketPath);
    try {
      const { operationsByName } = await import('../src/core/operations.ts');
      const requestId = crypto.randomUUID();
      const result = await operationsByName.put_page!.handler(localCtx(engine), { slug: 'journal/rust', content: wholePage('Rust'), request_id: requestId }) as Record<string, unknown>;
      // The caller gets the committed receipt, never write_pending or a capability refusal.
      expect(result).toMatchObject({ slug: 'journal/rust', state: 'committed', noop: false });
      // The publication ran on typed members only: nothing inside it asked the owner for raw SQL.
      expect(refusals.filter(r => r.inTransaction)).toEqual([]);
      expect((await owner.getPage('journal/rust'))?.title).toBe('Rust');
    } finally { close(); }
  }, 120_000);
});

describe('closing the owner server', () => {
  test('close() resolves only after every running engine call has settled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-close-'));
    let finished = false;
    // A member that keeps working for 300 ms after its abort, as a store write that must finish its step would.
    const owner = {
      kind: 'pglite', capabilities: new Set<string>(),
      getHealth: () => new Promise((_resolve, reject) => {
        requestSignal()?.addEventListener('abort', () => setTimeout(() => { finished = true; reject(new Error('aborted')); }, 300), { once: true });
      }),
    } as unknown as BrainEngine;
    const server = await serveOwnerEngine(owner, join(dir, 'owner.sock'));
    if (!server) throw new Error('no socket');
    const { engine, close } = await clientOf(server.socketPath);
    try {
      const call = engine.getHealth().then(() => null, e => e);
      for (let i = 0; i < 100 && server.stats().active === 0; i++) await Bun.sleep(10);
      expect(server.stats().active).toBe(1);
      await server.close();
      expect(finished).toBe(true);
      expect(server.stats().active).toBe(0);
      expect(((await call) as OperationError).code).toBe('owner_unavailable');
    } finally {
      close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an owner that exits', () => {
  /** Starts a PGLite owner child on `db` and resolves with its ready line. */
  async function ownerChild(db: string): Promise<{ child: ReturnType<typeof spawn>; pid: number }> {
    const child = spawn(process.execPath, [CHILD, 'owner', db, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let buf = '';
      child.stdout!.on('data', chunk => {
        buf += chunk;
        if (buf.includes('\n')) resolve(JSON.parse(buf.split('\n')[0]!));
      });
      child.on('close', code => reject(new Error(`owner exited ${code}`)));
    });
    expect(ready.role).toBe('owner');
    return { child, pid: ready.pid as number };
  }
  /** A store with one config key, so a call this process serves itself is told apart from one the owner served. */
  // `open` resolves the store's open result, which promises serialized_transactions as the real store does.
  class ConfigBrain { async open(): Promise<unknown> { return { serialized_transactions: true }; } async close() {} async getConfig(key: string): Promise<string | null> { return key === 'who' ? 'this-process' : null; } }
  const configAddon = { target: 'linux-x64-glibc', engine_abi: 1, Pool: class { async shutdown() {} }, Brain: ConfigBrain } as never;

  test('a client installed without rejoin: calls in flight end outcome_unknown and later calls fail fast with not_sent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-exit-'));
    const db = join(dir, 'brain.rust');
    const { child } = await ownerChild(db);
    try {
      const { engine, close } = await clientOf(ownerSocketPath(db));
      try {
        const pending = engine.getHealth().then(() => null, e => e);
        await Bun.sleep(100);
        child.kill('SIGKILL');
        const error = (await pending) as OperationError;
        expect(error.code).toBe('owner_unavailable');
        expect(error.reason).toBe('outcome_unknown');
        const started = Date.now();
        const later = (await engine.getPage('x').then(() => null, e => e)) as OperationError;
        expect(later.code).toBe('owner_unavailable');
        expect(later.reason).toBe('not_sent');
        expect(Date.now() - started).toBeLessThan(500);
      } finally { close(); }
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('a Rust engine client reaches the new owner on its next call, with no restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-handoff-'));
    const db = join(dir, 'brain.rust');
    const first = await ownerChild(db);
    let second: Awaited<ReturnType<typeof ownerChild>> | undefined;
    const rust = openRustEngine({ addon: configAddon, databasePath: db, ownerWaitMs: 5_000 });
    try {
      await rust.connect({});
      expect(rust.ownerRole).toBe('client');
      const brain = rust as unknown as BrainEngine;
      const pending = brain.getHealth().then(() => null, e => e);
      await Bun.sleep(100);
      first.child.kill('SIGKILL');
      const error = (await pending) as OperationError;
      expect(error.code).toBe('owner_unavailable');
      expect(error.reason).toBe('outcome_unknown');
      second = await ownerChild(db);
      // A whole operation runs the election too, and goes to the new owner.
      const imported = await forwardWholeOperation<ImportResult>(rust, 'importFromContent',
        ['handoff/page', '---\ntitle: Handoff\ntype: note\n---\nWritten through the new owner.\n', { noEmbed: true }]);
      expect(imported?.slug).toBe('handoff/page');
      expect(await brain.getConfig('who')).toBeNull();
      expect(rust.ownerRole).toBe('client');
      expect(rust.connected).toBe(true);
    } finally {
      await rust.disconnect();
      first.child.kill('SIGKILL');
      second?.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('with no other owner, a Rust engine client becomes the owner on its next call and serves it from its store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-takeover-'));
    const db = join(dir, 'brain.rust');
    const { child } = await ownerChild(db);
    const rust = openRustEngine({ addon: configAddon, databasePath: db, ownerWaitMs: 5_000 });
    try {
      await rust.connect({});
      expect(rust.ownerRole).toBe('client');
      const brain = rust as unknown as BrainEngine;
      child.kill('SIGKILL');
      await once(child, 'close');
      for (let i = 0; i < 200 && !ownerConnectionFor(rust)?.closed; i++) await Bun.sleep(10);
      // A whole operation that finds this process became the owner is not sent; the caller's retry runs it in process.
      const notSent = (await forwardWholeOperation(rust, 'importFromContent', ['x', 'y'])!.then(() => null, e => e)) as OperationError;
      expect(notSent.code).toBe('owner_unavailable');
      expect(notSent.reason).toBe('not_sent');
      expect(forwardWholeOperation(rust, 'importFromContent', ['x', 'y'])).toBeUndefined();
      // Two calls at once share one election.
      expect(await Promise.all([brain.getConfig('who'), brain.getConfig('who')])).toEqual(['this-process', 'this-process']);
      expect(rust.ownerRole).toBe('owner');
      expect(rust.ownerStats()).not.toBeNull();
      expect([...rust.capabilities].sort()).toEqual([...servedCapabilities(), 'serialized_transactions' as const].sort());
      // A process that opens the brain now is a client of this one.
      const { engine, close } = await clientOf(ownerSocketPath(db));
      try { expect(await engine.getConfig('who')).toBe('this-process'); } finally { close(); }
    } finally {
      await rust.disconnect();
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  describe('the first ordinary member call after the owner dies', () => {
    /** The owner has gone and this engine's client connection has seen it close, with no other call made yet. */
    async function afterOwnerDeath(first: { child: ReturnType<typeof spawn> }, rust: RustEngine) {
      const old = ownerConnectionFor(rust)!;
      first.child.kill('SIGKILL');
      await once(first.child, 'close');
      for (let i = 0; i < 200 && !old.closed; i++) await Bun.sleep(10);
      expect(old.closed).toBe(true);
      return old;
    }
    /** Counts store opens, so one election for several callers shows as one open. */
    const countedAddon = (opened: { n: number }, openMs = 0) => ({ target: 'linux-x64-glibc', engine_abi: 1, Pool: class { async shutdown() {} }, Brain: class extends ConfigBrain { async open() { opened.n++; if (openMs) await Bun.sleep(openMs); } } }) as never;
    /** Like `countedAddon`, and a `setConfig` that records what it was asked to write, so a write that ran is told from one that did not. */
    const writingAddon = (opened: { n: number }, written: string[], openMs = 0) => ({ target: 'linux-x64-glibc', engine_abi: 1, Pool: class { async shutdown() {} }, Brain: class extends ConfigBrain { async open() { opened.n++; if (openMs) await Bun.sleep(openMs); } async setConfig(key: string, value: string) { written.push(`${key}=${value}`); } } }) as never;
    const settle = (call: Promise<unknown>) => call.then(value => value, (error: { code?: string; reason?: string }) => `${error.code}/${error.reason}`);

    // Value: protects=the first ordinary call after owner death starts the rejoin, and calls at once share one election and one open; fails_when=only whole ops rejoin or each call elects; why_new=failover tests began with a whole op; seam=none; no_claim=handoff
    test('first ordinary calls made at once after the owner dies become the owner together: one store open, results kept', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-first-call-'));
      const db = join(dir, 'brain.rust');
      const first = await ownerChild(db);
      const opened = { n: 0 };
      const rust = openRustEngine({ addon: countedAddon(opened), databasePath: db, ownerWaitMs: 5_000 });
      try {
        await rust.connect({});
        expect(rust.ownerRole).toBe('client');
        expect(opened.n).toBe(0);
        await afterOwnerDeath(first, rust);
        const brain = rust as unknown as BrainEngine;
        expect(await Promise.all([brain.getConfig('who'), brain.getConfig('who'), brain.getConfig('other')].map(settle)))
          .toEqual(['this-process', 'this-process', null]);
        expect(opened.n).toBe(1);
        expect(rust.ownerRole).toBe('owner');
        expect(rust.ownerStats()).not.toBeNull();
      } finally {
        await rust.disconnect();
        first.child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    // Value: protects=a member kept from the client connection (a bound method) never starts a second election once this engine is the owner, so the owner keeps its one lock and server and its calls are served in process; fails_when=a call on a closed connection elects again with no check that the connection is still the engine's own, so the owner connects to its own socket and drops its lock; why_new=every call above goes through the engine's current members; seam=none; no_claim=a method kept from an owner that was replaced by another owner
    test('a method kept from the client connection, called again after this engine became the owner, runs in process and leaks no second owner', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-kept-'));
      const db = join(dir, 'brain.rust');
      const first = await ownerChild(db);
      const opened = { n: 0 };
      const rust = openRustEngine({ addon: countedAddon(opened), databasePath: db, ownerWaitMs: 5_000 });
      try {
        await rust.connect({});
        expect(rust.ownerRole).toBe('client');
        const kept = (rust as unknown as BrainEngine).getConfig.bind(rust);
        await afterOwnerDeath(first, rust);
        expect(await settle(kept('who'))).toBe('this-process');
        expect(rust.ownerRole).toBe('owner');
        // The connection the kept method belongs to is closed, and this engine is now the owner: it must not elect again.
        const again = await settle(withReadDeadline(Date.now() + 3_000, () => kept('who')));
        expect(again).toBe('this-process');
        expect(rust.ownerRole).toBe('owner');
        expect(rust.ownerStats()).not.toBeNull();
        expect(opened.n).toBe(1);
      } finally {
        await rust.disconnect();
        first.child.kill('SIGKILL');
        // The one owner role was given up: nothing answers on the owner socket, and the brain can be taken again.
        const answers = await connectOwner(ownerSocketPath(db)).then(c => { c.close(); return true; }, () => false);
        expect(answers).toBe(false);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    // Value: protects=a call cancelled or past its deadline while this process wins the election never runs in process; fails_when=the local member runs after the caller's signal aborted or its deadline passed; why_new=failover tests only ran calls that stayed live; seam=none; no_claim=handoff
    describe('a call that ends during the election', () => {
      /** Kills the owner, starts `start` on the first call after it, and returns its outcome and whether this process owns the brain. */
      async function duringElection(start: (brain: BrainEngine) => Promise<unknown>, written: string[] = []) {
        const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-cancel-election-'));
        const db = join(dir, 'brain.rust');
        const first = await ownerChild(db);
        const opened = { n: 0 };
        // The store open takes 20 ms, so a deadline 1 ms away has always passed when the election ends; an election
        // that finished inside the same millisecond let the call run and made the deadline case flaky.
        const rust = openRustEngine({ addon: writingAddon(opened, written, 20), databasePath: db, ownerWaitMs: 5_000 });
        try {
          await rust.connect({});
          await afterOwnerDeath(first, rust);
          const outcome = await start(rust as unknown as BrainEngine)
            .then(() => null, (error: OperationError) => `${error.code}/${error.reason ?? ''}`);
          // The election still ran, so a call that stays live is served in process.
          const live = await settle((rust as unknown as BrainEngine).getConfig('who'));
          return { outcome, live, role: rust.ownerRole };
        } finally {
          await rust.disconnect();
          first.child.kill('SIGKILL');
          rmSync(dir, { recursive: true, force: true });
        }
      }

      test('cancelled: ends cancelled and the local member never runs', async () => {
        const controller = new AbortController();
        const result = await duringElection(brain => {
          const call = withRequestSignal(controller.signal, () => brain.getConfig('who'));
          controller.abort();
          return call;
        });
        expect(result).toEqual({ outcome: 'cancelled/', live: 'this-process', role: 'owner' });
      }, 60_000);

      test('past its deadline: ends timeout not_sent and the local member never runs', async () => {
        const result = await duringElection(brain => withReadDeadline(Date.now() + 1, () => brain.getConfig('who')));
        expect(result).toEqual({ outcome: 'timeout/not_sent', live: 'this-process', role: 'owner' });
      }, 60_000);

      // Value: protects=a write cancelled or past its deadline while this process wins the election is never written; fails_when=the local member runs after the election with the caller already gone; why_new=the two tests above call getConfig, which writes nothing, so a member that ran and then reported cancelled would still pass them; seam=none; no_claim=a write interrupted inside the native store
      test('cancelled write: ends cancelled and nothing is written', async () => {
        const written: string[] = [];
        const controller = new AbortController();
        const result = await duringElection(brain => {
          const call = withRequestSignal(controller.signal, () => brain.setConfig('k', 'v'));
          controller.abort();
          return call;
        }, written);
        expect(result).toEqual({ outcome: 'cancelled/', live: 'this-process', role: 'owner' });
        expect(written).toEqual([]);
      }, 60_000);

      test('write past its deadline: ends timeout not_sent and nothing is written', async () => {
        const written: string[] = [];
        const result = await duringElection(brain => withReadDeadline(Date.now() + 1, () => brain.setConfig('k', 'v')), written);
        expect(result).toEqual({ outcome: 'timeout/not_sent', live: 'this-process', role: 'owner' });
        expect(written).toEqual([]);
      }, 60_000);
    });

    // Value: protects=a call made while this process is still opening the store it just took over (not the call that started the takeover) is checked again after the open, so a write cancelled or past its deadline in that time is never written; fails_when=the call waits for the open and then runs with no check; why_new=the tests above end the call that starts the election, which the owner client checks, not a second call that reaches the engine while the store opens; seam=none; no_claim=how many calls may wait for one open
    describe('a second call made while the store is still opening after a takeover', () => {
      async function whileOpening(second: (brain: BrainEngine) => Promise<unknown>, written: string[]) {
        const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-open-wait-'));
        const db = join(dir, 'brain.rust');
        const first = await ownerChild(db);
        const rust = openRustEngine({ addon: writingAddon({ n: 0 }, written, 400), databasePath: db, ownerWaitMs: 5_000 });
        try {
          await rust.connect({});
          await afterOwnerDeath(first, rust);
          const brain = rust as unknown as BrainEngine;
          const starter = settle(brain.getConfig('who'));
          // The engine is the owner and its own members are in place as soon as the election is decided, while the open still runs.
          for (let i = 0; i < 500 && rust.ownerRole !== 'owner'; i++) await Bun.sleep(5);
          expect(rust.ownerRole).toBe('owner');
          const waiting = second(brain).then(() => null, (error: OperationError) => `${error.code}/${error.reason ?? ''}`);
          const outcome = await waiting;
          expect(await starter).toBe('this-process');
          return outcome;
        } finally {
          await rust.disconnect();
          first.child.kill('SIGKILL');
          rmSync(dir, { recursive: true, force: true });
        }
      }

      test('cancelled while the store opens: ends cancelled and nothing is written', async () => {
        const written: string[] = [];
        const controller = new AbortController();
        const outcome = await whileOpening(brain => {
          const call = withRequestSignal(controller.signal, () => brain.setConfig('k', 'v'));
          setTimeout(() => controller.abort(), 50);
          return call;
        }, written);
        expect(outcome).toBe('cancelled/');
        expect(written).toEqual([]);
      }, 60_000);

      test('past its deadline while the store opens: ends timeout not_sent and nothing is written', async () => {
        const written: string[] = [];
        const outcome = await whileOpening(brain => withReadDeadline(Date.now() + 50, () => brain.setConfig('k', 'v')), written);
        expect(outcome).toBe('timeout/not_sent');
        expect(written).toEqual([]);
      }, 60_000);

      test('a write that stays live is written once the store has opened', async () => {
        const written: string[] = [];
        const outcome = await whileOpening(brain => brain.setConfig('k', 'v'), written);
        expect(outcome).toBeNull();
        expect(written).toEqual(['k=v']);
      }, 60_000);
    });

    // Value: protects=a call cancelled or past its deadline while the election or the store open still runs ends at once, not when the open ends, and is never written; fails_when=the call waits for the whole election or open before it checks its signal and deadline, so a slow or stuck open holds a cancelled caller; why_new=the tests above end the call before or just as a 20-400 ms open ends, so a call that waited for the open and then checked passed them; seam=none; no_claim=a store open that never ends at all
    describe('a call that ends while the takeover still opens the store', () => {
      /** A store whose open waits for the test to release it, so the test acts while this process still opens the store it took over. */
      function gatedAddon(written: string[]) {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const opened = { n: 0 };
        const addon = { target: 'linux-x64-glibc', engine_abi: 1, Pool: class { async shutdown() {} },
          Brain: class extends ConfigBrain { async open() { opened.n++; await gate; } async setConfig(key: string, value: string) { written.push(`${key}=${value}`); } } } as never;
        return { addon, opened, release };
      }
      const outcomeOf = (call: Promise<unknown>) => call.then(() => 'ran', (error: OperationError) => `${error.code}/${error.reason ?? ''}`);
      /** The call's outcome if it ends within two seconds while the open is held, else `still waiting`. */
      const whileHeld = (call: Promise<unknown>) => Promise.race([outcomeOf(call), Bun.sleep(2_000).then(() => 'still waiting')]);

      async function heldTakeover(act: (rust: RustEngine, gated: ReturnType<typeof gatedAddon>) => Promise<string>, written: string[]) {
        const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-held-open-'));
        const db = join(dir, 'brain.rust');
        const first = await ownerChild(db);
        const gated = gatedAddon(written);
        const rust = openRustEngine({ addon: gated.addon, databasePath: db, ownerWaitMs: 5_000 });
        try {
          await rust.connect({});
          await afterOwnerDeath(first, rust);
          const outcome = await act(rust, gated);
          gated.release();
          // The takeover still ends, and a call that stays live is served in process.
          const live = await settle((rust as unknown as BrainEngine).getConfig('who'));
          return { outcome, live, role: rust.ownerRole };
        } finally {
          gated.release();
          await rust.disconnect();
          first.child.kill('SIGKILL');
          rmSync(dir, { recursive: true, force: true });
        }
      }
      const untilOpening = async (gated: ReturnType<typeof gatedAddon>) => { await waitFor(() => gated.opened.n === 1, { timeoutMs: 10_000 }); };

      test('the call that starts the takeover, cancelled while the store opens: ends cancelled at once and nothing is written', async () => {
        const written: string[] = [];
        const result = await heldTakeover(async (rust, gated) => {
          const controller = new AbortController();
          const call = withRequestSignal(controller.signal, () => (rust as unknown as BrainEngine).setConfig('k', 'v'));
          await untilOpening(gated);
          controller.abort();
          return whileHeld(call);
        }, written);
        expect(result).toEqual({ outcome: 'cancelled/', live: 'this-process', role: 'owner' });
        expect(written).toEqual([]);
      }, 60_000);

      test('the call that starts the takeover, past its deadline while the store opens: ends timeout not_sent at once and nothing is written', async () => {
        const written: string[] = [];
        const result = await heldTakeover(async (rust, gated) => {
          const call = withReadDeadline(Date.now() + 300, () => (rust as unknown as BrainEngine).setConfig('k', 'v'));
          await untilOpening(gated);
          return whileHeld(call);
        }, written);
        expect(result).toEqual({ outcome: 'timeout/not_sent', live: 'this-process', role: 'owner' });
        expect(written).toEqual([]);
      }, 60_000);

      test('a whole operation that starts the takeover, cancelled while the store opens: ends cancelled at once', async () => {
        const result = await heldTakeover(async (rust, gated) => {
          const controller = new AbortController();
          const call = withRequestSignal(controller.signal, () => forwardWholeOperation(rust, 'importFromContent', ['x', 'y'])!);
          await untilOpening(gated);
          controller.abort();
          return whileHeld(call);
        }, []);
        expect(result).toEqual({ outcome: 'cancelled/', live: 'this-process', role: 'owner' });
      }, 60_000);

      test('a whole operation that starts the takeover, past its deadline while the store opens: ends timeout not_sent at once', async () => {
        const result = await heldTakeover(async (rust, gated) => {
          const call = withReadDeadline(Date.now() + 300, () => forwardWholeOperation(rust, 'importFromContent', ['x', 'y'])!);
          await untilOpening(gated);
          return whileHeld(call);
        }, []);
        expect(result).toEqual({ outcome: 'timeout/not_sent', live: 'this-process', role: 'owner' });
      }, 60_000);

      test('a second call made while the store opens, cancelled: ends cancelled at once and nothing is written', async () => {
        const written: string[] = [];
        const result = await heldTakeover(async (rust, gated) => {
          const brain = rust as unknown as BrainEngine;
          void settle(brain.getConfig('who'));
          await untilOpening(gated);
          expect(rust.ownerRole).toBe('owner');
          const controller = new AbortController();
          const call = withRequestSignal(controller.signal, () => brain.setConfig('k', 'v'));
          await Bun.sleep(20);
          controller.abort();
          return whileHeld(call);
        }, written);
        expect(result).toEqual({ outcome: 'cancelled/', live: 'this-process', role: 'owner' });
        expect(written).toEqual([]);
      }, 60_000);

      test('a second call made while the store opens, past its deadline: ends timeout not_sent at once and nothing is written', async () => {
        const written: string[] = [];
        const result = await heldTakeover(async (rust, gated) => {
          const brain = rust as unknown as BrainEngine;
          void settle(brain.getConfig('who'));
          await untilOpening(gated);
          return whileHeld(withReadDeadline(Date.now() + 300, () => brain.setConfig('k', 'v')));
        }, written);
        expect(result).toEqual({ outcome: 'timeout/not_sent', live: 'this-process', role: 'owner' });
        expect(written).toEqual([]);
      }, 60_000);
    });

    // Value: protects=a whole operation whose takeover fails because the store will not open ends with that permanent error, not a retryable not_sent; fails_when=the whole-operation path swallows every election error and reports owner_unavailable not_sent, so the caller retries a store that cannot open; why_new=the ordinary-member path rethrew election errors, the whole-operation path did not and no test covered it; seam=none; no_claim=which store faults map to rust_store_unreadable (store-errors tests)
    test('a whole operation whose takeover finds the store unreadable ends rust_store_unreadable, not retryable', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-unreadable-'));
      const db = join(dir, 'brain.rust');
      const first = await ownerChild(db);
      const addon = { target: 'linux-x64-glibc', engine_abi: 1, Pool: class { async shutdown() {} },
        Brain: class extends ConfigBrain { async open() { throw Object.assign(new Error('bad record'), { code: 'store_corrupt' }); } } } as never;
      const rust = openRustEngine({ addon, databasePath: db, ownerWaitMs: 5_000 });
      try {
        await rust.connect({});
        await afterOwnerDeath(first, rust);
        const error = (await forwardWholeOperation(rust, 'importFromContent', ['x', 'y'])!.then(() => null, e => e)) as OperationError;
        expect({ code: error.code, reason: error.reason, retryable: error.retryable ?? false })
          .toEqual({ code: 'rust_store_unreadable', reason: 'store_corrupt', retryable: false });
      } finally {
        await rust.disconnect();
        first.child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    // Value: protects=a takeover that a remote job's call starts does not hand that job's authority to the owner server, so later local callers of the owner are not refused as remote; fails_when=the election and the owner server run in the caller's async context, so every served call carries the remote job's submission authority; why_new=every takeover test above started from a call with no authority; seam=a stub store, so the local importManagedFiles is checked only to get past the trusted-CLI gate, not to import; no_claim=a real managed import through the new owner
    test('a takeover started by a remote job\'s call: the owner serves later callers with no authority, and a local managed import is not refused', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-detached-'));
      const db = join(dir, 'brain.rust');
      const first = await ownerChild(db);
      const addon = { target: 'linux-x64-glibc', engine_abi: 1, Pool: class { async shutdown() {} },
        Brain: class extends ConfigBrain { async getConfig(key: string) { return key === 'authority' ? JSON.stringify(currentSubmissionAuthority() ?? null) : super.getConfig(key); } } } as never;
      const rust = openRustEngine({ addon, databasePath: db, ownerWaitMs: 5_000 });
      try {
        await rust.connect({});
        await afterOwnerDeath(first, rust);
        const remoteJob = { version: 1, kind: 'remote_generic' } as unknown as SubmissionAuthority;
        expect(await withSubmissionAuthority(remoteJob, () => (rust as unknown as BrainEngine).getConfig('who'))).toBe('this-process');
        expect(rust.ownerRole).toBe('owner');
        const { engine, close } = await clientOf(ownerSocketPath(db));
        try {
          expect(await engine.getConfig('authority')).toBe('null');
          const managed = await forwardWholeOperation(engine, 'importManagedFiles', [[], {}])!.then(() => 'ran', (error: OperationError) => `${error.code}/${error.reason ?? ''}`);
          expect(managed).not.toBe('permission_denied/trusted_cli_required');
        } finally { close(); }
      } finally {
        await rust.disconnect();
        first.child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    // Value: protects=the first ordinary call after owner death reaches a new owner in another process on a fresh connection; fails_when=it ends owner_unavailable or runs locally; why_new=failover tests began with a whole op, never an ordinary call, for a new owner elsewhere; seam=none; no_claim=takeover
    test('a first ordinary call after the owner dies goes to the new owner on a new connection, without opening this store', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-first-handoff-'));
      const db = join(dir, 'brain.rust');
      const first = await ownerChild(db);
      let second: Awaited<ReturnType<typeof ownerChild>> | undefined;
      const opened = { n: 0 };
      const rust = openRustEngine({ addon: countedAddon(opened), databasePath: db, ownerWaitMs: 5_000 });
      try {
        await rust.connect({});
        const old = await afterOwnerDeath(first, rust);
        second = await ownerChild(db);
        const brain = rust as unknown as BrainEngine;
        expect(await Promise.all([brain.getConfig('who'), brain.getConfig('who')].map(settle))).toEqual([null, null]);
        const now = ownerConnectionFor(rust);
        expect(now).toBeDefined();
        expect(now).not.toBe(old);
        expect(now!.closed).toBe(false);
        expect(now!.hello.pid).toBe(second.pid);
        expect(rust.ownerRole).toBe('client');
        expect(opened.n).toBe(0);
      } finally {
        await rust.disconnect();
        first.child.kill('SIGKILL');
        second?.child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  });
});

describe('a CLI write on a Rust brain whose owner is gbrain serve', () => {
  const BRAIN = '10000000-0000-4000-8000-0000000000aa';
  let owner: PGLiteEngine;
  beforeAll(async () => { owner = new PGLiteEngine(); await owner.connect({}); }, 120_000);
  afterAll(async () => { await owner?.disconnect(); });

  test('with no owner, or an owner that is not a serve, the engine path runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-cli-'));
    const db = join(dir, 'brain.rust');
    mkdirSync(db, { recursive: true });
    const config = { engine: 'rust', database_path: db } as never;
    const folder = join(dir, '.gbrain', 'persistence');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${BRAIN}.cli.json`), JSON.stringify({ id: BRAIN, credential: 'a'.repeat(64), lane: 'cli' }), { mode: 0o600 });
    let ownerServer: Awaited<ReturnType<typeof serveOwnerEngine>> = null;
    try {
      await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host' }, async () => {
        const params = () => ({ slug: 'notes/a', content: 'body' });
        // No owner: the caller opens the brain itself.
        expect(await maybeDelegateLocalOperation('put_page', params(), config, { brain: 'host', cwd: dir })).toEqual({ handled: false });
        // An owner that is not a serve: the engine path runs and reaches it as a client (whole-op forward).
        ownerServer = await serveOwnerEngine(owner, ownerSocketPath(db), { serve: false });
        expect(await maybeDelegateLocalOperation('put_page', params(), config, { brain: 'host', cwd: dir })).toEqual({ handled: false });
        // A serve owner's persistence socket runs the real Rust journal: 'with a real Rust serve owner on the real write
        // journal' below, which replaced a stand-in dispatch that answered success without a journal.
      });
    } finally {
      await (ownerServer as { close(): Promise<void> } | null)?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a Rust owner whose engine does not report persistence_journal', () => {
  // The Rust engine shell is the owner: kind 'rust', with the journal taken off (withoutJournal), as an older Rust owner is.
  const addon = { target: 'linux-x64-glibc', engine_abi: 1 } as never;
  let dir: string;
  let db: string;
  let config: never;
  let rust: RustEngine;
  let ownerServer: NonNullable<Awaited<ReturnType<typeof serveOwnerEngine>>>;
  let asked = 0;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-rust-'));
    db = join(dir, 'brain.rust');
    mkdirSync(db, { recursive: true });
    config = { engine: 'rust', database_path: db } as never;
    mkdirSync(join(dir, '.gbrain'), { recursive: true });
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(config));
    rust = withoutJournal(openRustEngine({ addon, databasePath: db }));
    expect(rust.capabilities.has('persistence_journal')).toBe(false);
    // Count every member the owner is asked to run, so a refusal made at the client is proven to send nothing.
    for (const member of ['executeRaw', 'getPage', 'putPage', 'transaction', 'searchKeyword']) {
      const refuse = (RustEngine.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[member]!;
      Object.defineProperty(rust, member, { configurable: true, writable: true, value: (...a: unknown[]) => { asked++; return refuse.apply(rust, a); } });
    }
    const served = await serveOwnerEngine(rust as unknown as BrainEngine, ownerSocketPath(db), { serve: true,
      wholeOperations: countedWholeOperations(ownerWholeOperations() as never, () => { asked++; }) });
    if (!served) throw new Error('no socket');
    ownerServer = served;
  });

  afterAll(async () => {
    await ownerServer?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a serve on that engine starts no persistence listener', async () => {
    await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const provider = { brainId: '10000000-0000-4000-8000-0000000000bb', dispatch: async () => ({}) } as never;
      const binding = await bindResolveIpcForServe(rust as unknown as BrainEngine, 'default', provider);
      try {
        expect(binding.persistence ?? null).toBeNull();
        expect(existsSync(persistenceSocketPathForConfig(config)!)).toBe(false);
      } finally { binding.close(); }
    });
  });

  test('a CLI put_page is not sent to the persistence socket; it takes the engine path', async () => {
    await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host' }, async () => {
      const started = Date.now();
      expect(await maybeDelegateLocalOperation('put_page', { slug: 'notes/a', content: 'body' }, config, { brain: 'host', cwd: dir }))
        .toEqual({ handled: false });
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  test('a client gets the in-process refusal byte for byte, at once, and the owner is never asked', async () => {
    const { engine, close } = await clientOf(ownerSocketPath(db));
    try {
      const calls: Array<[string, (e: BrainEngine) => Promise<unknown>]> = [
        ['executeRaw', e => e.executeRaw('SELECT 1')],
        // transaction is served in process now; a client refuses it with the owner-socket refusal (tested above).
        // A member the Rust store does not serve (capability facts): listUnarchivedSourceRows, the source ids the claim-conflict
        // scan walks. The earlier examples are served now: listFactsReconcileBacklog (main join da99c637a7), lockOAuthClient (the
        // cli-members line) and, in batch 14, readFactTableCatalog (lane 4 sweep-facts-rust cd03205999, rust-5a 5ad596fad1).
        ['listUnarchivedSourceRows', e => e.listUnarchivedSourceRows()],
      ];
      for (const [member, call] of calls) {
        expect(member in STORE_MEMBERS).toBe(false);
        const started = Date.now();
        const remote = await call(engine).then(() => null, e => e);
        expect(Date.now() - started).toBeLessThan(500);
        const local = await (RustEngine.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[member]!.call(rust).then(() => null, e => e);
        expect((remote as OperationError).code).toBe('engine_capability_missing');
        expect(JSON.stringify(errorShape(remote))).toBe(JSON.stringify(errorShape(local)));
      }
      expect((await engine.executeRaw('SELECT 1').then(() => null, e => e) as OperationError).reason).toBe('raw_sql');
      expect(asked).toBe(0);
      expect(ownerServer.stats()).toMatchObject({ active: 0, queued: 0 });
    } finally { close(); }
  });

  test('put_page and an import are not sent whole: the client refuses persistence_journal at once and the owner runs nothing', async () => {
    const { engine, close } = await clientOf(ownerSocketPath(db));
    try {
      const before = asked;
      const { operationsByName } = await import('../src/core/operations.ts');
      const { importFromContent } = await import('../src/core/import-file.ts');
      const writes: Array<() => Promise<unknown>> = [
        () => operationsByName.put_page!.handler(localCtx(engine), { slug: 'notes/whole', content: 'body' }),
        () => importFromContent(engine, 'notes/imported', '---\ntitle: I\n---\nbody\n'),
      ];
      for (const write of writes) {
        const started = Date.now();
        const error = await write().then(() => null, e => e) as OperationError;
        expect(Date.now() - started).toBeLessThan(500);
        expect(error?.code).toBe('engine_capability_missing');
        expect(error.reason).toBe('persistence_journal');
      }
      expect(asked).toBe(before);
      expect(ownerServer.stats()).toMatchObject({ active: 0, queued: 0 });
    } finally { close(); }
  });

  test('a member the Rust store serves is sent to the owner even when the rest of its capability is not reported', async () => {
    const { engine, close } = await clientOf(ownerSocketPath(db));
    try {
      const calls: Array<[string, (e: BrainEngine) => Promise<unknown>]> = [
        ['getPage', e => e.getPage('notes/a')],
        ['putPage', e => e.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'body' })],
        ['searchKeyword', e => e.searchKeyword('body', { limit: 5 })],
      ];
      const before = asked;
      for (const [member, call] of calls) {
        expect(member in STORE_MEMBERS).toBe(true);
        const remote = await call(engine).then(() => null, e => e);
        // The owner answers as it does in its own process: this owner was never connected, so it says engine_closed.
        const local = await (RustEngine.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[member]!.call(rust).then(() => null, e => e);
        expect((remote as OperationError).code).toBe('engine_closed');
        expect(JSON.stringify(errorShape(remote))).toBe(JSON.stringify(errorShape(local)));
      }
      expect(asked - before).toBe(calls.length);
    } finally { close(); }
  });
});

describe('gbrain CLI in a second process on a Rust brain', () => {
  const cliEnv = (home: string) => ({ ...process.env, GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_NO_BANNER: '1',
    GBRAIN_BACKUP_CHECK: '0', GBRAIN_SKIP_UPGRADE_CHECK: '1', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined });
  const cli = async (home: string, args: string[], extraEnv: Record<string, string> = {}) => {
    const started = Date.now();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], {
      cwd: home, env: { ...cliEnv(home), ...extraEnv }, stdout: 'pipe', stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code, output: stdout + stderr, ms: Date.now() - started };
    } finally { clearTimeout(timeout); }
  };
  const page = (title: string) => `---\ntitle: ${title}\ntype: note\n---\nWritten by a second process.\n`;
  const rustHome = (prefix: string) => {
    const home = mkdtempSync(join(tmpdir(), prefix));
    const db = join(home, 'brain.rust');
    mkdirSync(db, { recursive: true });
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const config = { engine: 'rust', database_path: db };
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
    return { home, db, config: config as never };
  };

  test('with no owner the CLI does not hang and does not wait on a lock; it ends with a typed error', async () => {
    const { home } = rustHome('gbrain-owner-ipc-cli-none-');
    try {
      const result = await cli(home, ['call', 'put_page', JSON.stringify({ slug: 'notes/none', content: page('None') })]);
      expect(result.code).not.toBe(0);
      expect(result.ms).toBeLessThan(30_000);
      expect(result.output).not.toMatch(/store_locked|pglite_busy|owner_unavailable/);
      expect(result.output).toMatch(/Error \[[a-z_]+\]/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 60_000);

  test('with a Rust serve owner that lacks persistence_journal the CLI takes the engine path at once and the owner runs nothing', async () => {
    const { home, db } = rustHome('gbrain-owner-ipc-cli-rust-');
    const rust = withoutJournal(openRustEngine({ addon: { target: 'linux-x64-glibc', engine_abi: 1 } as never, databasePath: db }));
    expect(rust.capabilities.has('persistence_journal')).toBe(false);
    const ownerServer = await serveOwnerEngine(rust as unknown as BrainEngine, ownerSocketPath(db), { serve: true, wholeOperations: ownerWholeOperations() });
    try {
      expect(ownerServer).not.toBeNull();
      const result = await cli(home, ['call', 'put_page', JSON.stringify({ slug: 'notes/rust', content: page('Rust') })]);
      expect(result.code).not.toBe(0);
      expect(result.ms).toBeLessThan(30_000);
      expect(result.output).not.toMatch(/store_locked|pglite_busy|owner_unavailable/);
      expect(ownerServer!.stats()).toMatchObject({ active: 0, queued: 0 });
    } finally {
      await ownerServer?.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  describe.skipIf(!HAVE_ADDON)('with a real Rust serve owner on the real write journal', () => {
    // The owner is a connected Rust engine that reports persistence_journal (store-capabilities.ts), serving the real
    // persistence provider; no PGLite stand-in.
    let served: ReturnType<typeof rustHome>;
    let owner: RustEngine;
    let binding: Awaited<ReturnType<typeof startPersistenceIpcServer>> = null;
    const dispatched: string[] = [];
    const refusals: Array<{ code: unknown; reason: unknown; sql: string }> = [];

    beforeAll(async () => {
      served = rustHome('gbrain-owner-ipc-cli-rust-journal-');
      const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: ADDON_BUILT } });
      owner = openRustEngine({ addon, databasePath: served.db });
      expect(owner.capabilities.has('persistence_journal')).toBe(true);
      const refuse = (RustEngine.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).executeRaw!;
      Object.defineProperty(owner, 'executeRaw', { configurable: true, writable: true, value(this: RustEngine, ...a: unknown[]) {
        return refuse.apply(this, a).catch((e: OperationError) => {
          // Only refusals inside a transaction: the owner's background writer loops ask for raw SQL outside one.
          if (this !== owner) refusals.push({ code: e?.code, reason: e?.reason, sql: String(a[0]).trim().split(/\s+/).slice(0, 3).join(' ') });
          throw e;
        });
      } });
      await withEnv({ GBRAIN_HOME: served.home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        // The election marks its owner a `gbrain serve` from argv (election.ts processIsServe), the mark the CLI checks
        // before it sends a write to the persistence socket. The argv is put back as soon as the owner is elected.
        const argv = process.argv;
        process.argv = [argv[0]!, argv[1]!, 'serve'];
        try { await owner.connect(served.config); } finally { process.argv = argv; }
        const provider = await createPersistenceIpcProvider(owner as unknown as BrainEngine, served.config);
        binding = await startPersistenceIpcServer(persistenceSocketPathForConfig(served.config)!, {
          ...provider, dispatch: request => { dispatched.push(request.operation); return provider.dispatch(request); },
        });
      });
    }, 120_000);

    afterAll(async () => {
      if (binding) { const b = binding as { server: import('node:net').Server; close(): void }; const closed = once(b.server, 'close'); b.close(); await closed; }
      if (owner) await disposePersistenceConsumer(owner as unknown as BrainEngine);
      await owner?.disconnect();
      rmSync(served.home, { recursive: true, force: true });
    }, 60_000);

    test('gbrain call put_page goes to the owner\'s persistence socket and commits on the real Rust journal', async () => {
      expect(binding).not.toBeNull();
      const result = await cli(served.home, ['call', 'put_page', JSON.stringify({ slug: 'notes/rust-journal', content: page('Rust journal') })],
        { GBRAIN_RUST_ENGINE_ADDON: ADDON_BUILT });
      // Exit 0: the write committed. Not exit 10 (still pending) and not a capability refusal.
      expect(result.code).toBe(0);
      expect(result.output).not.toContain('write_pending');
      expect(result.output).not.toContain('engine_capability_missing');
      expect(dispatched).toEqual(['put_page']);
      expect(refusals).toEqual([]);
      expect((await owner.getPage('notes/rust-journal'))?.title).toBe('Rust journal');
    }, 120_000);
  });

  describe('with a serve owner that reports persistence_journal', () => {
    // The owner hosts PGLite, which reports persistence_journal (a Rust owner that reports it is the describe above).
    let served: ReturnType<typeof rustHome>;
    let engine: PGLiteEngine;
    let binding: Awaited<ReturnType<typeof startPersistenceIpcServer>> = null;
    let ownerServer: Awaited<ReturnType<typeof serveOwnerEngine>> = null;

    beforeAll(async () => {
      served = rustHome('gbrain-owner-ipc-cli-serve-');
      engine = new PGLiteEngine();
      await withEnv({ GBRAIN_HOME: served.home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        await engine.connect({ database_path: join(served.home, 'owner.pglite') });
        await engine.initSchema();
        const provider = await createPersistenceIpcProvider(engine, served.config);
        await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') });
        ownerServer = await serveOwnerEngine(engine, ownerSocketPath(served.db), { serve: true, wholeOperations: ownerWholeOperations() });
        binding = await startPersistenceIpcServer(persistenceSocketPathForConfig(served.config)!, provider);
      });
    }, 120_000);

    afterAll(async () => {
      if (binding) { const b = binding as { server: import('node:net').Server; close(): void }; const closed = once(b.server, 'close'); b.close(); await closed; }
      await (ownerServer as { close(): Promise<void> } | null)?.close();
      await disposePersistenceConsumer(engine);
      await engine.disconnect();
      rmSync(served.home, { recursive: true, force: true });
    }, 60_000);

    test('gbrain call put_page commits through the owner', async () => {
      expect(binding).not.toBeNull();
      const result = await cli(served.home, ['call', 'put_page', JSON.stringify({ slug: 'notes/second', content: page('Second process') })]);
      expect(result.code).toBe(0);
      expect((await engine.getPage('notes/second'))?.title).toBe('Second process');
    }, 120_000);
  });
});

describe('owner socket file modes', () => {
  // The bind-to-chmod window on the socket file is closed by its parent: the owner sets the brain
  // directory to 0700 before it binds (prepareLocalIpcPath in src/core/context/ipc-path.ts), so no
  // other OS user can reach the socket while it still has the umask mode, and it is 0600 after listen.
  test.skipIf(process.platform === 'win32')(
    'the owner sets the brain directory to 0700 before it binds, and the socket to 0600 after listen',
    async () => {
      // A short POSIX root, not tmpdir(): a long TMPDIR would push the socket past the Unix path budget,
      // and the owner would use the private gbi-<uid>-<hash> fallback instead of the brain directory.
      const root = mkdtempSync('/tmp/gbrain-om-');
      const databasePath = join(root, 'brain.rust');
      mkdirSync(databasePath);
      chmodSync(databasePath, 0o755);
      const engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      const role = await electOwner(engine, databasePath, {});
      try {
        expect(role.role).toBe('owner');
        if (role.role !== 'owner') return;
        expect(role.server.socketPath).toBe(ownerSocketPath(databasePath));
        expect(statSync(databasePath).mode & 0o777).toBe(0o700);
        expect(statSync(role.server.socketPath).mode & 0o777).toBe(0o600);
      } finally {
        if (role.role === 'owner') { await role.server.close(); await role.lock.release(); }
        await engine.disconnect();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
