/**
 * The served layer's replica-ack gate (src/core/rust-engine/served/replica-gate.ts; rust/docs/store/commit-log.md,
 * "Replica acks"): while a replica is attached, a successful write is answered as a success only once the replica's
 * ack covers the write's commit position.
 *
 * 1. Protects: no answer is a success before the store says an attached replica holds the write; every wait ends
 *    (ack, deadline, detach, shutdown) and never as a success without the ack; at most `max_waiters` answers wait, and
 *    `busy` refuses the next write before it runs; with no replica (or no commit log) every answer passes at once.
 * 2. Fails on: a success while the cover says not covered; a wait that outlives its deadline or a detach; a refused
 *    store read taken as success; a closed gate that admits again; a wait that holds the store read hot (polling).
 * 3. Existing coverage: the store's own cover and wait are rust/crates/gbrain-store/tests/replica_ack.rs; the served
 *    end to end is rust-served-replica-ack.serial.test.ts.
 * 4. Seam: a fake `openStoreIfOpen` store whose `replicaCover` / `replicaAckSettings` the test drives; no addon.
 */
import { describe, expect, test } from 'bun:test';
import { ReplicaGate, type ReplicaCoverWire, type ReplicaGateStore } from '../src/core/rust-engine/served/replica-gate.ts';

type Pos = { sequence: number; index: number };
const at = (sequence: number, index = 0): Pos => ({ sequence, index });

/** A store with one replica whose ack the test moves. */
function fakeStore(over: { timeoutMs?: number; maxWaiters?: number; required?: boolean; commitLog?: boolean } = {}) {
  const state = { required: over.required ?? true, acked: null as Pos | null, coverReads: 0, fail: false };
  const before = (a: Pos, b: Pos) => a.sequence < b.sequence || (a.sequence === b.sequence && a.index <= b.index);
  const store: ReplicaGateStore = {
    commitLog: over.commitLog ?? true,
    brain: {
      replicaCover: async (position: Pos): Promise<ReplicaCoverWire> => {
        state.coverReads++;
        if (state.fail) throw new Error('store refused');
        return { required: state.required, covered: state.required && state.acked !== null && before(position, state.acked), acked_through: state.acked };
      },
      replicaAckSettings: async () => ({ timeout_ms: over.timeoutMs ?? 5_000, max_waiters: over.maxWaiters ?? 64 }),
    },
  };
  return { store, state };
}

const settle = () => new Promise<void>(r => setTimeout(r, 5));

