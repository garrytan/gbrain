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
import { bindResolveIpcForServe } from '../src/mcp/resolve-ipc-binding.ts';
import { once } from 'node:events';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
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
    let finished = 0;
    // One permit and a member that takes 20 ms: the queue order decides who waits.
    const engine = {
      kind: 'fake', capabilities: new Set<string>(),
      getHealth: async () => { await Bun.sleep(20); return { finished: ++finished }; },
    } as unknown as BrainEngine;
    const served = await serveOwnerEngine(engine, join(dir, 'owner.sock'), { permits: 1 });
    if (!served) throw new Error('no socket');
    const flood = await clientOf(served.socketPath);
    const single = await clientOf(served.socketPath);
    try {
      const flooded = Array.from({ length: 20 }, () => flood.engine.getHealth());
      await Bun.sleep(30);
      expect(served.stats().queued).toBeGreaterThan(10);
      const mine = (await single.engine.getHealth()) as unknown as { finished: number };
      // Round-robin between connections: the single call runs right after the flood's running and next call, not
      // after all twenty.
      expect(mine.finished).toBeLessThanOrEqual(4);
      await Promise.all(flooded);
      expect(served.stats()).toMatchObject({ active: 0, queued: 0 });
    } finally {
      flood.close();
      single.close();
      await served.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
        // A member the Rust store does not serve (capability minion_queue); countOnboardSignal is served since alias-trust-2.
        ['lockOAuthClient', e => e.lockOAuthClient('client-a')],
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
