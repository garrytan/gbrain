/**
 * BrainEngine parity — the belief side of a purge that ran through `executeRaw` in belief/purge.ts, facts/purge.ts,
 * persistence/page-purge.ts and belief/purge-mirror.ts (engine-sql/belief-purge.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: bumpSourcePurgeEpoch, hasBeliefEvents, registerPurgeRedaction, releasePurgeRedactionsForField,
 *    replayPagePurges, readPurgeReplaySchema and listBeliefEventsForPurgeProbe return the same observable result on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes whether a purge raises the source's purge
 *    epoch (so caches drop the purged rows), whether it writes the ledger's suppressions, which suppressions an owner
 *    release lifts, what a restore replay re-tombstones, and whether a purge receipt sees recorded history that still
 *    quotes the purged claim (an engine that refuses the probe fails the receipt; one that answers [] reports it clean); the Rust engine has no SQL, so each statement has to exist
 *    as a typed method it can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines.
 *  - Seam: none in the cases. Typed members only (no executeRaw: D18). Sources and the belief ledger's coverage come
 *    through the harness fixtures; the receipt case runs facts/purge-verify.ts ledgerReports through a view of the engine
 *    whose listFactContextsForPurgeProbe answers no live facts on every arm (the fixture has none; Rust still refuses that
 *    read, and the whole receipt case with a fact_context quote waits for it); suppressions are read back through the typed readBeliefRedactions, the epoch through
 *    readSourcePurgeEpoch and the tombstones through countPagePurgeTombstones. Generated values (suppression ids) are
 *    never compared.
 */
