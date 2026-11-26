/**
 * The owner of a Rust brain hands it to another process (multi-user Rust; the "processes" phase of the multi-writer
 * suite, where short `gbrain` processes come and go on one brain).
 *
 * Mode: the owner is a separate process (test/helpers/rust-owner-handoff-child.ts) that turns multi-user Rust on in its own
 * environment and reports its store's `multiuser`, asserted true; this process turns it on in-run
 * (GBRAIN_RUST_MULTIUSER=1 after the preload) and is the owner's client.
 *
 * 1. Protects: when the owner exits gracefully with writes of its clients queued or running, every write either runs
 *    there and is answered, or is refused as never run and is sent again to the next owner: none ends
 *    `owner_unavailable`, none is lost and none runs twice (each `logIngest` appends one row, so a second run shows as
 *    a second row); when the owner crashes, reads in flight are run again on the next owner, and a write whose outcome
 *    is unknown still ends `owner_unavailable` `outcome_unknown` (never run twice).
 * 2. Fails on: a queued write the old owner dropped without an answer, a running write whose answer was cut off, a
 *    write run twice, a read in flight lost at a crash.
 * 3. Existing coverage: rust-owner-ipc*.test.ts cover the owner socket and the next-call election, not calls in flight
 *    at a handoff.
 * 4. Seam: none below the engine: real owner process, real socket, real store. Needs the addon `bun run rust:build`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

interface Owner { child: ChildProcessWithoutNullStreams; ready: Record<string, unknown>; ran: string[]; exited: Promise<number | null> }

async function startOwner(dir: string): Promise<Owner> {
  const child = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'rust-owner-handoff-child.ts'), dir, rustArmAddonPath()], {
    env: { ...process.env, GBRAIN_RUST_MULTIUSER: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const ran: string[] = [];
  let buffer = '';
  const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the owner child did not get ready')), 60_000);
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.t === 'ready') { clearTimeout(timer); resolve(msg); }
          if (msg.t === 'ran') ran.push(String(msg.ref));
        } catch { /* a log line */ }
      }
    });
  });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  return { child, ready, ran, exited };
}

async function client(dir: string): Promise<RustEngine> {
  const addon = await loadRustArmAddon();
  const engine = openRustEngine({ addon, databasePath: dir });
  await engine.connect({ engine: 'rust', database_path: dir } as never);
  return engine;
}

const outcome = (p: Promise<unknown>) => p.then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, code: (e as { code?: string }).code, reason: (e as { reason?: string }).reason }));

