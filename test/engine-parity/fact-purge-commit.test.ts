/**
 * BrainEngine parity — a whole `purge_fact` (src/core/facts/purge.ts submitPurgeFactMutation) through the operation,
 * dry run then commit, on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 * GBRAIN_TEST_RUST_ARM=1).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine the purge of a fact on a source with no belief ledger commits: the fact is gone, its
 *    tombstone refuses the claim, and the request is stored committed. The Rust arm passes its pre-write check
 *    (src/core/persistence/fact-purge-path-members.ts, wired in src/core/ops/purge.ts), which refuses only on a stop the
 *    purge can reach; a source with a belief ledger still has stops (test/engine-parity/fact-purge-receipt-e2e.test.ts).
 *    `--status --continue` also writes (it continues the derivation sweep); a dry run and `--match` only read.
 *  - Regression: the Rust arm ran the purge transaction's write admission (the write request and its counters) before
 *    the first unserved purge statement, and stopped inside the transaction on a refusal that named no owner or date.
 *    A store transaction that kept those writes after the refusal would leave a queued purge request that never
 *    commits, charged to the caller; a purge that half ran would delete without its tombstone.
 *  - Why existing coverage misses it: the purge parity cases call the typed purge members one by one; none runs the
 *    whole operation, so none sees where the Rust arm stops or what it has done by then.
 *  - Seam: none. Real engines; the fact is seeded through the typed `insertFact`. Generated values (fact ids, request
 *    journal ids, times) are compared by relation or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { principalKey } from '../../src/core/persistence/model.ts';
import { requestPrincipalForContext } from '../../src/core/persistence/page-mutations.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const CLAIM = 'Gate code is 7731';
/** A chat fact's default visibility. */
const VISIBILITY = 'private';
const REQUEST = 'a0000000-0000-4000-8000-0000000000a1';
const purge = operations.find((o) => o.name === 'purge_fact')!;

const contextFor = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: SRC,
  logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;

/** `engine`, noting each member called on it or on a transaction it opens. */
function noting(engine: BrainEngine, called: Set<string>): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        called.add(prop);
        if (prop !== 'transaction') return value.apply(target, args);
        const [fn, ...rest] = args as [(tx: BrainEngine) => Promise<unknown>, ...unknown[]];
        return value.call(target, (tx: BrainEngine) => fn(noting(tx, called)), ...rest);
      };
    },
  });
}

/** What the brain holds for the claim and the request: the fact, the tombstone, the stored request and the counters. */
async function brainState(engine: BrainEngine, ctx: OperationContext, id: number) {
  const principal = await requestPrincipalForContext(ctx);
  const request = await engine.readWriteRequest(principal.kind, principal.id, REQUEST);
  const counters = await engine.readCounterRows(['brain', principalKey(principal)]);
  const target = await engine.loadPurgeTarget(id, SRC);
  return {
    fact: target?.fact ?? null,
    purged: await engine.isFactPurged(SRC, VISIBILITY, CLAIM, null),
    request: request && { operation: request.operation, state: request.state },
    counters: counters.map((row) => ({ ...row })),
  };
}

describe('engine parity: a whole fact purge', () => {
  parityTest('purge_fact commits on every engine: the fact is gone, its tombstone refuses the claim, the request is committed', {
    methods: ['insertFact', 'loadPurgeTarget', 'planFactPurgeIds', 'readPurgeSourceLocalPath', 'lockPurgeSource', 'insertWriteRequest',
      'readWriteRequest', 'readCounterRows', 'isFactPurged', 'listPurgeMatchCandidates', 'listBeliefEventsForPurgeProbe'],
    timeout: 60_000,
  }, async (engine) => {
    await registerLocalWriter(engine, 'cli');
    const called = new Set<string>();
    const ctx = contextFor(noting(engine, called));
    const seeded = await engine.insertFact({ fact: CLAIM, entity_slug: null, source: 'chat', visibility: VISIBILITY }, { source_id: SRC });
    expect(seeded.status).toBe('inserted');
    const before = await brainState(engine, ctx, seeded.id);
    expect([before.fact, before.purged, before.request]).toEqual([CLAIM, false, null]);
    const dry = await purge.handler(ctx, { id: seeded.id, dry_run: true }) as Record<string, unknown>;
    // A plain read: bun's toMatchObject would write its matchers into `dry`.
    expect([dry.dry_run, typeof dry.confirm_token, typeof dry.expected_revision]).toEqual([true, 'string', 'string']);
    // --match only reads: it runs on every arm, the Rust arm included.
    const match = await purge.handler(ctx, { match: 'Gate code' }) as { candidates: Array<{ id: number }> };
    expect(match.candidates.map((candidate) => Number(candidate.id))).toEqual([seeded.id]);
    called.clear();
    const commit = { outcome: await purge.handler(ctx, { id: seeded.id, confirm: dry.confirm_token, expected_revision: dry.expected_revision,
      request_id: REQUEST }) as Record<string, unknown> };
    // The receipt read the belief probe (listBeliefEventsForPurgeProbe), which the Rust engine serves.
    expect(called.has('listBeliefEventsForPurgeProbe')).toBe(true);
    const after = await brainState(engine, ctx, seeded.id);
    return {
      state: commit.outcome.state,
      facts: (commit.outcome.counts as Record<string, unknown> | undefined)?.facts ?? null,
      after: { fact: after.fact, purged: after.purged, request: after.request },
    };
  });

  parityTest('purge_fact --status --continue writes through the derivation sweep and answers the same on every engine', {
    // The sweep it continues and the receipt's effect read (rust-5a) are served on Rust, so the continue has no stop left.
    methods: ['readWriteRequest', 'loadPurgeTarget'],
    timeout: 60_000,
  }, async (engine) => {
    await registerLocalWriter(engine, 'cli');
    const called = new Set<string>();
    const ctx = contextFor(noting(engine, called));
    await engine.loadPurgeTarget(1, SRC);
    called.clear();
    const outcome = await purge.handler(ctx, { status: true, continue: true, request_id: REQUEST })
      .then(() => ({ code: 'ok' }), (error: unknown) => ({ error }));
    if (!('error' in outcome)) return outcome;
    const error = outcome.error as { code?: unknown; message?: string; detail?: string };
    return { code: error.code };
  });
});
