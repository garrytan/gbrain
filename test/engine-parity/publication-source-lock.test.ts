/**
 * BrainEngine parity — the exclusive source lock of the publication transaction (persistence/coordinator.ts
 * `publishMutation`): a mutation that declares `sourceExclusive` (a page purge, a sync checkpoint, a connector write)
 * takes its source's row lock before anything else of the publication runs, unless it names `exclusiveSources`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a claimed write whose prepared mutation is `sourceExclusive` publishes through `publishMutation` and
 *    commits on every engine arm (PGLite, Postgres, Rust); its `apply` runs once, inside the publication transaction,
 *    and the request ends `committed` with the same outcome.
 *  - Regression: an engine that cannot take the lock refuses every purge, every sync checkpoint and every connector write
 *    at its publication, after the request was admitted and claimed; a Rust brain has no SQL, so the lock has to be a
 *    typed member.
 *  - Why existing coverage misses it: the lock was a raw `executeRaw` inside coordinator.ts, which no parity case can call
 *    (D18), and the publication tests run on PGLite and Postgres only.
 *  - Seam: coordinator.ts's own exported `publishMutation`, on a request admitted and claimed through the journal. The
 *    request names no worktree, so no canonical file is written. Generated values (journal ids, tokens, time stamps) are
 *    left out of the returned value.
 */
import { afterEach, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { publishMutation, type PreparedMutation } from '../../src/core/persistence/coordinator.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';

const { parityTest } = parityArms(testBackends());
const REQUEST = 'b0000000-0000-4000-8000-0000000000b1';
const opened: BrainEngine[] = [];

afterEach(async () => {
  for (const engine of opened.splice(0)) await disposePersistenceConsumer(engine).catch(() => undefined);
});

/** Admits one put_page request through the real admission path and claims it, as the owner's consumer does. */
async function claimedWrite(engine: BrainEngine, slug: string) {
  opened.push(engine);
  await registerLocalWriter(engine, 'cli');
  const source = await engine.readSourceMembership('default');
  const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source!.incarnation, slug);
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source!.incarnation, slug, requestId: REQUEST, callerIntent: { body: slug }, intent: { body: slug } });
  const claimed = await claimNextWrite(engine, randomUUID());
  expect(claimed?.request_id).toBe(REQUEST);
  return claimed!;
}

/**
 * `engine`, keeping every raw_sql refusal a call on it (or on a transaction handle it opens) raised. publishMutation
 * catches a refusal inside its transaction and releases the claim, so the case reads the refusal from here.
 */
function keepingRefusals(engine: BrainEngine, refusals: unknown[]): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if ((prop === 'transaction' || prop === 'transactionDirect') && typeof args[0] === 'function') {
          const fn = args[0] as (tx: BrainEngine) => unknown;
          args = [(tx: BrainEngine) => fn(keepingRefusals(tx, refusals)), ...args.slice(1)];
        }
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!(result instanceof Promise)) return result;
        return result.catch((error: unknown) => {
          if (isCapabilityRefusal(error, 'raw_sql')) refusals.push(error);
          throw error;
        });
      };
    },
  });
}

describe('engine parity: the publication transaction\'s exclusive source lock', () => {
  parityTest('a sourceExclusive mutation publishes through publishMutation and commits', {
    methods: ['readSourceMembership', 'transaction', 'transactionDirect'],
    requires: 'raw_sql',
    timeout: 60_000,
  }, async (engine) => {
    const row = await claimedWrite(engine, 'notes/parity-exclusive');
    let applied = 0;
    const prepared: PreparedMutation = { observedRevision: null, sourceExclusive: true, apply: async () => { applied++; return { applied }; } };
    const refusals: unknown[] = [];
    const done = await publishMutation(keepingRefusals(engine, refusals), row, prepared);
    if (refusals.length > 0) {
      // A Rust brain: the publication refused and released the claim. The refusal is the lock statement at coordinator.ts.
      expect(applied).toBe(0);
      expect(String((refusals[0] as Error).stack)).toContain('persistence/coordinator.ts');
      expect(done.state).toBe('queued');
      throw refusals[0];
    }
    expect(applied).toBe(1);
    expect({ state: done.state, error: done.error_code ?? null }).toEqual({ state: 'committed', error: null });
    return { state: done.state, error: done.error_code ?? null, outcome: done.outcome, applied };
  });
});