describeAddon('a Rust owner hands its brain to the next process', () => {
  afterAll(async () => {
    for (const c of children) c.kill('SIGKILL');
    for (const d of dirs) { rmSync(d, { recursive: true, force: true }); rmSync(`${d}.gbrain-owner.lock`, { force: true }); }
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  test('a graceful owner exit with writes queued and running: every write is answered once, none lost, none twice', async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-handoff-'));
    dirs.push(dir);
    const owner = await startOwner(dir);
    expect(owner.ready).toMatchObject({ role: 'owner', multiuser: true, served: true });
    const engine = await client(dir);
    try {
      expect(engine.ownerRole).toBe('client');
      const refs = Array.from({ length: 40 }, (_, i) => `handoff-${i}`);
      const calls = refs.map(ref => outcome(engine.logIngest({ source_type: 'test', source_ref: ref, pages_updated: [], summary: ref })));
      await Bun.sleep(30);
      owner.child.stdin.write('exit\n');
      const results = await Promise.all(calls);
      expect(await owner.exited).toBe(0);
      expect(results.filter(r => !r.ok)).toEqual([]);
      // Some ran on the old owner before it exited, the rest after the handoff (so the handoff really happened).
      expect(owner.ran.length).toBeGreaterThan(0);
      expect(owner.ran.length).toBeLessThan(refs.length);
      const log = await engine.getIngestLog({ limit: 1000 });
      expect(engine.ownerRole).toBe('owner');
      expect(engine.openStore('handoff-check').multiuser).toBe(true);
      const counts = new Map<string, number>();
      for (const row of log) counts.set(row.source_ref, (counts.get(row.source_ref) ?? 0) + 1);
      expect(refs.filter(ref => counts.get(ref) !== 1)).toEqual([]);
    } finally { await engine.disconnect(); }
  }, 120_000);

  test('calls sent in the same tick the owner starts to exit: every one is answered once, none lost, none twice', async () => {
    // The owner here is an engine of this process, so its exit starts in the very tick the client's calls are written:
    // some reach the owner, some are still unread in the socket. An unread call never ran, so it must go to the next owner.
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    for (let round = 0; round < 5; round++) {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-same-tick-'));
      dirs.push(dir);
      const owner = await client(dir);
      const engine = await client(dir);
      try {
        expect({ owner: owner.ownerRole, client: engine.ownerRole, multiuser: owner.openStore('same-tick').multiuser })
          .toEqual({ owner: 'owner', client: 'client', multiuser: true });
        const refs = Array.from({ length: 48 }, (_, i) => `tick-${round}-${i}`);
        const calls = refs.map(ref => outcome(engine.logIngest({ source_type: 'test', source_ref: ref, pages_updated: [], summary: ref })));
        const exited = owner.disconnect();
        const results = await Promise.all(calls);
        await exited;
        expect({ round, failed: results.filter(r => !r.ok) }).toEqual({ round, failed: [] });
        expect(engine.ownerRole).toBe('owner');
        const counts = new Map<string, number>();
        for (const row of await engine.getIngestLog({ limit: 1000 })) counts.set(row.source_ref, (counts.get(row.source_ref) ?? 0) + 1);
        expect({ round, notOnce: refs.filter(ref => counts.get(ref) !== 1) }).toEqual({ round, notOnce: [] });
      } finally { await engine.disconnect(); await owner.disconnect().catch(() => undefined); }
    }
  }, 120_000);

  test('an owner crash: reads in flight run again on the next owner; a write of unknown outcome is never run twice', async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-crash-'));
    dirs.push(dir);
    const owner = await startOwner(dir);
    expect(owner.ready).toMatchObject({ role: 'owner', multiuser: true });
    const engine = await client(dir);
    try {
      await engine.logIngest({ source_type: 'test', source_ref: 'before-crash', pages_updated: [], summary: 'x' });
      const writes = Array.from({ length: 20 }, (_, i) => `crash-${i}`);
      const writeCalls = writes.map(ref => outcome(engine.logIngest({ source_type: 'test', source_ref: ref, pages_updated: [], summary: ref })));
      const reads = Array.from({ length: 20 }, () => outcome(engine.getIngestLog({ limit: 10 })));
      await Bun.sleep(15);
      owner.child.kill('SIGKILL');
      await owner.exited;
      expect((await Promise.all(reads)).filter(r => !r.ok)).toEqual([]);
      const writeResults = await Promise.all(writeCalls);
      // A write either finished, or ends owner_unavailable outcome_unknown (it may have run): never anything else.
      for (const r of writeResults) if (!r.ok) expect({ code: r.code, reason: r.reason }).toEqual({ code: 'owner_unavailable', reason: 'outcome_unknown' });
      const log = await engine.getIngestLog({ limit: 1000 });
      const counts = new Map<string, number>();
      for (const row of log) counts.set(row.source_ref, (counts.get(row.source_ref) ?? 0) + 1);
      expect(writes.filter(ref => (counts.get(ref) ?? 0) > 1)).toEqual([]);
      expect(engine.ownerRole).toBe('owner');
    } finally { await engine.disconnect(); }
  }, 120_000);
});

describe('a closing persistence owner hands a forwarded write over (multi-user mode only)', () => {
  test('the "persistence owner is closing" refusal becomes owner_handoff on a multi-user owner, and passes unchanged off', async () => {
    const { handedOverIfClosing } = await import('../src/core/rust-engine/owner-ipc/owner-ops.ts');
    const { OperationError } = await import('../src/core/ops/contract.ts');
    const { PERSISTENCE_CLOSING_MESSAGE } = await import('../src/core/persistence/service.ts');
    const closing = new OperationError('unavailable', `${PERSISTENCE_CLOSING_MESSAGE} Retry the same request_id after restart.`, 'x');
    const on = { openStoreIfOpen: () => ({ multiuser: true }) };
    const off = { openStoreIfOpen: () => ({ multiuser: false }) };
    expect(handedOverIfClosing(on as never, 'put_page', closing)).toMatchObject({ code: 'owner_unavailable', reason: 'owner_handoff' });
    expect(handedOverIfClosing(off as never, 'put_page', closing)).toBe(closing);
    const other = new OperationError('unavailable', 'Something else.', 'x');
    expect(handedOverIfClosing(on as never, 'put_page', other)).toBe(other);
  });
});
