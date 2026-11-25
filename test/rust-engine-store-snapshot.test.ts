/**
 * The Rust store snapshot through the owner (src/core/rust-engine/store-snapshot.ts, rust/docs/store/snapshot.md): the
 * owner copies one committed generation while writers keep going, ends the copy when its caller is gone or the disk or
 * the clock says stop, and reports a terminal state only after the files are gone and the read is released.
 *
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes it an error).
 * Fails on: a copy that keeps writing after its caller was killed, a status that says terminal while the target still
 * exists, a second copy admitted while one runs, a copy that ignores the free-space reserve or the age budget, a remote
 * caller that reaches the copy (in process or over the socket), a copy that holds a later commit.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { forwardWholeOperation } from '../src/core/rust-engine/owner-ipc/whole-op.ts';
import { snapshotStatus, snapshotStore, type FsStats } from '../src/core/rust-engine/store-snapshot.ts';
import { verifyStoreDir } from '../src/core/rust-engine/store.ts';
import { withRemoteCaller } from '../src/core/remote-caller.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(what: string, ready: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
const reason = async (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(() => undefined, (error: OperationError) => error.reason);
const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(() => undefined, (error: OperationError) => error.code);

let addon: RustAddon;
let root: string;
let dir: string;
let owner: RustEngine;
let ids = 0;
const nextId = () => `t-${process.pid}-${++ids}`;
const plenty: FsStats = { bavail: 1_000_000_000, bsize: 4096, blocks: 2_000_000_000 };

(HAVE_ADDON ? describe : describe.skip)('the owner snapshot', () => {
  beforeAll(async () => {
    addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    root = mkdtempSync(join(tmpdir(), 'gbrain-snap-'));
    dir = join(root, 'brain');
    owner = openRustEngine({ addon, databasePath: dir });
    await owner.connect({ engine: 'pglite', database_path: dir } as never);
    for (let n = 0; n < 60; n++) {
      await owner.putPage(`notes/p${n}`, { type: 'note', title: `Page ${n}`, compiled_truth: `Body ${n} with words ${'filler '.repeat(40)}`, timeline: '' });
    }
  });
  afterAll(async () => {
    await owner?.disconnect().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  test('copies one generation while writes continue, and the copy verifies', async () => {
    const opId = nextId();
    const target = join(root, 'copy-writing');
    const copying = snapshotStore(owner, target, { opId, batchBytes: 4096, batchDelayMs: 40 }, { statfs: () => plenty });
    expect(snapshotStatus(opId).state).toBe('running');
    // The pin is taken once the copy has started its first batch; write after that.
    await until('the copy to start', () => existsSync(join(target, 'records.redb')));
    await sleep(100);
    await owner.putPage('notes/late', { type: 'note', title: 'Late', compiled_truth: 'written during the copy', timeline: '' });
    const done = await copying;
    expect(done.state).toBe('done');
    expect(done.free_bytes.initial).toBeGreaterThan(0);
    expect(snapshotStatus(opId)).toMatchObject({ state: 'done', manifest: { generation: done.manifest.generation } });
    const report = await verifyStoreDir(addon, target, done.manifest);
    expect(report.verdict).toBe('ok');
    expect(report.keyword_index?.state).toBe('complete');
    expect((await owner.getPage('notes/late'))?.title).toBe('Late');
    // The copy is the brain as of the pin: opened read-only on its own, it has no page written after it.
    const mirror = openRustEngine({ addon, databasePath: target });
    await mirror.connect({ engine: 'pglite', database_path: target } as never);
    try {
      expect((await mirror.getPage('notes/p0'))?.title).toBe('Page 0');
      expect(await mirror.getPage('notes/late')).toBeNull();
    } finally {
      await mirror.disconnect();
    }
  }, 30_000);

  test('a killed client stops the copy; the owner reports terminal only when the files are gone', async () => {
    const opId = nextId();
    const target = join(root, 'copy-killed');
    const client = Bun.spawn(['bun', 'run', join(import.meta.dir, 'helpers', 'rust-snapshot-client.ts'), BUILT, dir, target, opId, '100', '4096'], {
      cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe', env: { ...process.env },
    });
    try {
      await until('the copy to start on the owner', () => snapshotStatus(opId).state === 'running');
      // A second copy of the same brain is refused while the first runs.
      expect(await reason(snapshotStore(owner, join(root, 'copy-second'), { opId: nextId() }, { statfs: () => plenty }))).toBe('busy');
      expect(existsSync(join(root, 'copy-second'))).toBe(false);
      client.kill('SIGKILL');
      await client.exited;
      await until('a terminal state', () => snapshotStatus(opId).state !== 'running');
      expect(snapshotStatus(opId)).toMatchObject({ state: 'cancelled', reason: 'cancelled' });
      // Terminal means nothing is left and nothing is still writing.
      expect(existsSync(target)).toBe(false);
      await sleep(250);
      expect(existsSync(target)).toBe(false);
      // The owner took the next copy at once: the first one held nothing.
      const next = await snapshotStore(owner, join(root, 'copy-after-kill'), { opId: nextId() }, { statfs: () => plenty });
      expect(next.state).toBe('done');
    } finally {
      client.kill('SIGKILL');
    }
  }, 40_000);

  test('a cancelled call stops the copy and the status says why', async () => {
    const opId = nextId();
    const target = join(root, 'copy-aborted');
    const controller = new AbortController();
    const copying = withRequestSignal(controller.signal, () =>
      snapshotStore(owner, target, { opId, batchBytes: 4096, batchDelayMs: 100 }, { statfs: () => plenty }));
    await sleep(150);
    controller.abort();
    expect(await reason(copying)).toBe('cancelled');
    expect(existsSync(target)).toBe(false);
    expect(snapshotStatus(opId).state).toBe('cancelled');
  }, 30_000);

  test('disk pressure stops the copy, releases the brain and is recorded', async () => {
    const opId = nextId();
    const target = join(root, 'copy-pressure');
    let calls = 0;
    // Plenty of room at the start; the filesystem fills while the copy runs.
    const fills = (): FsStats => (++calls <= 2 ? plenty : { bavail: 1000, bsize: 4096, blocks: 2_000_000_000 });
    const copying = snapshotStore(owner, target, { opId, batchBytes: 4096, batchDelayMs: 100, pollMs: 50 }, { statfs: fills });
    await owner.putPage('notes/while-pressed', { type: 'note', title: 'Pressed', compiled_truth: 'writers keep going', timeline: '' });
    expect(await reason(copying)).toBe('disk_pressure');
    const status = snapshotStatus(opId);
    expect(status).toMatchObject({ state: 'cancelled', reason: 'disk_pressure' });
    expect(status.free_bytes!.low).toBeLessThan(status.free_bytes!.initial);
    expect(existsSync(target)).toBe(false);
    // The pin is gone: the brain takes writes and another copy.
    await owner.putPage('notes/after-pressure', { type: 'note', title: 'After', compiled_truth: 'ok', timeline: '' });
    expect((await snapshotStore(owner, join(root, 'copy-after-pressure'), { opId: nextId() }, { statfs: () => plenty })).state).toBe('done');
  }, 30_000);

  test('a start below the reserve is refused before anything is made, and an old copy is stopped', async () => {
    const low: FsStats = { bavail: 10, bsize: 4096, blocks: 2_000_000_000 };
    const refused = join(root, 'copy-low');
    expect(await reason(snapshotStore(owner, refused, { opId: nextId() }, { statfs: () => low }))).toBe('disk_pressure');
    expect(existsSync(refused)).toBe(false);
    const unreadable = await reason(snapshotStore(owner, refused, { opId: nextId() }, { statfs: () => { throw new Error('no statfs'); } }));
    expect(unreadable).toBe('disk_pressure');

    const opId = nextId();
    const old = join(root, 'copy-old');
    expect(await reason(snapshotStore(owner, old, { opId, batchBytes: 4096, batchDelayMs: 100, maxAgeMs: 150 }, { statfs: () => plenty }))).toBe('age_budget');
    expect(snapshotStatus(opId)).toMatchObject({ state: 'cancelled', reason: 'age_budget' });
    expect(existsSync(old)).toBe(false);
  }, 30_000);

  test('a remote caller is refused in process and over the owner socket, and nothing is made', async () => {
    const target = join(root, 'copy-remote');
    expect(await withRemoteCaller(true, () => codeOf(snapshotStore(owner, target, { opId: nextId() }, { statfs: () => plenty }))))
      .toBe('engine_capability_missing');
    expect(existsSync(target)).toBe(false);
    const client = openRustEngine({ addon, databasePath: dir });
    await client.connect({ engine: 'pglite', database_path: dir } as never);
    try {
      const sent = withRemoteCaller(true, () => forwardWholeOperation(client, 'snapshotStore', [target, { opId: nextId() }]));
      expect(sent).toBeDefined();
      expect(await codeOf(sent!)).toBe('engine_capability_missing');
      expect(existsSync(target)).toBe(false);
      // The same client, as the trusted local caller, is served; the status of an unknown id is unknown.
      const opId = nextId();
      const ok = await forwardWholeOperation<{ state: string }>(client, 'snapshotStore', [join(root, 'copy-client'), { opId }]);
      expect(ok?.state).toBe('done');
      expect((await forwardWholeOperation<{ state: string }>(client, 'snapshotStatus', [opId]))?.state).toBe('done');
      expect((await forwardWholeOperation<{ state: string }>(client, 'snapshotStatus', ['never-ran']))?.state).toBe('unknown');
    } finally {
      await client.disconnect();
    }
  }, 30_000);
  test('a disconnect during an in-process copy stops it and waits for the native call before the store closes', async () => {
    const lone = join(root, 'lone-brain');
    const engine = openRustEngine({ addon, databasePath: lone });
    await engine.connect({ engine: 'pglite', database_path: lone } as never);
    for (let n = 0; n < 40; n++) {
      await engine.putPage(`notes/q${n}`, { type: 'note', title: `Q ${n}`, compiled_truth: `Body ${n} ${'filler '.repeat(40)}`, timeline: '' });
    }
    const opId = nextId();
    const target = join(root, 'copy-disconnect');
    const copying = snapshotStore(engine, target, { opId, batchBytes: 4096, batchDelayMs: 100 }, { statfs: () => plenty });
    await until('the copy to start', () => existsSync(join(target, 'records.redb')));
    const outcome = reason(copying);
    await engine.disconnect();
    expect(await outcome).toBe('cancelled');
    // Terminal only after the native call returned: nothing is left and the status is final.
    expect(snapshotStatus(opId)).toMatchObject({ state: 'cancelled', reason: 'cancelled' });
    expect(existsSync(target)).toBe(false);
  }, 30_000);

  test('a copy that reaches an owner whose store is still opening waits for the store', async () => {
    let opened = false;
    const waiting = {
      openStore: () => { throw new Error('engine_closed: the store is not open yet'); },
      storeFor: async (member: string) => { await sleep(50); opened = true; return (owner as unknown as { openStore(m: string): unknown }).openStore(member); },
    };
    const done = await snapshotStore(waiting, join(root, 'copy-waiting'), { opId: nextId() }, { statfs: () => plenty });
    expect(opened).toBe(true);
    expect(done.state).toBe('done');
  }, 30_000);
  test('the default scratch target under the home folder is accepted, and a target directly in a world-writable directory is refused before anything is made', async () => {
    // The shape the shadow drill uses: <home>/.gbrain/shadow/<brain>/drills/<scratch>, every directory the user owns.
    const drills = join(root, 'home', '.gbrain', 'shadow', 'pglite-0123456789ab', 'drills');
    mkdirSync(drills, { recursive: true });
    expect((await snapshotStore(owner, join(drills, 'scratch-1'), { opId: nextId() }, { statfs: () => plenty })).state).toBe('done');
    if (process.platform === 'win32') return;
    // A directory every user may write to (sticky, mode 1777), made here: the suite does not assume what tmpdir() is.
    const shared = join(root, 'shared-dir');
    mkdirSync(shared);
    chmodSync(shared, 0o1777);
    const direct = join(shared, 'copy-direct');
    const refused = await snapshotStore(owner, direct, { opId: nextId() }, { statfs: () => plenty }).then(() => undefined, (error: Error) => error);
    expect(refused?.message).toMatch(/refusing snapshot:.*shared-dir.*world-writable/);
    expect(existsSync(direct)).toBe(false);
  }, 30_000);
  test('a copy asked for while the engine is disconnecting is refused before it starts, and the owner lock is not released under a copy', async () => {
    const lone = join(root, 'lone-brain-closing');
    const engine = openRustEngine({ addon, databasePath: lone });
    await engine.connect({ engine: 'pglite', database_path: lone } as never);
    for (let n = 0; n < 40; n++) {
      await engine.putPage(`notes/c${n}`, { type: 'note', title: `C ${n}`, compiled_truth: `Body ${n} ${'filler '.repeat(40)}`, timeline: '' });
    }
    const target = join(root, 'copy-closing');
    const closing = engine.disconnect();
    // Admitted in the same tick, after disconnect() captured its stop hooks: it would miss the barrier.
    const copying = snapshotStore(engine, target, { opId: nextId(), batchBytes: 4096, batchDelayMs: 100 }, { statfs: () => plenty });
    const outcome = reason(copying);
    await closing;
    expect(await outcome).toBe('cancelled');
    expect(existsSync(target)).toBe(false);
  }, 30_000);
});
