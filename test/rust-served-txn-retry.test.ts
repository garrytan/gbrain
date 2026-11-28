/**
 * A transaction over the wire that loses its commit to another writer (multi-user Rust, interface I-1; found by the
 * served arm against optimistic explicit transactions, access-policy.test.ts "two concurrent rule changes").
 *
 * With optimistic explicit transactions the server engine runs a transaction's callback again after a lost commit. Over
 * the wire that callback only waits for the client, so a second run committed nothing and reported success: the
 * client's writes were lost and both of two competing writers "won".
 *
 * 1. Protects: a lost commit is never answered as a success; the client runs its own callback again from a fresh
 *    transaction (as the in-process engine does), at most OPTIMISTIC_TRANSACTION_RETRIES more times, then ends
 *    `revision_conflict` reason `transaction_contention`.
 * 2. Fails on: a commit reply of success after the server's transaction committed nothing of the client's writes; a
 *    client callback that does not run again (after a lost commit, or after a call inside it the store refused
 *    `write_conflict`, as the in-process engine reruns it); endless reruns.
 * 3. Existing coverage: rust-served-wire.test.ts and rust-served-review.test.ts cover commit, rollback and deadlines
 *    against a fake that never conflicts.
 * 4. Seam: a fake engine whose `transaction` behaves as the optimistic engine does on a lost commit (it runs the
 *    callback again and commits only the last run's writes), on a real owner server and loopback listener.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine, TransactionOptions } from '../src/core/engine.ts';
import { serveOwnerEngine, type OwnerEngineServer } from '../src/core/rust-engine/owner-ipc/server.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { connectServedEngine } from '../src/core/rust-engine/served/engine.ts';
import { OWNER_TOKEN_IDS_CONFIG_KEY } from '../src/core/rust-engine/served/auth.ts';
import type { ServedServerOptions } from '../src/core/rust-engine/served/session.ts';
import { connectServed } from '../src/core/rust-engine/served/client.ts';
import { OPTIMISTIC_TRANSACTION_RETRIES, transactionRerunOf } from '../src/core/rust-engine/optimistic-transaction.ts';

const TOKEN = 'gbrain_txn_retry_owner_token';
const ownerInfo = { principal: { kind: 'legacy_token', id: 'tok-1' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null };

let dir: string;
let server: OwnerEngineServer;
let listener: ServedListener;
/** Commits the fake loses before it lets one through. */
let losses = 0;
/** Calls inside a transaction the fake fails with the store's write_conflict (a transaction it doomed) before one goes through. */
let doomed = 0;
const committed: string[] = [];
/** Per server transaction: the age and lost keys it started from (the rerun state the brain server carried in). */
const started: Array<{ age: number; keys: string[] }> = [];
let nextAge = 0;
/** Writes the fake took outside any transaction (a call on the engine itself, not on the transaction handle). */
const outside: string[] = [];

const fake = {
  kind: 'rust', capabilities: new Set<string>(['persistence_journal', 'transactions', 'multi_writer']),
  getConfig: async (key: string) => key === OWNER_TOKEN_IDS_CONFIG_KEY ? JSON.stringify(['tok-1']) : null,
  getPage: async (slug: unknown) => ({ slug }),
  logIngest: async (entry: { source_ref?: unknown }) => { outside.push(String(entry?.source_ref)); },
  // The optimistic engine on a lost commit: nothing of the run is kept, and the callback runs again (at most 8 more).
  transaction: async (fn: (tx: unknown) => Promise<unknown>, opts?: TransactionOptions) => {
    // As the optimistic engine does: start from the rerun state the server carries in, keep the first run's age.
    const rerun = transactionRerunOf(opts);
    started.push({ age: rerun.age.value ?? nextAge + 1, keys: [...rerun.keys].sort() });
    rerun.age.value ??= ++nextAge;
    for (let attempt = 1; ; attempt++) {
      const writes: string[] = [];
      const tx = { ...fake, putPage: async (slug: unknown) => {
        if (doomed > 0) { doomed--; throw Object.assign(new Error('write conflict on key 6d2a'), { code: 'write_conflict' }); }
        writes.push(String(slug)); return { slug };
      } };
      const value = await fn(tx);
      if (losses > 0) { losses--; rerun.keys.add(`6d2a${String(started.length).padStart(2, '0')}`); if (attempt > 8) throw Object.assign(new Error('contention'), { code: 'revision_conflict' }); continue; }
      committed.push(...writes);
      return value;
    }
  },
} as unknown as BrainEngine;