describe('replica-ack gate', () => {
  test('with no store, no commit log or no replica attached, an answer passes at once', async () => {
    expect(await new ReplicaGate(() => null).admit(at(3))).toBeNull();
    expect(await new ReplicaGate(() => fakeStore({ commitLog: false }).store).admit(at(3))).toBeNull();
    expect(await new ReplicaGate(() => fakeStore({ required: false }).store).admit(at(3))).toBeNull();
    expect(await new ReplicaGate(() => fakeStore({ required: false }).store).admit(null)).toBeNull();
  });

  test('a write the replica already holds passes; a required replica and no position is never a success', async () => {
    const { store, state } = fakeStore();
    state.acked = at(5, 2);
    const gate = new ReplicaGate(() => store);
    expect(await gate.admit(at(5, 2))).toBeNull();
    expect(await gate.admit(at(4))).toBeNull();
    expect(await gate.admit(null)).toMatchObject({ why: 'no_position', position: null, ackedThrough: at(5, 2) });
  });

  test('a wait ends with success only when an ack covers its position, and the wait does not poll the store', async () => {
    const { store, state } = fakeStore();
    const gate = new ReplicaGate(() => store);
    let answer: unknown = 'waiting';
    const waiting = gate.admit(at(7, 1)).then(r => { answer = r; });
    await settle();
    expect(gate.pending).toBe(1);
    const reads = state.coverReads;
    await Bun.sleep(60);
    expect(state.coverReads).toBe(reads); // no polling: only wake() reads again
    state.acked = at(7, 0); // short of the write
    gate.wake();
    await settle();
    expect(answer).toBe('waiting');
    state.acked = at(7, 1);
    gate.wake();
    await waiting;
    expect(answer).toBeNull();
    expect(gate.pending).toBe(0);
  });

  test('the deadline ends a wait replication_timeout with the newest ack the gate saw', async () => {
    const { store, state } = fakeStore({ timeoutMs: 40 });
    const gate = new ReplicaGate(() => store);
    const waiting = gate.admit(at(9));
    state.acked = at(8);
    gate.wake();
    expect(await waiting).toEqual({ position: at(9), timeoutMs: 40, ackedThrough: at(8), why: 'timeout' });
    expect(gate.pending).toBe(0);
  });

  test('a store that cannot say whether a replica must ack is never a success', async () => {
    const { store, state } = fakeStore();
    state.fail = true;
    expect(await new ReplicaGate(() => store).admit(at(2))).toMatchObject({ why: 'cover_failed' });
  });

  test('a detach of the last replica ends every wait without success', async () => {
    const { store, state } = fakeStore();
    const gate = new ReplicaGate(() => store);
    const waits = [gate.admit(at(3)), gate.admit(at(4))];
    await settle();
    state.required = false;
    gate.wake();
    expect((await Promise.all(waits)).map(r => r?.why)).toEqual(['detached', 'detached']);
  });

  test('max_waiters: busy refuses the next write before it runs, and a full budget found after a commit times out', async () => {
    const { store, state } = fakeStore({ maxWaiters: 2 });
    const gate = new ReplicaGate(() => store);
    expect(await gate.busy()).toBeNull(); // nothing waits: no store read at all
    expect(state.coverReads).toBe(0);
    const waits = [gate.admit(at(1)), gate.admit(at(2))];
    await settle();
    expect(await gate.busy()).toEqual({ maxWaiters: 2 });
    expect(await gate.admit(at(3))).toMatchObject({ why: 'budget' });
    // Busy holds only while a replica is attached.
    state.required = false;
    expect(await gate.busy()).toBeNull();
    state.required = true;
    state.acked = at(2);
    gate.wake();
    expect(await Promise.all(waits)).toEqual([null, null]);
    expect(await gate.busy()).toBeNull();
  });

  test('one ack ends 40 waits with one store read, and ones past it keep waiting', async () => {
    const { store, state } = fakeStore();
    const gate = new ReplicaGate(() => store);
    const ends: Array<unknown> = new Array(40).fill('waiting');
    const waits = Array.from({ length: 40 }, (_, i) => gate.admit(at(i + 1)).then(r => { ends[i] = r; }));
    await settle();
    expect(gate.pending).toBe(40);
    const reads = state.coverReads;
    state.acked = at(32);
    gate.wake();
    await settle();
    expect(state.coverReads - reads).toBe(1);
    expect(ends.slice(0, 32).every(e => e === null)).toBe(true);
    expect(ends.slice(32).every(e => e === 'waiting')).toBe(true);
    state.acked = at(40);
    gate.wake();
    await Promise.all(waits);
    expect(ends.every(e => e === null)).toBe(true);
  });

  test('wakes that arrive during a store read are not lost', async () => {
    const { store, state } = fakeStore();
    const gate = new ReplicaGate(() => store);
    const waiting = gate.admit(at(6));
    await settle();
    gate.wake(); // a read starts with acked = null
    state.acked = at(6);
    gate.wake(); // arrives while that read runs: must read once more
    expect(await waiting).toBeNull();
  });

  test('close ends every wait replication_timeout and later admits refuse at once', async () => {
    const { store } = fakeStore();
    const gate = new ReplicaGate(() => store);
    const waiting = gate.admit(at(2));
    await settle();
    gate.close();
    expect(await waiting).toMatchObject({ why: 'closed', position: at(2) });
    expect(await gate.admit(at(3))).toMatchObject({ why: 'closed' });
  });

  test('stored outcomes keep their write position off the wire', () => {
    const gate = new ReplicaGate(() => null);
    const write = { ok: true, value: null } as never;
    const read = { ok: true, value: null } as never;
    gate.remember(write, at(4, 1));
    expect(gate.recall(write)).toEqual({ write: true, position: at(4, 1) });
    expect(gate.recall(read)).toEqual({ write: false, position: null });
    expect(Object.keys(write)).toEqual(['ok', 'value']);
  });

  test('a caught-up send loop naps until the deadline or the next served commit', async () => {
    const gate = new ReplicaGate(() => null);
    const started = Date.now();
    await gate.nap(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    let woke = false;
    const nap = gate.nap(10_000).then(() => { woke = true; });
    await settle();
    expect(woke).toBe(false);
    gate.committed();
    await nap;
    expect(woke).toBe(true);
  });
});
