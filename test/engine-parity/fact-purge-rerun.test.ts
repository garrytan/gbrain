/**
 * BrainEngine parity — a whole `purge_fact` whose transaction runs again (src/core/facts/purge.ts
 * submitPurgeFactMutation), on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 * GBRAIN_TEST_RUST_ARM=1, multi-user with GBRAIN_TEST_RUST_MU_ARM). The two restore cases replay the mirror with raw
 * SQL (a PGLite or Postgres restore), so they declare `requires: 'raw_sql'` and the Rust arm refuses them by design.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the purge mirror (`<brain home>/purge-events.jsonl`, src/core/belief/purge-mirror.ts) gets its `intent`
 *    line inside the purge transaction, before the commit. When that transaction runs again (a multi-user Rust
 *    `write_conflict`, a Postgres serialization failure that retryWriteAdmission retries), the purge still commits
 *    once: the fact is gone, its tombstone refuses the claim, the request is committed, and the committed purge has
 *    exactly one intent line and one committed line in the mirror.
 *  - Probe: the run that did not commit leaves its own intent line (a different `request`, the same `request_id` and
 *    target). A later restore must read that line as covered by the committed sibling, not report the purge as
 *    `unverified` (a false doctor warning that asks the user to check a purge that is complete).
 *  - Seam: `forceRerun` replaces the engine's `transaction` for the purge call only. It lets the first run of the
 *    purge callback finish (the intent line is written), then makes that run lose: on a multi-user Rust engine it
 *    throws `write_conflict`, so the engine's own retry runs the callback again; on the other arms it rolls the run
 *    back and runs the callback again in a new transaction, as retryWriteAdmission does after a 40001.
 *    Generated values (ids, times) are compared by relation, never by value.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { onPurgeIntent, purgeMirrorPath, readPurgeMirror, replayPurgesInRestore, type PurgeMirrorIntent } from '../../src/core/belief/purge-mirror.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const CLAIM = 'Gate code is 7731';
const VISIBILITY = 'private';
const REQUEST = 'a0000000-0000-4000-8000-0000000000b2';
const ARCHIVED_AT = '2000-01-01T00:00:00.000Z';
const FORCED = 'forced rerun of the purge transaction (test seam)';
const purge = operations.find((o) => o.name === 'purge_fact')!;

const contextFor = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: SRC,
  logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;

/** Makes the first purge transaction (the one that calls insertFactPurge) lose once, after its callback finished. */
function forceRerun(engine: BrainEngine) {
  const seen = { forced: 0, runs: 0 };
  const multiuser = (engine as { multiuser?: boolean }).multiuser === true;
  let holder: object | null = engine;
  let found: PropertyDescriptor | undefined;
  while (holder && !(found = Object.getOwnPropertyDescriptor(holder, 'transaction'))) holder = Object.getPrototypeOf(holder);
  const original = found!.value as (...args: unknown[]) => Promise<unknown>;
  const run = async <T>(fn: (tx: BrainEngine) => Promise<T>, tx: BrainEngine) => {
    let purging = false;
    const watched = new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop !== 'insertFactPurge') return Reflect.get(target, prop, receiver);
        return (...args: unknown[]) => {
          if (!purging) seen.runs++;
          purging = true;
          return (target.insertFactPurge as (...a: unknown[]) => Promise<unknown>)(...args);
        };
      },
    });
    return { value: await fn(watched), purging };
  };
  const transaction = async function (this: unknown, fn: (tx: BrainEngine) => Promise<unknown>, ...rest: unknown[]) {
    const call = (cb: (tx: BrainEngine) => Promise<unknown>) => original.call(this, cb, ...rest);
    if (seen.forced > 0) return call(async tx => (await run(fn, tx)).value);
    let forcedHere = false;
    const once = async (tx: BrainEngine) => {
      const { value, purging } = await run(fn, tx);
      if (purging && seen.forced === 0) {
        seen.forced++;
        forcedHere = true;
        throw multiuser ? Object.assign(new Error(FORCED), { code: 'write_conflict' }) : new Error(FORCED);
      }
      return value;
    };
    if (multiuser) return call(once);
    try { return await call(once); }
    catch (error) { if (!forcedHere) throw error; return call(async tx => (await run(fn, tx)).value); }
  };
  const own = Object.getOwnPropertyDescriptor(engine, 'transaction');
  Object.defineProperty(engine, 'transaction', { value: transaction, configurable: true, writable: true });
  const restore = () => { if (own) Object.defineProperty(engine, 'transaction', own); else delete (engine as { transaction?: unknown }).transaction; };
  return { seen, restore };
}

/** Seeds one fact, dry-runs its purge, then commits the purge with one forced rerun of its transaction. */
async function purgeWithRerun(engine: BrainEngine) {
  await registerLocalWriter(engine, 'cli');
  const ctx = contextFor(engine);
  const seeded = await engine.insertFact({ fact: CLAIM, entity_slug: null, source: 'chat', visibility: VISIBILITY }, { source_id: SRC });
  const dry = await purge.handler(ctx, { id: seeded.id, dry_run: true }) as Record<string, unknown>;
  let fired = 0;
  const unsubscribe = onPurgeIntent(() => { fired++; });
  const { seen, restore: putBack } = forceRerun(engine);
  let outcome: Record<string, unknown>;
  try {
    outcome = await purge.handler(ctx, { id: seeded.id, confirm: dry.confirm_token, expected_revision: dry.expected_revision,
      request_id: REQUEST }) as Record<string, unknown>;
  } finally { putBack(); unsubscribe(); }
  expect([seen.forced, seen.runs]).toEqual([1, 2]);
  const lines = readPurgeMirror(purgeMirrorPath()) ?? [];
  const intents = lines.filter((l): l is PurgeMirrorIntent => l.kind === 'intent' && l.request_id === REQUEST);
  const committed = lines.filter(l => l.kind === 'committed').map(l => l.request);
  return { seeded, outcome, fired, lines, intents, committed };
}