import { describe, expect } from 'bun:test';
import { createSource, enableBeliefCoverage, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { BeliefEventInsertRow } from '../../src/core/engine-sql/belief-ledger.ts';
import { PURGE_SWEEP_STORES } from '../../src/core/persistence/page-purge.ts';
import { __ledgerReportsForTests as ledgerReports } from '../../src/core/facts/purge-verify.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const PURGE = 'a0000000-0000-4000-8000-0000000000a1';
const PURGE2 = 'a0000000-0000-4000-8000-0000000000a2';
const PUB = 'd0000000-0000-4000-8000-0000000000d1';
const PUB2 = 'd0000000-0000-4000-8000-0000000000d2';
const LIFE = 'e0000000-0000-4000-8000-0000000000e1';
const CLAIM = 'Acme pays its suppliers in cash';

/** A recorded fact event of `sourceId` at `ord`; `value` is its recorded value (null: a value-less event). */
function event(sourceId: string, incarnation: string, ord: number, value: Record<string, unknown> | null, over: Partial<BeliefEventInsertRow> = {}): BeliefEventInsertRow {
  return {
    event_key: `ee${sourceId === SRC ? '00' : '01'}${ord.toString(16).padStart(2, '0')}`, source_id: sourceId, source_incarnation: incarnation, page_lifetime: LIFE,
    slug: 'companies/acme-example', subject_kind: 'fact', subject_key: `fact:${ord}`, event_type: 'fact.asserted', origin: 'live', trust_tier: 'owner',
    writer_tier: null, tier_basis: 'row', visibility: 'world', publication_id: PUB, ord, source_time: '2026-03-01T10:00:00.000Z', valid_from: null,
    valid_until: null, value: value === null ? null : JSON.stringify(value), value_hash: value === null ? null : `vh${ord}`, prior_hash: null,
    state_hash: `sh${ord}`, cause: JSON.stringify({ kind: 'test' }), claim_fp: `fp${ord}`, purged: false, redacted_fields: null, ...over,
  };
}

/** The source's suppressions on the subjects, without their ids, in a fixed order. */
async function suppressions(engine: BrainEngine, subjects: string[], sourceId = SRC) {
  const rows = await engine.readBeliefRedactions(sourceId, subjects, []);
  return sorted(rows.map(({ id: _id, ...rest }) => rest), r => `${r.subject_key}|${r.field}|${r.purge_request}|${r.field_hash}`);
}

describe('engine parity: the belief side of a purge', () => {
  parityTest('bumpSourcePurgeEpoch raises the source epoch by one each call and answers null for an unknown source', {
    methods: ['readSourcePurgeEpoch', 'bumpSourcePurgeEpoch'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const before = Number(await engine.readSourcePurgeEpoch(SRC));
    const first = await engine.bumpSourcePurgeEpoch(SRC);
    const second = await engine.bumpSourcePurgeEpoch(SRC);
    const answers = {
      steps: [first! - before, second! - before], read: Number(await engine.readSourcePurgeEpoch(SRC)) - before,
      other: Number(await engine.readSourcePurgeEpoch('other')), unknown: await engine.bumpSourcePurgeEpoch('missing'),
    };
    expect(answers).toEqual({ steps: [1, 2], read: 2, other: 0, unknown: null });
    return answers;
  });

  parityTest('hasBeliefEvents is false before the ledger covers a source and true after, for that source only', {
    methods: ['hasBeliefEvents'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const before = await engine.hasBeliefEvents(SRC);
    await enableBeliefCoverage(engine, backend, SRC);
    const answers = { before, after: await engine.hasBeliefEvents(SRC), other: await engine.hasBeliefEvents('other'), unknown: await engine.hasBeliefEvents('missing') };
    expect(answers).toEqual({ before: false, after: true, other: false, unknown: false });
    return answers;
  });

  parityTest('registerPurgeRedaction records each (subject, field, request, hash) once and keeps sources apart', {
    methods: ['registerPurgeRedaction', 'readBeliefRedactions'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const row = { sourceId: SRC, subjectKey: 'fact:1', field: 'value', purgeRequest: PURGE, fieldHash: 'h-value' };
    await engine.registerPurgeRedaction(row);
    await engine.registerPurgeRedaction(row);
    await engine.registerPurgeRedaction({ ...row, purgeRequest: PURGE2 });
    await engine.registerPurgeRedaction({ ...row, field: 'context', fieldHash: 'h-context' });
    await engine.registerPurgeRedaction({ ...row, sourceId: 'other' });
    const answers = { here: await suppressions(engine, ['fact:1']), other: await suppressions(engine, ['fact:1'], 'other') };
    expect(answers.here).toHaveLength(3);
    expect(answers.other).toHaveLength(1);
    expect(answers.here.every(r => r.released_hash === null)).toBe(true);
    return answers;
  });

  parityTest('releasePurgeRedactionsForField releases the field to the new hash once, never a suppression of that hash', {
    methods: ['registerPurgeRedaction', 'releasePurgeRedactionsForField', 'readBeliefRedactions'],
  }, async (engine) => {
    const base = { sourceId: SRC, subjectKey: 'fact:1', field: 'value' };
    await engine.registerPurgeRedaction({ ...base, purgeRequest: PURGE, fieldHash: 'h-old' });
    await engine.registerPurgeRedaction({ ...base, purgeRequest: PURGE2, fieldHash: 'h-new' });
    await engine.registerPurgeRedaction({ ...base, field: 'context', purgeRequest: PURGE, fieldHash: 'h-ctx' });
    await engine.registerPurgeRedaction({ ...base, subjectKey: 'fact:2', purgeRequest: PURGE, fieldHash: 'h-old' });
    const release = { ...base, releasedBy: PUB, releasedHash: 'h-new' };
    const first = (await engine.releasePurgeRedactionsForField(release)).sort();
    const again = await engine.releasePurgeRedactionsForField({ ...release, releasedBy: PUB2 });
    const later = (await engine.releasePurgeRedactionsForField({ ...release, releasedBy: PUB2, releasedHash: 'h-later' })).sort();
    const none = await engine.releasePurgeRedactionsForField({ ...release, subjectKey: 'fact:missing' });
    const answers = { first, again, later, none, rows: await suppressions(engine, ['fact:1', 'fact:2']) };
    expect(answers.first).toEqual([PURGE]);
    expect(answers.again).toEqual([]);
    expect(answers.later).toEqual([PURGE, PURGE2]);
    expect(answers.rows.map(r => [r.subject_key, r.field, r.purge_request, r.released_hash])).toEqual([
      ['fact:1', 'context', PURGE, null], ['fact:1', 'value', PURGE, 'h-later'], ['fact:1', 'value', PURGE2, 'h-later'], ['fact:2', 'value', PURGE, null],
    ]);
    return answers;
  });

  parityTest('replayPagePurges tombstones each hash once under the slug and moves a tombstoned hash to the new slug', {
    methods: ['replayPagePurges', 'countPagePurgeTombstones'],
  }, async (engine) => {
    await engine.replayPagePurges({ sourceId: SRC, contentHashes: ['c1', 'c2'], slug: 'notes/a', requestId: PURGE });
    const first = await engine.countPagePurgeTombstones(SRC, 'notes/a');
    await engine.replayPagePurges({ sourceId: SRC, contentHashes: ['c2', 'c3'], slug: 'notes/b', requestId: null });
    await engine.replayPagePurges({ sourceId: SRC, contentHashes: [], slug: 'notes/c', requestId: null });
    const answers = {
      first, a: await engine.countPagePurgeTombstones(SRC, 'notes/a'), b: await engine.countPagePurgeTombstones(SRC, 'notes/b'),
      c: await engine.countPagePurgeTombstones(SRC, 'notes/c'),
    };
    expect(answers).toEqual({ first: 2, a: 1, b: 2, c: 0 });
    return answers;
  });

  parityTest('readPurgeReplaySchema finds every purge sweep store and every probed table and column on the live schema', {
    methods: ['readPurgeReplaySchema'],
  }, async (engine) => {
    const schema = await engine.readPurgeReplaySchema(PURGE_SWEEP_STORES);
    const empty = await engine.readPurgeReplaySchema([]);
    expect(schema).toEqual({ stores: [...PURGE_SWEEP_STORES], changeReason: true, persistenceBrain: true, derivationInputs: true, beliefEvents: true });
    expect(empty.stores).toEqual([]);
    return { schema, empty };
  });

  parityTest('listBeliefEventsForPurgeProbe hands a purge receipt every recorded value of the source that still quotes the claim, in id order after the cursor', {
    methods: ['readLedgerSource', 'insertBeliefEvents', 'listBeliefEventsForPurgeProbe'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const inc = (await engine.readLedgerSource(SRC))!.incarnation;
    const otherInc = (await engine.readLedgerSource('other'))!.incarnation;
    const marker = `[redacted: purge ${PURGE}]`;
    // What a purge of CLAIM leaves: its own fact redacted, a context it missed (a carrying field: the receipt's
    // `incomplete`), another subject's longer claim (`out_of_scope`), an unrelated fact, a value-less event, and the
    // same quote in another source, which this source's receipt must never see.
    await engine.insertBeliefEvents([
      event(SRC, inc, 1, { fact: marker, context: 'board memo' }, { redacted_fields: ['fact'] }),
      event(SRC, inc, 2, { fact: 'Acme sells widgets', context: `memo: ${CLAIM}` }),
      event(SRC, inc, 3, { fact: `${CLAIM.toUpperCase()} and in kind` }),
      event(SRC, inc, 4, { fact: 'Acme has two offices' }),
      event(SRC, inc, 5, null, { event_type: 'fact.retracted' }),
      event('other', otherInc, 6, { fact: CLAIM }),
    ]);
    const read = async (sourceId: string, after: number) => (await engine.listBeliefEventsForPurgeProbe(sourceId, after))
      .map(r => ({ id: Number(r.id), subject_kind: r.subject_kind, subject_key: r.subject_key, value: typeof r.value === 'string' ? JSON.parse(r.value) : r.value }));
    const all = await read(SRC, 0);
    const quoting = all.filter(r => JSON.stringify(r.value).toLowerCase().includes(CLAIM.toLowerCase())).map(r => r.subject_key);
    expect(all.map(r => r.subject_key)).toEqual(['fact:1', 'fact:2', 'fact:3', 'fact:4']);
    expect(quoting).toEqual(['fact:2', 'fact:3']);
    const base = all[0]!.id;
    const rel = (rows: typeof all) => rows.map(({ id, ...rest }) => ({ id: id - base, ...rest }));
    const answers = {
      all: rel(all), quoting, afterSecond: rel(await read(SRC, all[1]!.id)), afterAll: await read(SRC, all[all.length - 1]!.id),
      other: (await read('other', 0)).map(r => r.subject_key), nobody: await read('nobody', 0),
    };
    expect(answers.all.map(r => r.id)).toEqual([0, 1, 2, 3]);
    expect(answers.afterSecond.map(r => r.subject_key)).toEqual(['fact:3', 'fact:4']);
    expect({ afterAll: answers.afterAll, other: answers.other, nobody: answers.nobody }).toEqual({ afterAll: [], other: ['fact:6'], nobody: [] });
    return answers;
  });

  parityTest('the receipt\'s belief_events report is byte-equal when a recorded JSON null sits next to the events that quote the claim', {
    methods: ['readLedgerSource', 'insertBeliefEvents', 'listBeliefEventsForPurgeProbe'],
  }, async (engine) => {
    const inc = (await engine.readLedgerSource(SRC))!.incarnation;
    const LONGER = 'Acme rents its warehouse';
    // Postgres keeps a recorded JSON null as a value (null) and the Rust store keeps it as no value; the report must not tell.
    const jsonNull = (ord: number) => event(SRC, inc, ord, null, { value: 'null', value_hash: `vh${ord}` });
    await engine.insertBeliefEvents([
      jsonNull(1),
      event(SRC, inc, 2, { fact: 'Acme sells widgets', context: `memo: ${CLAIM}` }),
      jsonNull(3),
      event(SRC, inc, 4, { fact: `${LONGER} by the month` }),
      jsonNull(5),
    ]);
    const view = new Proxy(engine, {
      get(target, key) {
        if (key === 'listFactContextsForPurgeProbe') return async () => [];
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const report = async (claim: string) => JSON.stringify(await ledgerReports(view, SRC, [claim], null, performance.now() + 20_000));
    const answers = { missed: await report(CLAIM), other: await report(LONGER), absent: await report('Acme has no warehouse') };
    expect(JSON.parse(answers.missed)).toEqual([{ store: 'belief_events', status: 'incomplete', remaining: 1, removed: 0, items: ['context@fact:2'] }]);
    expect(JSON.parse(answers.other)).toMatchObject([{ store: 'belief_events', status: 'out_of_scope', remaining: 1, items: ['fact@fact:4'] }]);
    expect(JSON.parse(answers.absent)).toEqual([{ store: 'belief_events', status: 'not_present', removed: 0 }]);
    return answers;
  });
});
