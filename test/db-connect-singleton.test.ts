/**
 * #1720 follow-up — db.connect() module-singleton lifecycle.
 *
 * Two bugs in the module-singleton create path, both surfaced in adversarial
 * review of the #1720 autopilot reconnect fix:
 *
 *  (A) Leak: `sql = postgres(url, opts)` was assigned before `await sql\`SELECT 1\``,
 *      and the catch nulled `sql` WITHOUT `await sql.end()` — orphaning a
 *      postgres.js client that holds a pooler client slot with no reference to
 *      close it.
 *  (B) Join-the-dead-client race: because the unvalidated `sql` was published
 *      before the probe, a concurrent connect() arriving mid-probe saw `sql`
 *      truthy and returned `false` (borrower) against a client that might be
 *      about to fail.
 *
 * Fix: an in-flight `connecting` promise. The singleton `sql` is published ONLY
 * after the SELECT 1 probe validates the client; concurrent callers await
 * `connecting` instead of the unvalidated `sql`. On failure the client is ended
 * and every waiter throws; on success exactly one caller (creator) gets `true`
 * and waiters get `false`. (#1471 ownership preserved.)
 *
 * Deterministic concurrency: a connect()'s synchronous prefix runs to its first
 * await before any microtask resolves, so two un-awaited connect() calls reliably
 * land one as creator and one as waiter. A gated probe lets us resolve/reject the
 * in-flight SELECT 1 on demand. Repo precedent: mock.module('postgres') (28 files).
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

let clientsCreated = 0;
let endCalls = 0;
let gate: { promise: Promise<unknown>; resolve: () => void; reject: (e: unknown) => void };

function freshGate() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = () => res([{ ok: 1 }]); // SELECT 1 result shape is irrelevant (setSessionDefaults is a no-op)
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeClient() {
  clientsCreated += 1;
  // Called as a tagged template (sql`SELECT 1`) → returns the current gate.
  const client = ((..._a: unknown[]) => gate.promise) as unknown as {
    (...a: unknown[]): Promise<unknown>;
    end: (o?: { timeout?: number }) => Promise<void>;
  };
  client.end = async () => { endCalls += 1; };
  return client;
}
const factory = ((..._a: unknown[]) => makeClient()) as unknown as { (...a: unknown[]): unknown; BigInt: unknown };
factory.BigInt = {};
mock.module('postgres', () => ({ default: factory }));

const db = await import('../src/core/db.ts');
const CFG = { database_url: 'postgresql://u:p@127.0.0.1:1/db' } as unknown as Parameters<typeof db.connect>[0];

beforeEach(async () => {
  try { await db.disconnect(); } catch { /* ignore */ }
  clientsCreated = 0;
  endCalls = 0;
  gate = freshGate();
});

describe('db.connect() singleton lifecycle (#1720 follow-up)', () => {
  test('(A) a failed probe ends the orphaned client once and leaves the singleton null', async () => {
    const p = db.connect(CFG);
    gate.reject(new Error('(EMAXCONNSESSION) max clients reached in session mode'));
    await expect(p).rejects.toThrow(/Cannot connect to database/);
    expect(endCalls).toBe(1);                 // half-open client ended, not orphaned
    expect(() => db.getConnection()).toThrow(); // singleton null
  });

  test('single successful connect creates the singleton and returns true', async () => {
    const p = db.connect(CFG);
    gate.resolve();
    await expect(p).resolves.toBe(true);
    expect(clientsCreated).toBe(1);
    expect(() => db.getConnection()).not.toThrow();
  });

  test('(B) two concurrent connects, in-flight SUCCESS: one creator (true), one borrower (false), single client', async () => {
    const p1 = db.connect(CFG);
    const p2 = db.connect(CFG); // arrives while p1's probe is pending → must await, not race a 2nd create
    gate.resolve();
    const results = await Promise.all([p1, p2]);
    expect(results.filter((r) => r === true).length).toBe(1);
    expect(results.filter((r) => r === false).length).toBe(1);
    expect(clientsCreated).toBe(1);                 // NO double-create
    expect(() => db.getConnection()).not.toThrow();
  });

  test('(B) two concurrent connects, in-flight FAILURE: both throw, single client created + ended once, singleton null', async () => {
    const p1 = db.connect(CFG);
    const p2 = db.connect(CFG);
    gate.reject(new Error('(EMAXCONNSESSION) max clients reached in session mode'));
    const settled = await Promise.allSettled([p1, p2]);
    expect(settled.every((s) => s.status === 'rejected')).toBe(true); // no waiter joins a dead client
    expect(clientsCreated).toBe(1);                 // no double-create
    expect(endCalls).toBe(1);                        // the one client ended once
    expect(() => db.getConnection()).toThrow();      // singleton null
  });

  test('(C) disconnect() during an in-flight connect() is NOT undone: the probe-completing connect aborts, no singleton published', async () => {
    const p = db.connect(CFG);        // in-flight; probe pending on the gate, sql still null
    await db.disconnect();            // races the in-flight connect → bumps epoch, tears nothing down
    gate.resolve();                   // probe now completes
    await expect(p).rejects.toThrow(); // creator observes the epoch change → aborts instead of publishing
    expect(() => db.getConnection()).toThrow(); // disconnect stands — no singleton resurrected
    expect(endCalls).toBe(1);          // the aborted client was ended (no leak)
  });

  test('a failed connect leaves a clean slate: a later connect() creates a fresh singleton', async () => {
    const fail = db.connect(CFG);
    gate.reject(new Error('boom'));
    await expect(fail).rejects.toThrow(/Cannot connect/);
    expect(() => db.getConnection()).toThrow();

    gate = freshGate(); // fresh in-flight probe for the retry
    const ok = db.connect(CFG);
    gate.resolve();
    await expect(ok).resolves.toBe(true);            // `connecting` was cleared → fresh creator
    expect(clientsCreated).toBe(2);                  // one client per attempt
    expect(() => db.getConnection()).not.toThrow();
  });
});