const inHome = async <T>(fn: () => Promise<T>): Promise<T> => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-rerun-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); } finally { rmSync(home, { recursive: true, force: true }); }
};

describe('engine parity: a fact purge whose transaction runs again', () => {
  parityTest('a purge whose transaction runs twice commits once and leaves one intent and one committed line for the committed request', {
    methods: ['insertFact', 'insertFactPurge', 'isFactPurged', 'loadPurgeTarget'],
    timeout: 60_000,
  }, async (engine) => inHome(async () => {
    const { seeded, outcome, fired, intents, committed } = await purgeWithRerun(engine);
    const target = await engine.loadPurgeTarget(seeded.id, SRC);
    const result = {
      state: outcome.state,
      fact: target?.fact ?? null,
      purged: await engine.isFactPurged(SRC, VISIBILITY, CLAIM, null),
      committed_lines: committed.length,
      committed_with_one_intent: committed.map(r => intents.filter(i => i.request === r).length),
      // The run that did not commit leaves its own intent line: the mirror is a superset of committed purges.
      intents_without_committed_line: intents.filter(i => !committed.includes(i.request)).length,
      // Both runs name the same request_id, source, incarnation, scope, epoch and targets: only `request` and the time differ.
      runs_name_one_target: new Set(intents.map(({ request: _r, recorded_at: _t, ...target }) =>
        JSON.stringify(Object.keys(target).sort().map(k => [k, target[k as keyof typeof target]])))).size === 1,
      listeners_fired: fired,
    };
    expect(result).toEqual({ state: 'committed', fact: null, purged: true, committed_lines: 1, committed_with_one_intent: [1],
      intents_without_committed_line: 1, runs_name_one_target: true, listeners_fired: 2 });
    return result;
  }));

  // The restore replay is raw SQL (a PGLite or Postgres restore); the Rust arm refuses raw_sql by design.
  parityTest('a restore reads the intent line of the run that did not commit as covered by the committed run, not as unverified', {
    methods: ['insertFact', 'insertFactPurge', 'readPurgeReplaySchema'],
    requires: 'raw_sql',
    timeout: 60_000,
  }, async (engine) => inHome(async () => {
    const { lines } = await purgeWithRerun(engine);
    const restore = await engine.transaction(tx => replayPurgesInRestore(tx, { lines, archivedAt: ARCHIVED_AT, restoreId: 'rerun-restore' }));
    const result = { state: restore.state, outcomes: restore.replays.map(r => r.outcome) };
    expect(result).toEqual({ state: 'none', outcomes: [] });
    return result;
  }));

  parityTest('an intent line with no committed line still reads unverified unless a committed line names the same request and target', {
    methods: ['insertFact', 'insertFactPurge', 'readPurgeReplaySchema'],
    requires: 'raw_sql',
    timeout: 60_000,
  }, async (engine) => inHome(async () => {
    await registerLocalWriter(engine, 'cli');
    const ctx = contextFor(engine);
    const seeded = await engine.insertFact({ fact: CLAIM, entity_slug: null, source: 'chat', visibility: VISIBILITY }, { source_id: SRC });
    const dry = await purge.handler(ctx, { id: seeded.id, dry_run: true }) as Record<string, unknown>;
    await purge.handler(ctx, { id: seeded.id, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: REQUEST });
    const lines = readPurgeMirror(purgeMirrorPath()) ?? [];
    const [done] = lines.filter((l): l is PurgeMirrorIntent => l.kind === 'intent');
    // A crash between the commit and the committed line, and three near siblings of the committed run: none is covered.
    const orphans: Array<[string, PurgeMirrorIntent]> = [
      ['other request_id', { ...done!, request: 'b0000000-0000-4000-8000-000000000001', request_id: 'a0000000-0000-4000-8000-0000000000b3' }],
      ['other fact', { ...done!, request: 'b0000000-0000-4000-8000-000000000002', facts: [{ ...done!.facts[0]!, fact_hash: 'f'.repeat(64) }] }],
      ['other epoch', { ...done!, request: 'b0000000-0000-4000-8000-000000000003', purge_epoch: done!.purge_epoch + 1 }],
    ];
    const restore = await engine.transaction(tx => replayPurgesInRestore(tx, { lines: [...lines, ...orphans.map(([, l]) => l)], archivedAt: ARCHIVED_AT,
      restoreId: 'orphan-restore' }));
    const result = { committed_intents: lines.filter(l => l.kind === 'intent').length, state: restore.state,
      outcomes: Object.fromEntries(restore.replays.map(r => [orphans.find(([, l]) => l.request === r.request)?.[0] ?? r.request, r.outcome])) };
    expect(result).toEqual({ committed_intents: 1, state: 'unverified',
      outcomes: { 'other request_id': 'unverified', 'other fact': 'unverified', 'other epoch': 'unverified' } });
    return result;
  }));
});
