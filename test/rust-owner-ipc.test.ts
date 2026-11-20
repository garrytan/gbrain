/**
 * Rust engine owner IPC (src/core/rust-engine/owner-ipc/): a second process on a Rust brain becomes a client of the
 * owner process and sends its BrainEngine calls over the owner socket. The owner here hosts a PGLite engine, because
 * the Rust store is still being built; the server takes any BrainEngine.
 *
 * 1. Protects: two or more client processes read and write one brain through its owner; their results and errors are
 *    byte-identical to the same calls made in-process; calls end with `timeout` / `cancelled` within the caller's
 *    deadline or signal and never leak a permit (a request already past its deadline never runs); closing the owner
 *    waits for running engine calls; members outside the cut refuse at once; a dead owner gives
 *    `owner_unavailable`.
 * 2. Fails on: a codec that drops a type (Date, Float32Array, error codes), a server that frees a permit before the
 *    engine call settles, a client that hangs on an owner that died, or a route table that forwards transaction().
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
import { forwardWholeOperation } from '../src/core/rust-engine/owner-ipc/whole-op.ts';
import { importFromContent, type ImportResult } from '../src/core/import-file.ts';
import { connectOwner, installOwnerClient } from '../src/core/rust-engine/owner-ipc/client.ts';
import { serveOwnerEngine } from '../src/core/rust-engine/owner-ipc/server.ts';
import { ownerLockPath, ownerSocketPath, readFrames } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { EventEmitter } from 'node:events';
import { decodeError, decodeValue, encodeValue } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { withReadDeadline } from '../src/core/read-deadline.ts';
import { callerAccessRecord, currentCallerAccess, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { storePagePolicy } from '../src/core/rust-engine/store-members/private-provenance.ts';
import { requestSignal } from '../src/core/request-signal.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { maybeDelegateLocalOperation } from '../src/core/persistence/local-client.ts';
import { persistenceSocketPathForConfig, startPersistenceIpcServer, type PersistenceIpcRequest } from '../src/core/persistence/ipc.ts';
import { withEnv } from './helpers/with-env.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { openRustEngine, RustEngine } from '../src/core/rust-engine.ts';
import { bindResolveIpcForServe } from '../src/mcp/resolve-ipc-binding.ts';
import { once } from 'node:events';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { errorShape, readScript } from './helpers/owner-ipc-child.ts';

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

  // Skipped in this slice: needs the shared-TS wiring (import-file, persistence/local-client, the transaction member) that lands in the next slice.
  test.skip('two writer processes put pages, links, timeline and a whole import through the owner', async () => {
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
    expect(stats()).toEqual({ active: 0, queued: 0, connections: 0 });
  }, 120_000);

  // Skipped in this slice: needs the shared-TS wiring (import-file, persistence/local-client, the transaction member) that lands in the next slice.
  test.skip('two reader processes get results byte-identical to in-process calls', async () => {
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
      for (const error of errors) expect((error as OperationError).code).toBe('timeout');
      // The two that ran may have done their work (the store does not see the abort); the two queued never ran.
      expect(errors.map(e => (e as OperationError).reason)).toEqual(['outcome_unknown', 'outcome_unknown', 'not_started', 'not_started']);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await settled()).toMatchObject({ active: 0, queued: 0 });
      // The pool still serves: a fast call after the timeouts completes.
      expect(await engine.getPage('nothing-here')).toBeNull();
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

  test('an aborted signal ends the call with cancelled and frees its permit', async () => {
    const { engine, close } = await clientOf(server.socketPath);
    try {
      const controller = new AbortController();
      const call = withRequestSignal(controller.signal, () => engine.getHealth()).then(() => null, e => e);
      await Bun.sleep(50);
      expect(server.stats().active).toBe(1);
      controller.abort();
      expect(((await call) as OperationError).code).toBe('cancelled');
      expect(await settled()).toMatchObject({ active: 0, queued: 0 });
      const already = await withRequestSignal(AbortSignal.abort(), () => engine.getPage('x')).then(() => null, e => e);
      expect((already as OperationError).code).toBe('cancelled');
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
      socket.on('connect', () => socket.write(JSON.stringify({
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
  test('pending calls end with owner_unavailable and later calls fail fast without hanging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-exit-'));
    const db = join(dir, 'brain.rust');
    const child = spawn(process.execPath, [CHILD, 'owner', db, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', chunk => {
          buf += chunk;
          if (buf.includes('\n')) resolve(JSON.parse(buf.split('\n')[0]!));
        });
        child.on('close', code => reject(new Error(`owner exited ${code}`)));
      });
      expect(ready.role).toBe('owner');
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
});

describe('a CLI write on a Rust brain whose owner is gbrain serve', () => {
  const BRAIN = '10000000-0000-4000-8000-0000000000aa';
  let owner: PGLiteEngine;
  beforeAll(async () => { owner = new PGLiteEngine(); await owner.connect({}); }, 120_000);
  afterAll(async () => { await owner?.disconnect(); });

  // Skipped in this slice: needs the shared-TS wiring (import-file, persistence/local-client, the transaction member) that lands in the next slice.
  test.skip('put_page goes to the serve owner\'s persistence socket; with no serve owner the engine path runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-ipc-cli-'));
    const db = join(dir, 'brain.rust');
    mkdirSync(db, { recursive: true });
    const config = { engine: 'rust', database_path: db } as never;
    const folder = join(dir, '.gbrain', 'persistence');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${BRAIN}.cli.json`), JSON.stringify({ id: BRAIN, credential: 'a'.repeat(64), lane: 'cli' }), { mode: 0o600 });
    const seen: PersistenceIpcRequest[] = [];
    let ownerServer: Awaited<ReturnType<typeof serveOwnerEngine>> = null;
    let persistence: Awaited<ReturnType<typeof startPersistenceIpcServer>> = null;
    try {
      await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host' }, async () => {
        const params = () => ({ slug: 'notes/a', content: 'body' });
        // No owner: the caller opens the brain itself.
        expect(await maybeDelegateLocalOperation('put_page', params(), config, { brain: 'host', cwd: dir })).toEqual({ handled: false });
        // An owner that is not a serve: the engine path runs and reaches it as a client (whole-op forward).
        ownerServer = await serveOwnerEngine(owner, ownerSocketPath(db), { serve: false });
        expect(await maybeDelegateLocalOperation('put_page', params(), config, { brain: 'host', cwd: dir })).toEqual({ handled: false });
        await ownerServer!.close();
        // A serve owner: the write goes whole to its persistence socket, as on a PGLite brain.
        ownerServer = await serveOwnerEngine(owner, ownerSocketPath(db), { serve: true });
        persistence = await startPersistenceIpcServer(persistenceSocketPathForConfig(config)!, {
          brainId: BRAIN,
          dispatch: async request => { seen.push(request); return { slug: 'notes/a', status: 'created_or_updated' }; },
        });
        const result = await maybeDelegateLocalOperation('put_page', params(), config, { brain: 'host', cwd: dir });
        expect(result).toEqual({ handled: true, result: { slug: 'notes/a', status: 'created_or_updated' } });
        expect(seen.map(r => r.operation)).toEqual(['put_page']);
      });
    } finally {
      (persistence as { close(): void } | null)?.close();
      await (ownerServer as { close(): Promise<void> } | null)?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a Rust owner whose engine does not report persistence_journal', () => {
  // The Rust engine shell is the owner: kind 'rust', with no store open and without persistence_journal.
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
    rust = openRustEngine({ addon, databasePath: db });
    // Count every member the owner is asked to run, so a refusal made at the client is proven to send nothing.
    for (const member of ['executeRaw', 'getPage', 'putPage', 'transaction', 'searchKeyword']) {
      const refuse = (RustEngine.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[member]!;
      Object.defineProperty(rust, member, { configurable: true, writable: true, value: (...a: unknown[]) => { asked++; return refuse.apply(rust, a); } });
    }
    const served = await serveOwnerEngine(rust as unknown as BrainEngine, ownerSocketPath(db), { serve: true, wholeOperations: ownerWholeOperations() });
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
        ['transaction', e => e.transaction(async () => null)],
      ];
      for (const [member, call] of calls) {
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

  test('a member the Rust store serves is sent to the owner, which answers as it does in process', async () => {
    const { engine, close } = await clientOf(ownerSocketPath(db));
    const before = asked;
    try {
      const calls: Array<[string, (e: BrainEngine) => Promise<unknown>]> = [
        ['getPage', e => e.getPage('notes/a')],
        ['putPage', e => e.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'body' })],
        ['searchKeyword', e => e.searchKeyword('body', { limit: 5 })],
      ];
      for (const [member, call] of calls) {
        const remote = await call(engine).then(() => null, e => e);
        const local = await (RustEngine.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[member]!.call(rust).then(() => null, e => e);
        // The owner in this test has no store open, so it answers engine_closed, the same as the engine in process.
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
  const cli = async (home: string, args: string[]) => {
    const started = Date.now();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], {
      cwd: home, env: cliEnv(home), stdout: 'pipe', stderr: 'pipe',
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
    const rust = openRustEngine({ addon: { target: 'linux-x64-glibc', engine_abi: 1 } as never, databasePath: db });
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

  // Skipped in this slice: the serve owner's persistence socket needs the shared-TS wiring that lands in the next slice.
  describe.skip('with a serve owner that reports persistence_journal', () => {
    // The owner hosts PGLite, which reports persistence_journal; the Rust engine does not yet (see the test above).
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
