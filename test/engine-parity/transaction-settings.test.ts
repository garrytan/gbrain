/**
 * BrainEngine parity — transaction-local settings (engine-sql/transaction-settings.ts `readTransactionSettings` and
 * `applyTransactionSettings`, plus `beginSnapshotRead`), the `current_setting(name, true)` / `set_config(name, value, true)` pair that carries a
 * write's attribution and trust declaration to the database triggers (persistence/context.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a setting applied inside a transaction reads back inside it, ends with it, is restored by a savepoint
 *    rollback and kept by a savepoint release; an apply outside a transaction keeps nothing; two transactions never
 *    see each other's settings; a name outside the setting-name alphabet throws before any work. On every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that keeps a setting past its transaction, or lets one transaction read another's, stamps
 *    rows with the wrong writer's trust tier or attributes them to the wrong request.
 *  - Why existing coverage misses it: the settings were only reached through the attribution scopes, whose callers
 *    the Rust engine refused at the first `readTransactionSettings`, and trust-fence.test.ts set the Rust store's
 *    trust context directly.
 *  - Seam: the typed members only (no executeRaw: D18).
 *
 * Null and '' both mean "unset" to every caller (context.ts reads `value ?? ''`). Which one an unset name reads as
 * depends on the connection: Postgres keeps a placeholder for a name once any statement on that connection set it, so
 * it then reads '' where a fresh connection reads null. PGLite has one connection per engine and Postgres a pool, so
 * the answers compared across arms fold null into ''. The Rust arm opens a fresh brain for every case, so each case
 * also checks the exact null-or-'' answer there.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const TIER = 'gbrain.write_trust_tier';
const ORIGIN = 'gbrain.write_origin';
const OPEN_FACTS = 'gbrain.write_open_facts';
const SOURCES = 'gbrain.write_sources';
const REQUEST = 'gbrain.write_request';
const PRINCIPAL = 'gbrain.write_principal_id';
const GIT = 'gbrain.git_protocol';

const unset = (values: Array<string | null>) => values.map((value) => value ?? '');
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('engine parity: transaction-local settings', () => {
  parityTest('a setting applied in a transaction reads back in it and ends with it', {
    methods: ['transaction', 'applyTransactionSettings', 'readTransactionSettings'],
  }, async (engine, backend) => {
    const names = [TIER, ORIGIN, SOURCES, REQUEST, GIT];
    const inside = await engine.transaction(async (tx) => {
      const before = await tx.readTransactionSettings(names);
      if (backend === 'rust') expect(before).toEqual([null, null, null, null, null]);
      await tx.applyTransactionSettings(names, ['agent_written', '{"kind":"cli"}', 'default,notes', 'req-1', 'on']);
      return { before: unset(before), after: await tx.readTransactionSettings(names) };
    });
    const later = await engine.transaction((tx) => tx.readTransactionSettings(names));
    // A name set before on this connection reads as '' once its transaction ended (Postgres keeps the placeholder).
    if (backend === 'rust') expect(later).toEqual(['', '', '', '', '']);
    return { ...inside, later: unset(later) };
  });

  parityTest('an apply outside a transaction keeps nothing', {
    methods: ['applyTransactionSettings', 'readTransactionSettings'],
  }, async (engine, backend) => {
    await engine.applyTransactionSettings([TIER, PRINCIPAL], ['tool_observed', 'agent-1']);
    const values = await engine.readTransactionSettings([TIER, PRINCIPAL, OPEN_FACTS]);
    if (backend === 'rust' || backend === 'pglite') expect(values.slice(0, 2)).toEqual(['', '']);
    if (backend === 'rust') expect(values[2]).toBeNull();
    return unset(values);
  });

  parityTest('a savepoint rollback restores the settings and a release keeps them', {
    methods: ['transaction', 'applyTransactionSettings', 'readTransactionSettings'],
  }, async (engine, backend) => {
    const names = [TIER, SOURCES, PRINCIPAL];
    return engine.transaction(async (tx) => {
      await tx.applyTransactionSettings([TIER, SOURCES], ['agent_written', 'default']);
      const dropped = await tx.transaction(async (inner) => {
        await inner.applyTransactionSettings(names, ['tool_observed', 'notes', 'agent-2']);
        const seen = await inner.readTransactionSettings(names);
        throw Object.assign(new Error('drop the savepoint'), { seen });
      }).then(() => null, (error: { seen?: unknown }) => error.seen ?? null);
      const afterRollback = await tx.readTransactionSettings(names);
      // The name first set inside the dropped savepoint keeps its placeholder: it reads '' rather than null.
      if (backend === 'rust' || backend === 'pglite') expect(afterRollback).toEqual(['agent_written', 'default', '']);
      await tx.transaction((inner) => inner.applyTransactionSettings([TIER, PRINCIPAL], ['user_confirmed', 'owner']));
      const afterRelease = await tx.readTransactionSettings(names);
      return { dropped, afterRollback: unset(afterRollback), afterRelease };
    });
  });

  parityTest('two transactions opened together each read only their own settings', {
    methods: ['transaction', 'applyTransactionSettings', 'readTransactionSettings'],
  }, async (engine) => {
    const run = (tier: string, request: string) => engine.transaction(async (tx) => {
      await tx.applyTransactionSettings([TIER, REQUEST], [tier, request]);
      await pause();
      const own = await tx.readTransactionSettings([TIER, REQUEST]);
      await pause();
      return own;
    });
    return Promise.all([run('agent_written', 'req-a'), run('operator_curated', 'req-b')]);
  });

  parityTest('a name outside the setting-name alphabet throws before any work', {
    methods: ['transaction', 'applyTransactionSettings', 'readTransactionSettings'],
  }, async (engine) => {
    const message = (run: () => Promise<unknown>) => run().then(() => 'resolved', (error: Error) => error.message);
    const outside = [
      await message(() => engine.readTransactionSettings(['gbrain.Write-Tier'])),
      await message(() => engine.applyTransactionSettings([TIER, 'bad name'], ['agent_written', 'x'])),
    ];
    const inside = await engine.transaction(async (tx) => {
      const refused = await message(() => tx.applyTransactionSettings([TIER, '1gbrain'], ['agent_written', 'x']));
      return { refused, tier: await tx.readTransactionSettings([TIER]) };
    });
    return { outside, inside: { ...inside, tier: unset(inside.tier) } };
  });

  // beginSnapshotRead starts the transaction as one snapshot. The store transaction is one snapshot already (it holds
  // the one writer from its start), so the Rust member sets nothing; the reads after it answer the same on every arm.
  parityTest('a snapshot read transaction answers its reads and keeps its settings', {
    methods: ['transaction', 'beginSnapshotRead', 'applyTransactionSettings', 'readTransactionSettings', 'putPage', 'getPage'],
  }, async (engine) => {
    await engine.putPage('snap/one', { type: 'note', title: 'One', compiled_truth: 'body one' });
    const read = (readOnly?: boolean) => engine.transaction(async (tx) => {
      await tx.beginSnapshotRead(readOnly === undefined ? undefined : { readOnly });
      const page = await tx.getPage('snap/one');
      await tx.applyTransactionSettings([REQUEST], ['req-snap']);
      return { title: page?.title ?? null, body: page?.compiled_truth ?? null, request: await tx.readTransactionSettings([REQUEST]) };
    });
    return { plain: await read(), readOnly: await read(true), readWrite: await read(false) };
  });

  // READ ONLY refuses a write in the transaction on every engine with Postgres's read_only_sql_transaction error
  // (SQLSTATE 25006), and the refused write leaves nothing behind.
  parityTest('a write in a READ ONLY snapshot refuses with read_only_sql_transaction and leaves nothing', {
    methods: ['transaction', 'beginSnapshotRead', 'putPage', 'getPage'],
  }, async (engine) => {
    const refusal = await engine.transaction(async (tx) => {
      await tx.beginSnapshotRead({ readOnly: true });
      await tx.putPage('snap/ro', { type: 'note', title: 'RO', compiled_truth: 'body' });
    }).then(() => null, (error: unknown) => error as { code?: unknown; message?: unknown; constructor?: { name?: string } });
    return { code: refusal?.code ?? null, message: String(refusal?.message ?? '').replace(/^cannot execute .+ in a read-only transaction$/, 'cannot execute <statement> in a read-only transaction'), page: await engine.getPage('snap/ro') };
  });

  // The Rust engine keeps only the settings its writers read (the six trust settings in the store, the attribution
  // and source scope on the transaction); any other name refuses as a capability it lacks. PGLite answers it.
  parityTest('a setting name the Rust engine does not keep refuses on Rust', {
    methods: ['transaction', 'readTransactionSettings'],
  }, async (engine, backend) => {
    const read = (tx: BrainEngine) => tx.readTransactionSettings([TIER, 'gbrain.writer_quiesced']);
    return engine.transaction(async (tx) => {
      if (backend !== 'rust') return unset(await read(tx));
      const refusal = await read(tx).then(() => null, (error: unknown) => error);
      expect(refusal).toMatchObject({
        code: 'engine_capability_missing',
        reason: 'transactions',
        detail: 'member=readTransactionSettings capability=transactions setting=gbrain.writer_quiesced outcome=none written=nothing',
      });
      throw refusal;
    });
  });
});

