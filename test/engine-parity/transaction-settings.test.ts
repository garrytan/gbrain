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
 * `readCurrentWriteTrust` (persistence/context.ts `currentWriteTrust`) reads the two trust settings the tier trigger
 * reads: the declaration applied in a transaction, none outside one, the outer one again after a savepoint rollback.
 *
 * `setWriteContext` (persistence/context.ts `withCoordinatedWrite`) sets a coordinated write's source scope, actor,
 * trust and git protocol in one call and returns the persistence identity and the values it replaced: a nested call
 * keeps the outer actor, a declared tier nests as min(outer, inner), an undeclared origin keeps the outer one, and an
 * undeclared tier leaves both trust settings alone. A Rust engine that refused it stopped every coordinated write.
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
import { currentWriteTrust } from '../../src/core/persistence/context.ts';
import { WRITE_CONTEXT_SETTINGS } from '../../src/core/engine-sql/transaction-settings.ts';

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
      await tx.applyTransactionSettings(names, ['agent_written', '{"channel":"cli"}', 'default,notes', 'req-1', 'on']);
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

  parityTest('readCurrentWriteTrust reads the trust declaration in force on the transaction', {
    methods: ['transaction', 'applyTransactionSettings', 'readCurrentWriteTrust'],
  }, async (engine, backend) => {
    const fold = (row: { tier: string | null; origin: string | null }) => ({ tier: row.tier ?? '', origin: row.origin ?? '' });
    const outside = fold(await engine.readCurrentWriteTrust());
    const inside = await engine.transaction(async (tx) => {
      const before = await tx.readCurrentWriteTrust();
      if (backend === 'rust') expect(before).toEqual({ tier: null, origin: null });
      await tx.applyTransactionSettings([TIER, ORIGIN], ['agent_written', '{"channel":"cli"}']);
      const declared = await tx.readCurrentWriteTrust();
      const dropped = await tx.transaction(async (inner) => {
        await inner.applyTransactionSettings([TIER, ORIGIN], ['tool_observed', '']);
        throw Object.assign(new Error('drop the savepoint'), { seen: await inner.readCurrentWriteTrust() });
      }).then(() => null, (error: { seen?: unknown }) => error.seen ?? null);
      return { before: fold(before), declared, parsed: await currentWriteTrust(tx), dropped, restored: await tx.readCurrentWriteTrust() };
    });
    const later = await engine.transaction(async (tx) => ({ raw: fold(await tx.readCurrentWriteTrust()), parsed: await currentWriteTrust(tx) }));
    const answers = { outside, ...inside, later };
    expect(answers).toEqual({
      outside: { tier: '', origin: '' },
      before: { tier: '', origin: '' },
      declared: { tier: 'agent_written', origin: '{"channel":"cli"}' },
      parsed: { tier: 'agent_written', origin: { channel: 'cli' } },
      dropped: { tier: 'tool_observed', origin: '' },
      restored: { tier: 'agent_written', origin: '{"channel":"cli"}' },
      later: { raw: { tier: '', origin: '' }, parsed: null },
    });
    return answers;
  });

  parityTest('setWriteContext sets a coordinated write context and nests a second one inside it', {
    methods: ['transaction', 'setWriteContext', 'readTransactionSettings'],
  }, async (engine) => {
    const names = [...WRITE_CONTEXT_SETTINGS];
    const read = async (tx: BrainEngine) => unset(await tx.readTransactionSettings(names));
    const input = (over: Partial<Parameters<BrainEngine['setWriteContext']>[0]>) => ({
      sourceIds: ['default'], requestId: 'req-outer', principalKind: 'agent', principalId: 'agent-1', tier: '', origin: '', ...over });
    const inside = await engine.transaction(async (tx) => {
      const outer = await tx.setWriteContext(input({}));
      const afterOuter = await read(tx);
      const lowered = await tx.setWriteContext(input({ sourceIds: ['default', 'notes'], requestId: 'req-inner', principalKind: 'cli',
        principalId: 'cli-1', tier: 'agent_written', origin: '{"channel":"cli"}' }));
      const afterLowered = await read(tx);
      // A higher tier does not raise the enclosing one; the declared origin still replaces the enclosing origin.
      const notRaised = await tx.setWriteContext(input({ tier: 'user_confirmed', origin: '{"kind":"owner"}' }));
      const afterNotRaised = await read(tx);
      // A lower tier lowers it; no declared origin keeps the enclosing one.
      const lower = await tx.setWriteContext(input({ tier: 'external_untrusted' }));
      const afterLower = await read(tx);
      // No declared tier leaves both trust settings as they are.
      const undeclared = await tx.setWriteContext(input({ origin: '{"kind":"ignored"}' }));
      const afterUndeclared = await read(tx);
      const strip = (r: { brainId: string | null; previous: string[] }) => ({ identity: typeof r.brainId === 'string' && r.brainId !== '', previous: r.previous });
      return { outer: strip(outer), afterOuter, lowered: strip(lowered), afterLowered, notRaised: strip(notRaised), afterNotRaised,
        lower: strip(lower), afterLower, undeclared: strip(undeclared), afterUndeclared };
    });
    const later = await engine.transaction((tx) => read(tx));
    const answers = { ...inside, later };
    const outerActor = ['req-outer', 'agent', 'agent-1'];
    expect(answers).toEqual({
      outer: { identity: true, previous: ['', '', '', '', '', '', ''] },
      afterOuter: ['["default"]', ...outerActor, '', '', '1'],
      lowered: { identity: true, previous: ['["default"]', ...outerActor, '', '', '1'] },
      afterLowered: ['["default","notes"]', ...outerActor, 'agent_written', '{"channel":"cli"}', '1'],
      notRaised: { identity: true, previous: ['["default","notes"]', ...outerActor, 'agent_written', '{"channel":"cli"}', '1'] },
      afterNotRaised: ['["default"]', ...outerActor, 'agent_written', '{"kind":"owner"}', '1'],
      lower: { identity: true, previous: ['["default"]', ...outerActor, 'agent_written', '{"kind":"owner"}', '1'] },
      afterLower: ['["default"]', ...outerActor, 'external_untrusted', '{"kind":"owner"}', '1'],
      undeclared: { identity: true, previous: ['["default"]', ...outerActor, 'external_untrusted', '{"kind":"owner"}', '1'] },
      afterUndeclared: ['["default"]', ...outerActor, 'external_untrusted', '{"kind":"owner"}', '1'],
      later: ['', '', '', '', '', '', ''],
    });
    return answers;
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

  // gbrain.writer_quiesced is the quiescence declaration skill activation sets before it raises the protocol floor;
  // it reads back inside the transaction and ends with it on every arm. The Rust engine keeps only the settings its
  // writers or callers read; any other name refuses there before any work (test/rust-engine-store.test.ts).
  parityTest('gbrain.writer_quiesced is kept for the transaction and ends with it', {
    methods: ['transaction', 'applyTransactionSettings', 'readTransactionSettings'],
  }, async (engine) => {
    const QUIESCED = 'gbrain.writer_quiesced';
    const before = unset(await engine.transaction((tx) => tx.readTransactionSettings([QUIESCED])));
    const inside = await engine.transaction(async (tx) => {
      await tx.applyTransactionSettings([QUIESCED], ['true']);
      return tx.readTransactionSettings([TIER, QUIESCED]);
    });
    const after = unset(await engine.transaction((tx) => tx.readTransactionSettings([QUIESCED])));
    expect(unset(inside)).toEqual(['', 'true']);
    return { before, inside: unset(inside), after };
  });

  // Any custom gbrain name Postgres accepts and no schema SQL reads (the import-path settings case uses two): kept for
  // the transaction, restored by a savepoint rollback, kept by a release, gone after commit.
  parityTest('a custom gbrain setting no trigger reads is kept for the transaction like the others', {
    methods: ['transaction', 'applyTransactionSettings', 'readTransactionSettings'],
  }, async (engine, backend) => {
    const names = ['gbrain.parity_custom', 'gbrain.parity.nested'];
    const inside = await engine.transaction(async (tx) => {
      const before = await tx.readTransactionSettings(names);
      if (backend === 'rust') expect(before).toEqual([null, null]);
      await tx.applyTransactionSettings(names, ['one', 'two']);
      const set = await tx.readTransactionSettings(names);
      const dropped = await tx.transaction(async (inner) => {
        await inner.applyTransactionSettings([names[0]!], ['dropped']);
        throw Object.assign(new Error('drop the savepoint'), { seen: await inner.readTransactionSettings(names) });
      }).then(() => null, (error: { seen?: unknown }) => error.seen ?? null);
      const afterRollback = await tx.readTransactionSettings(names);
      await tx.transaction((inner) => inner.applyTransactionSettings([names[1]!], ['released']));
      const afterRelease = await tx.readTransactionSettings(names);
      return { before: unset(before), set, dropped, afterRollback, afterRelease };
    });
    expect(inside).toMatchObject({ set: ['one', 'two'], dropped: ['dropped', 'two'], afterRollback: ['one', 'two'], afterRelease: ['one', 'released'] });
    const later = await engine.transaction((tx) => tx.readTransactionSettings(names));
    if (backend === 'rust') expect(later).toEqual(['', '']);
    return { ...inside, later: unset(later) };
  });

  // The attribution triggers cast `gbrain.write_request` with `::uuid` on every row written to pages, page_versions,
  // facts, takes and timeline_entries, so a request that is not a UUID refuses each of those writes and leaves no row.
  parityTest('a write request that is not a UUID refuses the page, version, fact and take writes and writes nothing', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'getPage', 'createVersion', 'getVersions', 'insertFact',
      'listFactsByEntity', 'addTakesBatch', 'listTakes'],
  }, async (engine) => {
    const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title} body`, timeline: '' });
    const held = await engine.putPage('attr/held', note('v1'));
    const versionsBefore = (await engine.getVersions('attr/held')).length;
    const names = [REQUEST, 'gbrain.write_principal_kind', PRINCIPAL];
    const under = (request: string, write: (tx: BrainEngine) => Promise<unknown>) => engine.transaction(async (tx) => {
      await tx.applyTransactionSettings(names, [request, 'application', 'host:test-a']);
      await write(tx);
    }).then(() => 'written', () => 'refused');
    const take = { page_id: held.id, row_num: 1, claim: 'refused take', kind: 'take' as const, holder: 'h', weight: 0.5 };
    const outcomes = {
      newPage: await under('req-1', tx => tx.putPage('attr/new', note('new'))),
      pageUpdate: await under('req-1', tx => tx.putPage('attr/held', note('v2'))),
      version: await under('req-1', tx => tx.createVersion('attr/held')),
      fact: await under('req-1', tx => tx.insertFact({ fact: 'refused fact', entity_slug: 'people/attr-example', visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' })),
      take: await under('req-1', tx => tx.addTakesBatch([take])),
      uuidPage: await under('7c1e2a9e-5b3f-4d0a-9e61-0000000000a1', tx => tx.putPage('attr/uuid', note('uuid'))),
    };
    const after = {
      newPage: (await engine.getPage('attr/new'))?.title ?? null,
      held: (await engine.getPage('attr/held'))?.title ?? null,
      versionsAdded: (await engine.getVersions('attr/held')).length - versionsBefore,
      facts: (await engine.listFactsByEntity('default', 'people/attr-example')).length,
      takes: (await engine.listTakes({ page_id: held.id })).length,
      uuidPage: (await engine.getPage('attr/uuid'))?.title ?? null,
    };
    expect({ outcomes, after }).toEqual({
      outcomes: { newPage: 'refused', pageUpdate: 'refused', version: 'refused', fact: 'refused', take: 'refused', uuidPage: 'written' },
      after: { newPage: null, held: 'v1', versionsAdded: 0, facts: 0, takes: 0, uuidPage: 'uuid' },
    });
    return { outcomes, after };
  });
});