const servedOpts: ServedServerOptions = {
  verify: { verify: async (_engine, token) => { if (token === TOKEN) return { ...ownerInfo }; throw new Error('Invalid token'); } },
  transactions: () => true,
  log: () => {},
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-served-txn-retry-'));
  server = (await serveOwnerEngine(fake, join(dir, 'owner.sock'), { served: servedOpts }))!;
  listener = await listenServed(server, { host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await listener?.close();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const undo: Array<() => void> = [];
afterEach(() => { for (const u of undo.splice(0)) u(); losses = 0; doomed = 0; committed.length = 0; outside.length = 0; started.length = 0; });

async function servedEngine(): Promise<BrainEngine> {
  const engine = { kind: 'rust', capabilities: new Set<string>() };
  undo.push(await connectServedEngine(engine, { url: `gbrain+tcp://127.0.0.1:${listener.port}`, token: TOKEN }));
  return engine as unknown as BrainEngine;
}

describe('a transaction over the wire that loses its commit', () => {
  test('runs the client callback again and commits that run, never reporting a lost commit as success', async () => {
    const engine = await servedEngine();
    losses = 1;
    let runs = 0;
    const value = await engine.transaction(async tx => { runs++; await tx.putPage(`notes/run-${runs}`, {} as never); return runs; });
    expect({ runs, value, committed }).toEqual({ runs: 2, value: 2, committed: ['notes/run-2'] });
  });

  test('a call inside it that the store refuses write_conflict (a doomed transaction) runs the client callback again, as in process', async () => {
    const engine = await servedEngine();
    doomed = 1;
    let runs = 0;
    const value = await engine.transaction(async tx => { runs++; await tx.putPage(`notes/doomed-${runs}`, {} as never); return runs; });
    expect({ runs, value, committed }).toEqual({ runs: 2, value: 2, committed: ['notes/doomed-2'] });
  });

  test('a rerun after a doomed call repeats only the callback, exactly as in process: one outside write per run, one commit', async () => {
    // The in-process optimistic engine reruns the whole callback after a doomed call (optimistic-transaction.ts), so a
    // non-transactional call inside the callback runs once per run there too. Over the wire it must be no more than that.
    const engine = await servedEngine();
    doomed = 1;
    let runs = 0;
    await engine.transaction(async tx => {
      runs++;
      await engine.logIngest({ source_type: 'test', source_ref: `outside-${runs}`, pages_updated: [], summary: 'x' } as never);
      await tx.putPage(`notes/inside-${runs}`, {} as never);
    });
    expect({ runs, outside, committed }).toEqual({ runs: 2, outside: ['outside-1', 'outside-2'], committed: ['notes/inside-2'] });
  });

  test('past the retry limit it ends revision_conflict transaction_contention and nothing is kept', async () => {
    const engine = await servedEngine();
    losses = 100;
    let runs = 0;
    const error = await engine.transaction(async tx => { runs++; await tx.putPage('notes/never', {} as never); })
      .then(() => null, (e: unknown) => e as { code?: string; reason?: string });
    expect({ code: error?.code, reason: error?.reason }).toEqual({ code: 'revision_conflict', reason: 'transaction_contention' });
    expect(runs).toBe(9);
    expect(committed).toEqual([]);
  });
});

describe('a rerun over the wire keeps its place in line (known red 6: C11 served env starved one writer)', () => {
  test('each rerun starts from the first run\'s age and every key the runs before it lost on', async () => {
    const engine = await servedEngine();
    losses = 2;
    let runs = 0;
    await engine.transaction(async tx => { runs++; await tx.putPage(`notes/kept-${runs}`, {} as never); });
    expect(runs).toBe(3);
    expect(new Set(started.map(s => s.age)).size, 'a rerun started with a fresh age').toBe(1);
    expect(started.map(s => s.keys)).toEqual([[], ['6d2a01'], ['6d2a01', '6d2a02']]);
  });

  test('a fresh transaction, or one on another connection, never takes a lost run\'s place', async () => {
    const a = await servedEngine();
    const b = await servedEngine();
    losses = 1;
    await a.transaction(async tx => { await tx.putPage('notes/a', {} as never); });
    await b.transaction(async tx => { await tx.putPage('notes/b', {} as never); });
    await a.transaction(async tx => { await tx.putPage('notes/a2', {} as never); });
    expect(started.map(s => s.keys)).toEqual([[], ['6d2a01'], [], []]);
    expect(new Set(started.map(s => s.age)).size).toBe(3);
  });

  test('a client that keeps naming its lost run past the rerun bound starts fresh: no client stays the oldest writer forever', async () => {
    const connection = await connectServed(`gbrain+tcp://127.0.0.1:${listener.port}`, { token: TOKEN });
    try {
      let lost: string | undefined;
      for (let run = 1; run <= OPTIMISTIC_TRANSACTION_RETRIES + 2; run++) {
        losses = 1;
        const ref = String(await connection.txn('begin', lost ? { rerunOf: lost } : {}));
        const outcome = await connection.txn('commit', { txn: ref }).then(() => 'committed', (e: { reason?: string }) => e.reason);
        expect(outcome).toBe('transaction_conflict');
        lost = ref;
      }
      const ages = started.map(s => s.age);
      // Runs 1..9 share the first age (the first run and its 8 reruns); the 10th starts fresh.
      expect(new Set(ages.slice(0, OPTIMISTIC_TRANSACTION_RETRIES + 1)).size).toBe(1);
      expect(ages[OPTIMISTIC_TRANSACTION_RETRIES + 1]).not.toBe(ages[0]);
      expect(started[OPTIMISTIC_TRANSACTION_RETRIES + 1]!.keys).toEqual([]);
    } finally { connection.close(); }
  });
});
