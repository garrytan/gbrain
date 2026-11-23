/**
 * BrainEngine parity — the exclusive source lock of the publication transaction (persistence/coordinator.ts
 * `publishMutation`) and the typed member that takes it (`lockSourceForUpdate`, engine-sql/sources.ts): a mutation that declares `sourceExclusive` (a page purge, a sync checkpoint, a connector write)
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
 *  - Seam: coordinator.ts's own exported `publishMutation`, and the member called directly (a known source, an unknown one,
 *    inside a transaction, twice in one transaction), on a request admitted and claimed through the journal. The
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

describe('engine parity: the publication transaction\'s exclusive source lock', () => {
  parityTest('a sourceExclusive mutation publishes through publishMutation and commits', {
    methods: ['readSourceMembership', 'transaction', 'transactionDirect'],
    timeout: 60_000,
  }, async (engine) => {
    const row = await claimedWrite(engine, 'notes/parity-exclusive');
    let applied = 0;
    const prepared: PreparedMutation = { observedRevision: null, sourceExclusive: true, apply: async () => { applied++; return { applied }; } };
    const done = await publishMutation(engine, row, prepared);
    expect(applied).toBe(1);
    expect({ state: done.state, error: done.error_code ?? null }).toEqual({ state: 'committed', error: null });
    return { state: done.state, error: done.error_code ?? null, outcome: done.outcome, applied };
  });

  parityTest('lockSourceForUpdate answers nothing for a known source, an unknown one and an empty id, outside a transaction', {
    methods: ['lockSourceForUpdate'],
  }, async (engine) => {
    const known = await engine.lockSourceForUpdate('default');
    const unknown = await engine.lockSourceForUpdate('no-such-source');
    const empty = await engine.lockSourceForUpdate('');
    return { known: known ?? null, unknown: unknown ?? null, empty: empty ?? null };
  });

  parityTest('lockSourceForUpdate inside a transaction leaves the source row and the transaction usable, and may be taken twice', {
    methods: ['lockSourceForUpdate', 'transaction', 'readSourceMembership', 'lockSourceRow'],
  }, async (engine) => {
    const before = await engine.readSourceMembership('default');
    const inside = await engine.transaction(async (tx) => {
      const first = await tx.lockSourceForUpdate('default');
      const second = await tx.lockSourceForUpdate('default');
      const other = await tx.lockSourceForUpdate('no-such-source');
      const row = await tx.lockSourceRow('default');
      return { first: first ?? null, second: second ?? null, other: other ?? null, row: row && { id: row.id, archived: row.archived } };
    });
    const after = await engine.readSourceMembership('default');
    expect(after).toEqual(before);
    return { inside, unchanged: JSON.stringify(after) === JSON.stringify(before) };
  });

  parityTest('a transaction that rolls back after lockSourceForUpdate keeps nothing and the next transaction locks again', {
    methods: ['lockSourceForUpdate', 'transaction'],
  }, async (engine) => {
    const failed = await engine.transaction(async (tx) => {
      await tx.lockSourceForUpdate('default');
      throw new Error('stop after the lock');
    }).then(() => null, (error: Error) => error.message);
    const next = await engine.transaction(async (tx) => (await tx.lockSourceForUpdate('default')) ?? null);
    return { failed, next };
  });
});
