/**
 * Owner socket frame rules and far deadlines (src/core/rust-engine/owner-ipc/): both sides check the hello version, the
 * owner refuses a call before the hello, a reused in-flight id and arguments that are not a list, a client that cannot
 * read one answer fails only that call, and a deadline weeks away never ends a call at once.
 *
 * 1. Protects: a mismatched or missing hello never runs a call; a duplicate id never runs and never takes over the first
 *    call's cancel and close; non-list arguments never run as `[]`; one unreadable answer never throws out of the
 *    socket reader and never ends the other calls; a deadline over 2^31-1 ms from now waits for the call.
 * 2. Fails on: a server or client that ignores the hello version, a server that overwrites a running call with the
 *    same id or reads non-list arguments as none, a client whose result decode throws, or a setTimeout given a delay
 *    over 2^31-1 ms (it fires after 1 ms).
 * 3. Existing coverage: rust-owner-ipc.test.ts covers results, errors, deadlines that are near, cancel and owner exit;
 *    it never sends a bad hello, a duplicate id or non-list arguments, and never uses a far deadline.
 * 4. Seam: `setDeadlineTimer`'s `stepMs` option, so the re-arm is shown with a 20 ms step instead of 24.8 days.
 *    Everything else goes through the public `serveOwnerEngine` / `connectOwner` / `installOwnerClient` and raw frames.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectOwner, installOwnerClient } from '../src/core/rust-engine/owner-ipc/client.ts';
import { serveOwnerEngine } from '../src/core/rust-engine/owner-ipc/server.ts';
import { OWNER_IPC_VERSION } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { decodeError, decodeValue, encodeValue, type Wire } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { setDeadlineTimer } from '../src/core/rust-engine/owner-ipc/timer.ts';
import { prepareLocalIpcPath } from '../src/core/context/ipc-path.ts';
import { withReadDeadline } from '../src/core/read-deadline.ts';
import { requestSignal } from '../src/core/request-signal.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { CODES } from '../src/core/error-registry.ts';
import { rawSession } from './helpers/owner-ipc-raw.ts';

type Frame = Record<string, unknown>;

const errorOf = (frame: Frame | null) => decodeError(frame?.error as Wire) as OperationError;
const hello = (version = OWNER_IPC_VERSION) => ({ t: 'hello', version });

describe('frame rules on the owner', () => {
  let dir: string;
  let server: NonNullable<Awaited<ReturnType<typeof serveOwnerEngine>>>;
  const ran: string[] = [];
  let aborted = 0;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-frames-'));
    // A stand-in owner engine. getHealth runs until its request signal aborts; getConfig answers at once.
    const owner = {
      kind: 'pglite', capabilities: new Set<string>(),
      getHealth: () => {
        ran.push('getHealth');
        return new Promise((_resolve, reject) => {
          requestSignal()?.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true });
        });
      },
      getConfig: async (key: unknown) => { ran.push(`getConfig:${JSON.stringify(key)}`); return 'value'; },
    } as unknown as BrainEngine;
    const served = await serveOwnerEngine(owner, join(dir, 'owner.sock'));
    if (!served) throw new Error('no socket');
    server = served;
  });

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const idle = async () => {
    for (let i = 0; i < 100 && (server.stats().active > 0 || server.stats().queued > 0); i++) await Bun.sleep(10);
    return server.stats();
  };

  test('a hello of another version gets the owner hello, then the owner closes, and a call sent after it never runs', async () => {
    ran.length = 0;
    const raw = rawSession(server.socketPath);
    await raw.send(hello(OWNER_IPC_VERSION + 1));
    await raw.send({ t: 'call', id: 1, member: 'getConfig', args: encodeValue(['after-bad-hello']) });
    const answer = await raw.next(f => f.t === 'hello');
    expect(answer?.version).toBe(OWNER_IPC_VERSION);
    expect(await raw.closes()).toBe(true);
    expect(raw.frames.filter(f => f.t === 'result')).toEqual([]);
    expect(ran).toEqual([]);
  });

  // Value: protects=a version 1 client (whose decoder reads a segmented-body guard as a plain object) never talks to this owner, which sends guards; fails_when=OWNER_IPC_VERSION stays 1 while the guard tag crosses; why_new=the test above sends OWNER_IPC_VERSION + 1, which passes whatever the version is; seam=none; no_claim=a version 3 peer
  test('a version 1 client hello gets the version 2 owner hello, then the owner closes, and its call never runs', async () => {
    ran.length = 0;
    expect(OWNER_IPC_VERSION).toBe(2);
    const raw = rawSession(server.socketPath);
    await raw.send(hello(1));
    await raw.send({ t: 'call', id: 1, member: 'getConfig', args: encodeValue(['v1-client']) });
    const answer = await raw.next(f => f.t === 'hello');
    expect(answer?.version).toBe(2);
    expect(await raw.closes()).toBe(true);
    expect(raw.frames.filter(f => f.t === 'result')).toEqual([]);
    expect(ran).toEqual([]);
  });

  test('a call before the hello is refused with owner_ipc_protocol hello_missing and never runs', async () => {
    ran.length = 0;
    const raw = rawSession(server.socketPath);
    try {
      await raw.send({ t: 'call', id: 1, member: 'getConfig', args: encodeValue(['no-hello']) });
      const result = await raw.next(f => f.t === 'result');
      expect(result?.ok).toBe(false);
      expect({ code: errorOf(result).code, reason: errorOf(result).reason }).toEqual({ code: 'owner_ipc_protocol', reason: 'hello_missing' });
      expect(ran).toEqual([]);
    } finally { raw.destroy(); }
  });

  test('a call that reuses a running id is refused, the first keeps running, and a cancel of that id still ends the first', async () => {
    ran.length = 0;
    const before = aborted;
    const raw = rawSession(server.socketPath);
    try {
      await raw.send(hello());
      await raw.send({ t: 'call', id: 7, member: 'getHealth', args: encodeValue([]) });
      for (let i = 0; i < 100 && server.stats().active === 0; i++) await Bun.sleep(10);
      await raw.send({ t: 'call', id: 7, member: 'getConfig', args: encodeValue(['duplicate']) });
      const result = await raw.next(f => f.t === 'result');
      expect({ code: errorOf(result).code, reason: errorOf(result).reason }).toEqual({ code: 'owner_ipc_protocol', reason: 'duplicate_id' });
      expect(ran).toEqual(['getHealth']);
      expect(server.stats().active).toBe(1);
      await raw.send({ t: 'cancel', id: 7 });
      expect(await idle()).toMatchObject({ active: 0, queued: 0, inflightBytes: 0 });
      expect(aborted).toBe(before + 1);
    } finally { raw.destroy(); }
  });

  test('a duplicate id never takes the first call off the connection: closing it still aborts the first', async () => {
    const before = aborted;
    const raw = rawSession(server.socketPath);
    await raw.send(hello());
    await raw.send({ t: 'call', id: 3, member: 'getHealth', args: encodeValue([]) });
    for (let i = 0; i < 100 && server.stats().active === 0; i++) await Bun.sleep(10);
    await raw.send({ t: 'call', id: 3, member: 'getConfig', args: encodeValue(['duplicate']) });
    expect(await raw.next(f => f.t === 'result')).not.toBeNull();
    raw.destroy();
    expect(await idle()).toMatchObject({ active: 0, queued: 0, inflightBytes: 0 });
    expect(aborted).toBe(before + 1);
  });

  test.each([
    ['an object', encodeValue({ key: 'x' })],
    ['a string', encodeValue('x')],
    ['nothing', undefined],
  ])('arguments that are %s are refused with owner_ipc_protocol args_not_array and never run', async (_label, args) => {
    ran.length = 0;
    const raw = rawSession(server.socketPath);
    try {
      await raw.send(hello());
      await raw.send({ t: 'call', id: 1, member: 'getConfig', ...(args === undefined ? {} : { args }) });
      const result = await raw.next(f => f.t === 'result');
      expect({ code: errorOf(result).code, reason: errorOf(result).reason }).toEqual({ code: 'owner_ipc_protocol', reason: 'args_not_array' });
      expect(ran).toEqual([]);
    } finally { raw.destroy(); }
  });

  test('a call with list arguments after a matching hello still runs', async () => {
    ran.length = 0;
    const raw = rawSession(server.socketPath);
    try {
      await raw.send(hello());
      await raw.send({ t: 'call', id: 1, member: 'getConfig', args: encodeValue(['ok']) });
      const result = await raw.next(f => f.t === 'result');
      expect(result?.ok).toBe(true);
      expect(decodeValue(result?.value as Wire)).toBe('value');
      expect(ran).toEqual(['getConfig:"ok"']);
    } finally { raw.destroy(); }
  });
});

/** A raw owner: answers the hello with `helloFrame` and each call with `answer(frame)` after `delayMs`. */
async function rawOwner(dir: string, helloFrame: Frame, answer: (frame: Frame) => Frame, delayMs = 0) {
  const socketPath = prepareLocalIpcPath(join(dir, 'raw-owner.sock'), true);
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const frame = JSON.parse(line) as Frame;
        if (frame.t === 'hello') socket.write(JSON.stringify(helloFrame) + '\n');
        else if (frame.t === 'call') setTimeout(() => { if (!socket.destroyed) socket.write(JSON.stringify(answer(frame)) + '\n'); }, delayMs);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, () => resolve()));
  return {
    socketPath,
    close: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

const ownerHello = (version = OWNER_IPC_VERSION) => ({ t: 'hello', version, pid: process.pid, kind: 'pglite', capabilities: [], serve: false });

describe('frame rules on the client', () => {
  test('connectOwner refuses an owner hello of another version with owner_ipc_protocol version_mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-frames-c-'));
    const owner = await rawOwner(dir, ownerHello(OWNER_IPC_VERSION + 1), f => ({ t: 'result', id: f.id, ok: true, value: encodeValue(null) }));
    try {
      const outcome = await connectOwner(owner.socketPath).then(c => { c.close(); return null; }, e => e as OperationError);
      expect(outcome).toBeInstanceOf(OperationError);
      expect({ code: outcome?.code, reason: outcome?.reason }).toEqual({ code: 'owner_ipc_protocol', reason: 'version_mismatch' });
      expect(outcome?.detail).toContain(`client_version=${OWNER_IPC_VERSION}`);
      expect(outcome?.detail).toContain(`owner_version=${OWNER_IPC_VERSION + 1}`);
    } finally {
      await owner.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Value: protects=this client refuses a version 1 owner, whose answers it would read under the old rules; fails_when=OWNER_IPC_VERSION stays 1; why_new=the test above uses OWNER_IPC_VERSION + 1; seam=none; no_claim=a version 3 owner
  test('connectOwner refuses a version 1 owner with a clear owner_ipc_protocol version_mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-frames-v1-'));
    const owner = await rawOwner(dir, ownerHello(1), f => ({ t: 'result', id: f.id, ok: true, value: encodeValue(null) }));
    try {
      const outcome = await connectOwner(owner.socketPath).then(c => { c.close(); return null; }, e => e as OperationError);
      expect({ code: outcome?.code, reason: outcome?.reason }).toEqual({ code: 'owner_ipc_protocol', reason: 'version_mismatch' });
      expect(outcome?.detail).toContain('client_version=2');
      expect(outcome?.detail).toContain('owner_version=1');
    } finally {
      await owner.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Value: protects=a segmented-body guard is never read as a plain object: outside a guarded body field it fails the decode, and an unknown tag does too; fails_when=decodeTagged falls back to decodePlain for a tag it does not handle; why_new=the codec tests round-trip a guard only in a guarded field; seam=none; no_claim=which fields may carry a guard
  test('a guard outside a guarded body field, or an unknown tag, fails the decode instead of becoming a plain object', () => {
    for (const wire of [
      { $t: 'guard', site: 'getPage' },
      { notes: { $t: 'guard', site: 'getPage' } },
      [{ $t: 'guard', site: 'getPage' }],
      { $t: 'future-tag', v: 1 },
      { page: { $t: 'future-tag', v: 1 } },
    ] as Wire[]) {
      expect(() => decodeValue(wire)).toThrow(/owner socket/);
    }
    // A plain object whose own data has a `$t` key still crosses, wrapped as `obj`.
    expect(decodeValue(encodeValue({ $t: 'guard', site: 'getPage' }))).toEqual({ $t: 'guard', site: 'getPage' });
  });

  // Value: protects=a client fails only the call whose answer carries a misplaced guard, with result_undecodable, and never hands the caller a plain object for the page body; fails_when=the decoder falls back to a plain object; why_new=the result_undecodable test below uses a malformed frame, not a guard; seam=none; no_claim=a guard in a guarded field, which other tests cover
  test('an answer with a guard outside a guarded field fails that call with result_undecodable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-frames-g-'));
    const owner = await rawOwner(dir, ownerHello(), f => ({ t: 'result', id: f.id, ok: true, value: { slug: 'a', notes: { $t: 'guard', site: 'getPage' } } }));
    try {
      const connection = await connectOwner(owner.socketPath);
      try {
        const outcome = await connection.request('call', 'getPage', ['a']).then(() => null, e => e as OperationError);
        expect({ code: outcome?.code, reason: outcome?.reason }).toEqual({ code: 'owner_ipc_protocol', reason: 'result_undecodable' });
      } finally { connection.close(); }
    } finally {
      await owner.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Value: protects=a hello whose version or pid is an object ends connectOwner with owner_ipc_protocol, not an exception thrown out of the socket reader; fails_when=the detail text converts the field with String(); why_new=the version_mismatch test above sends a number; seam=none; no_claim=a hello of the right version
  test('an owner hello whose version or pid is an object is refused with owner_ipc_protocol version_mismatch, with no exception out of the reader', async () => {
    const hostile = { toString: null };
    for (const helloFrame of [{ ...ownerHello(), version: hostile }, { ...ownerHello(OWNER_IPC_VERSION + 1), pid: hostile }]) {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-frames-h-'));
      const owner = await rawOwner(dir, helloFrame as Frame, f => ({ t: 'result', id: f.id, ok: true, value: encodeValue(null) }));
      try {
        const outcome = await connectOwner(owner.socketPath, { timeoutMs: 1_000 }).then(c => { c.close(); return null; }, e => e as OperationError);
        expect(outcome).toBeInstanceOf(OperationError);
        expect({ code: outcome?.code, reason: outcome?.reason }).toEqual({ code: 'owner_ipc_protocol', reason: 'version_mismatch' });
        expect(outcome?.detail).toContain('=object');
      } finally {
        await owner.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // Value: protects=an answer whose id is an object is ignored and the connection and the next call go on; fails_when=the id is converted with Number() and throws out of the socket reader; why_new=every other answer here carries a number id; seam=none; no_claim=what becomes of the call that frame was meant for
  test('an answer frame whose id is an object is ignored: no exception out of the reader, the next call works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-frames-i-'));
    const owner = await rawOwner(dir, ownerHello(), f => f.id === 1
      ? { t: 'result', id: { toString: null }, ok: true, value: encodeValue('never') }
      : { t: 'result', id: f.id, ok: true, value: encodeValue('fine') });
    const connection = await connectOwner(owner.socketPath);
    const engine = { kind: 'rust', capabilities: new Set<string>() } as unknown as BrainEngine;
    const close = installOwnerClient(engine, connection);
    try {
      void engine.getConfig('a').catch(() => undefined);
      await Bun.sleep(100);
      expect(connection.closed).toBe(false);
      expect(await engine.getConfig('b')).toBe('fine');
    } finally {
      close();
      await owner.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an answer this process cannot read fails only that call with result_undecodable; the next call works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-frames-d-'));
    // The first call's answer holds a function tag, which a result decoder refuses; every later call gets a string.
    const owner = await rawOwner(dir, ownerHello(), f => f.id === 1
      ? { t: 'result', id: f.id, ok: true, value: { $t: 'fn', k: '0' } }
      : { t: 'result', id: f.id, ok: true, value: encodeValue('fine') });
    const connection = await connectOwner(owner.socketPath);
    const engine = { kind: 'rust', capabilities: new Set<string>() } as unknown as BrainEngine;
    const close = installOwnerClient(engine, connection);
    try {
      const first = await engine.getConfig('a').then(() => null, e => e as OperationError);
      expect({ code: first?.code, reason: first?.reason }).toEqual({ code: 'owner_ipc_protocol', reason: 'result_undecodable' });
      expect(first?.detail).toContain('member=getConfig');
      expect(connection.closed).toBe(false);
      expect(await engine.getConfig('b')).toBe('fine');
    } finally {
      close();
      await owner.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('deadlines over 2^31-1 ms', () => {
  const FAR = 2 ** 31 + 10_000;

  test('the owner waits for a call whose deadline is weeks away instead of ending it at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-far-'));
    const owner = {
      kind: 'pglite', capabilities: new Set<string>(),
      getConfig: async () => { await Bun.sleep(100); return 'slow value'; },
    } as unknown as BrainEngine;
    const server = await serveOwnerEngine(owner, join(dir, 'owner.sock'));
    if (!server) throw new Error('no socket');
    const raw = rawSession(server.socketPath);
    try {
      await raw.send(hello());
      await raw.send({ t: 'call', id: 1, member: 'getConfig', args: encodeValue(['k']), deadline_at: Date.now() + FAR });
      const result = await raw.next(f => f.t === 'result');
      expect(result?.ok === true ? decodeValue(result.value as Wire) : (errorOf(result).code ?? 'none')).toBe('slow value');
    } finally {
      raw.destroy();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the client waits for an answer whose deadline is weeks away instead of ending the call at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-far-c-'));
    // A raw owner that ignores deadlines, so only the client's own timer can end the call.
    const owner = await rawOwner(dir, ownerHello(), f => ({ t: 'result', id: f.id, ok: true, value: encodeValue('late value') }), 100);
    const connection = await connectOwner(owner.socketPath);
    const engine = { kind: 'rust', capabilities: new Set<string>() } as unknown as BrainEngine;
    const close = installOwnerClient(engine, connection);
    try {
      const outcome = await withReadDeadline(Date.now() + FAR, () => engine.getConfig('k')).then(v => v, e => (e as OperationError).code);
      expect(outcome).toBe('late value');
    } finally {
      close();
      await owner.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('setDeadlineTimer re-arms in steps and fires once, at the due time, not at the first step', async () => {
    const started = Date.now();
    const fired: number[] = [];
    setDeadlineTimer(() => fired.push(Date.now() - started), 120, { stepMs: 20 });
    await Bun.sleep(60);
    expect(fired).toEqual([]);
    await Bun.sleep(200);
    expect(fired).toHaveLength(1);
    expect(fired[0]!).toBeGreaterThanOrEqual(115);
  });

  test('a cleared timer never fires, even mid-step', async () => {
    let fired = false;
    const timer = setDeadlineTimer(() => { fired = true; }, 80, { stepMs: 20 });
    await Bun.sleep(30);
    timer.clear();
    await Bun.sleep(120);
    expect(fired).toBe(false);
  });
});

test('owner_ipc_protocol is registered with every reason the owner socket gives', () => {
  const rows = CODES as unknown as Record<string, { reasons?: readonly string[] }>;
  expect(rows.owner_ipc_protocol?.reasons).toEqual(['version_mismatch', 'hello_missing', 'duplicate_id', 'args_not_array', 'result_undecodable']);
});
