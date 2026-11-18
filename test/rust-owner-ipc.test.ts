/**
 * Rust engine owner IPC (src/core/rust-engine/owner-ipc/): a second process on a Rust brain becomes a client of the
 * owner process and sends its BrainEngine calls over the owner socket. The owner here hosts a PGLite engine, because
 * the Rust store is still being built; the server takes any BrainEngine.
 *
 * 1. Protects: two or more client processes read and write one brain through its owner; their results and errors are
 *    byte-identical to the same calls made in-process; calls end with `timeout` / `cancelled` within the caller's
 *    deadline or signal and never leak a permit; members outside the cut refuse at once; a dead owner gives
 *    `owner_unavailable`.
 * 2. Fails on: a codec that drops a type (Date, Float32Array, error codes), a server that frees a permit before the
 *    engine call settles, a client that hangs on an owner that died, or a route table that forwards transaction().
 * 3. Existing coverage: none; the owner socket is new. rust-engine-shell.test.ts covers only the lifecycle.
 * 4. Seam: none beyond the public `serveOwnerEngine` / `connectOwner` / `installOwnerClient` and the OpenRustEngine
 *    `ownerWaitMs` option the CLI path also reads.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { electOwner, type OwnerRole } from '../src/core/rust-engine/owner-ipc/election.ts';
import { ownerWholeOperations } from '../src/core/rust-engine/owner-ipc/owner-ops.ts';
import { connectOwner, installOwnerClient } from '../src/core/rust-engine/owner-ipc/client.ts';
import { serveOwnerEngine } from '../src/core/rust-engine/owner-ipc/server.ts';
import { ownerSocketPath } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { decodeValue, encodeValue } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { withReadDeadline } from '../src/core/read-deadline.ts';
import { requestSignal } from '../src/core/request-signal.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { maybeDelegateLocalOperation } from '../src/core/persistence/local-client.ts';
import { persistenceSocketPathForConfig, startPersistenceIpcServer, type PersistenceIpcRequest } from '../src/core/persistence/ipc.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
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
    expect(stats()).toEqual({ active: 0, queued: 0, connections: 0 });
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
      const calls = [0, 1, 2, 3].map(() => withReadDeadline(Date.now() + 300, () => engine.getHealth()).then(() => null, e => e));
      await Bun.sleep(100);
      expect(server.stats()).toMatchObject({ active: 2, queued: 2 });
      const errors = await Promise.all(calls);
      for (const error of errors) expect((error as OperationError).code).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await settled()).toMatchObject({ active: 0, queued: 0 });
      // The pool still serves: a fast call after the timeouts completes.
      expect(await engine.getPage('nothing-here')).toBeNull();
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

  test('put_page goes to the serve owner\'s persistence socket; with no serve owner the engine path runs', async () => {
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
