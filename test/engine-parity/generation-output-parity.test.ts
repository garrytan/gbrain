/**
 * BrainEngine parity — the generation ledger reads and writes answer PGLite's output on Postgres and on a Rust brain:
 * row order (source, kind, owner and item keys in byte order, never the database collation; generations in id order,
 * never heap order), jsonb number text as Postgres keeps it (`1.0`, `1.50`, `1.00` for `100e-2`) in the text scrub, a
 * JSON `null` held context, proposal or fence as a value (not SQL NULL), an activation id that is not a uuid, a
 * `--since` that is not an ISO instant with a zone, and the fact before-states the fact rows adapter records.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each case gives the same answer on PGLite, Postgres (en_US collation) and the Rust engine. Source ids
 *    `a-z` and `ab` sort `a-z` first in byte order and `ab` first under en_US, so a statement that orders by the
 *    database collation answers differently on Postgres. Rows are written so heap order differs from sorted order (an
 *    item list `b, ab, a-z`; a superseded generation updated after its successor), so a statement with no ORDER BY
 *    answers differently from the Rust store, which reads in key order.
 *  - Regression: `gbrain repair generations` binds its preview hash to the incarnation list order, and the repair, fence
 *    restore, fence evidence and managed-activation callers walk these rows in the order they come; a Postgres brain
 *    with an en_US database listed them in a different order from PGLite and the Rust engine. The Rust text scrub
 *    matched `1` where Postgres stores `1.0`, and did not see a JSON `null` context or proposal, so a purge needle left
 *    rows Postgres scrubs.
 *  - Why existing coverage misses it: the parity cases used ids and keys whose byte and en_US orders agree, wrote rows
 *    in sorted order, and wrote no JSON number with a scale and no JSON `null` column.
 *  - Seam: none. Typed members only (no executeRaw: D18), plus the harness `createSource` fixture and the real
 *    admission path for a queued request. Postgres runs when DATABASE_URL is set (testBackends); the Rust arm runs
 *    through test/engine-parity/harness.ts.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { factPreimages } from '../../src/core/generations/adapters/fact-rows.ts';

const { parityTest } = parityArms(testBackends());

/** Item keys whose heap order (as written) is neither their byte order (`a-z, ab, b`) nor their en_US order (`ab, a-z, b`). */
const KEYS = ['b', 'ab', 'a-z'];

/** 'ok', or the part of the refusal message `pattern` matches (the whole message when it does not match). */
async function outcome<T>(run: () => Promise<T>, pattern: RegExp): Promise<T | string> {
  try {
    return await run();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return pattern.exec(message)?.[0] ?? message;
  }
}

const activation = (generation: number, operationId: string, completeness: string, activationId: string | null = null) => ({ generation, runId: null,
  operationId, inputPin: 'p', inputSize: 1, completeness, setHash: 'h', restoreOf: null, activationId, locator: null });
const ledger = (keys: readonly string[], pending = false) =>
  keys.map(item_key => ({ item_key, identity_hash: `id-${item_key}`, action: 'published', preimage: null, preimage_bytes: null, pending }));
const held = (holdId: string, context: string, proposal: string | null) => ({ holdId, runId: null, inputPin: holdId, inputSize: 1, setHash: 'h',
  reason: 'no_proof', context, proposal, proposalBytes: 2 });

/** Admits one put_page request for `slug` through the real admission path, as a CLI put does. It stays queued. */
async function admitPut(engine: BrainEngine, slug: string, requestId: string) {
  const source = await engine.readSourceMembership('default');
  const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source!.incarnation, slug);
  return admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source!.incarnation, slug, requestId, callerIntent: { body: slug }, intent: { body: slug } });
}

describe('engine parity: generation ledger output', () => {
  parityTest('listSourceIncarnations lists the source ids in byte order', {
    methods: ['listSourceIncarnations'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'ab');
    await createSource(engine, backend, 'a-z');
    const ids = (await engine.listSourceIncarnations(['ab', 'default', 'a-z', 'missing'])).map(row => row.id);
    expect(ids).toEqual(['a-z', 'ab', 'default']);
    return ids;
  });

  parityTest('the ledger item reads answer in generation id and item key byte order', {
    methods: ['transaction', 'activateGenerationRows', 'readGenerationItemsByIds', 'listOwnedGenerationItems', 'readLiveGenerationRow',
      'listRecordedFenceItemKeys', 'readGenerationFenceBlocks'],
  }, async (engine) => {
    const key = { sourceId: 'default', kind: 'order_parity', ownerKey: 'page:notes/o' };
    const first = await engine.transaction(tx => tx.activateGenerationRows(key, null, activation(1, 'order-1', '{"fence":{"n":1}}'), ledger(KEYS)));
    // The supersede updates the first row after the second is written, so the first row's heap tuple comes last.
    const second = await engine.transaction(tx => tx.activateGenerationRows(key, first, activation(2, 'order-2', '{"fence":{"n":2}}'), ledger(KEYS)));
    const label = (id: number | string) => (Number(id) === first ? 'G1' : Number(id) === second ? 'G2' : String(id));
    const answers = {
      items: (await engine.readGenerationItemsByIds([second, first])).map(row => `${label(row.generation_id)}:${row.item_key}`),
      owned: (await engine.listOwnedGenerationItems([second, first])).map(row => `${label(row.generation_id)}:${row.item_key}`),
      live: (await engine.readLiveGenerationRow(key))!.items.map(row => row.item_key),
      recorded: (await engine.listRecordedFenceItemKeys(key, KEYS)).map(row => row.item_key),
      blocks: (await engine.readGenerationFenceBlocks([first, second])).map(row => ({ id: label(row.id), fence: row.fence as unknown })),
    };
    const ordered = ['a-z', 'ab', 'b'];
    expect(answers).toEqual({
      items: [...ordered.map(k => `G1:${k}`), ...ordered.map(k => `G2:${k}`)],
      owned: [...ordered.map(k => `G1:${k}`), ...ordered.map(k => `G2:${k}`)],
      live: ordered,
      recorded: ordered,
      blocks: [{ id: 'G1', fence: { n: 1 } }, { id: 'G2', fence: { n: 2 } }],
    });
    return answers;
  });

  parityTest('the managed activation lists order source, kind, owner, slug and activation id in byte order', {
    methods: ['transaction', 'putPage', 'activateGenerationRows', 'recordGenerationActivation', 'listPendingGenerationMembers',
      'listGenerationOrphanCandidates'],
  }, async (engine) => {
    for (const owner of ['ab', 'a-z']) {
      const key = { sourceId: 'default', kind: 'pending_order', ownerKey: `input:${owner}` };
      await engine.transaction(tx => tx.activateGenerationRows(key, null, activation(1, `pending-${owner}`, '{}'), ledger(KEYS.map(k => `notes/${k}`), true)));
    }
    for (const slug of KEYS) await engine.putPage(`notes/${slug}`, { type: 'note', title: slug, compiled_truth: `${slug} body` });
    const record = (ownerKey: string, activationId: string) => engine.transaction(tx => tx.recordGenerationActivation(
      { sourceId: 'default', kind: 'orphan_order', ownerKey },
      { activationId, expectedGeneration: 0, inputPin: 'p', setHash: 'h',
        members: KEYS.map(k => ({ slug: `notes/${k}`, action: 'create', identity: `id-${k}`, before: null })) }));
    await record('input:ab', '00000000-0000-8000-a000-0000000000b1');
    await record('input:a-z', '00000000-0000-8000-a000-0000000000a2');
    await record('input:a-z', '00000000-0000-8000-a000-0000000000a1');
    const answers = {
      pending: (await engine.listPendingGenerationMembers(['default'], 'pending_order')).map(row => `${row.owner_key} ${row.slug}`),
      orphans: (await engine.listGenerationOrphanCandidates(['default'], 'orphan_order')).map(row => `${row.owner_key} ${row.slug} ${row.activation_id.slice(-2)}`),
    };
    expect(answers).toEqual({
      pending: ['input:a-z', 'input:ab'].flatMap(owner => ['a-z', 'ab', 'b'].map(k => `${owner} notes/${k}`)),
      orphans: [...['a-z', 'ab', 'b'].flatMap(k => [`input:a-z notes/${k} a1`, `input:a-z notes/${k} a2`]),
        ...['a-z', 'ab', 'b'].map(k => `input:ab notes/${k} b1`)],
    });
    return answers;
  });

  parityTest('the text scrub reads jsonb numbers as Postgres keeps them', {
    methods: ['transaction', 'activateGenerationRows', 'recordHeldGenerationRow', 'scrubGenerationTextRows', 'readHeldGenerationContext'],
  }, async (engine) => {
    const key = (ownerKey: string) => ({ sourceId: 'default', kind: 'number_parity', ownerKey });
    await engine.transaction(tx => tx.recordHeldGenerationRow(key('input:scale'), held('h-scale', '{"n":1.0}', null)));
    await engine.transaction(tx => tx.recordHeldGenerationRow(key('input:proposal'), held('h-proposal', '{}', '[{"key":"x","n":1.50}]')));
    await engine.transaction(tx => tx.recordHeldGenerationRow(key('input:big'), held('h-big', '{"n":123456789012345678901234567890}', null)));
    await engine.transaction(tx => tx.recordHeldGenerationRow(key('input:exp'), held('h-exp', '{"n":1.0e2,"m":-0.0}', null)));
    await engine.transaction(tx => tx.activateGenerationRows(key('page:notes/f'), null, activation(1, 'number-fence', '{"fence":{"n":100e-2}}'), []));
    const scrub = (needle: string) => engine.transaction(tx => tx.scrubGenerationTextRows('default', [needle]));
    const answers: Record<string, unknown> = {
      context: await engine.readHeldGenerationContext(key('input:scale'), 'h-scale'),
    };
    for (const needle of ['"n": 1.0}', '1.50', '67890123456789012345678', '1.0e2', '"m": 0.0', '"n": 100', '1.00}']) answers[needle] = await scrub(needle);
    const one = { derived_generation_items: 0, derived_generations: 1 };
    const none = { derived_generation_items: 0, derived_generations: 0 };
    expect(answers).toEqual({ context: { held_context: { n: 1 } }, '"n": 1.0}': one, '1.50': one, '67890123456789012345678': one, '1.0e2': none,
      '"m": 0.0': one, '"n": 100': none, '1.00}': one });
    return answers;
  });

  parityTest('a JSON null held context, proposal or fence is a stored value, not SQL NULL', {
    methods: ['transaction', 'activateGenerationRows', 'recordHeldGenerationRow', 'listHeldGenerationRows', 'readHeldGenerationContext',
      'scrubGenerationTextRows', 'readGenerationFenceBlocks'],
  }, async (engine) => {
    const key = (kind: string, ownerKey: string) => ({ sourceId: 'default', kind, ownerKey });
    await engine.transaction(tx => tx.recordHeldGenerationRow(key('null_parity', 'input:n'), held('h-null', 'null', 'null')));
    await engine.transaction(tx => tx.recordHeldGenerationRow(key('object_parity', 'input:o'), held('h-object', '{}', '{"a":1}')));
    await engine.transaction(tx => tx.recordHeldGenerationRow(key('scalar_parity', 'input:s'), held('h-scalar', '{}', '"s"')));
    const fence = await engine.transaction(tx => tx.activateGenerationRows(key('null_parity', 'page:notes/n'), null, activation(1, 'null-fence', '{"fence":null}'), []));
    const lengths = /cannot get array length of a (scalar|non-array)/;
    const list = (kind: string) => outcome(async () => (await engine.listHeldGenerationRows(['default'], kind, {})).map(row => row.items), lengths);
    const before = { nullList: await list('null_parity'), objectList: await list('object_parity'), scalarList: await list('scalar_parity'),
      context: await engine.readHeldGenerationContext(key('null_parity', 'input:n'), 'h-null'),
      fence: (await engine.readGenerationFenceBlocks([fence])).map(row => row.fence) };
    const scrubbed = await engine.transaction(tx => tx.scrubGenerationTextRows('default', ['null']));
    const after = { nullList: await list('null_parity'), again: await engine.transaction(tx => tx.scrubGenerationTextRows('default', ['null'])),
      fence: (await engine.readGenerationFenceBlocks([fence])).map(row => row.fence) };
    const answers = { before, scrubbed, after };
    expect(answers).toEqual({
      before: { nullList: 'cannot get array length of a scalar', objectList: 'cannot get array length of a non-array',
        scalarList: 'cannot get array length of a scalar', context: { held_context: null }, fence: [null] },
      scrubbed: { derived_generation_items: 0, derived_generations: 2 },
      after: { nullList: [null], again: { derived_generation_items: 0, derived_generations: 0 }, fence: [null] },
    });
    return answers;
  });

  parityTest('an activation id that is not a uuid', {
    methods: ['transaction', 'putPage', 'recordGenerationActivation', 'listGenerationOrphanCandidates', 'readSourceMembership'],
    timeout: 60_000,
  }, async (engine) => {
    await engine.putPage('notes/u', { type: 'note', title: 'U', compiled_truth: 'u body' });
    const record = (activationId: string) => outcome(() => engine.transaction(tx => tx.recordGenerationActivation(
      { sourceId: 'default', kind: 'uuid_parity', ownerKey: 'input:u' },
      { activationId, expectedGeneration: 0, inputPin: 'p', setHash: 'h', members: [{ slug: 'notes/u', action: 'create', identity: 'id-u', before: null }] })),
    /activation id must be a uuid[^:]*: "[^"]*"/);
    const recorded = { bad: await record('not-a-uuid'), braces: await record('{00000000-0000-8000-a000-0000000000c1}'),
      upper: await record('00000000-0000-8000-A000-0000000000C2') };
    const list = () => outcome(async () => (await engine.listGenerationOrphanCandidates(['default'], 'uuid_parity')).map(row => row.activation_id),
      /invalid input syntax for type uuid: "[^"]*"/);
    const empty = await list();
    await registerLocalWriter(engine, 'cli');
    await admitPut(engine, 'notes/queued', 'c0000000-0000-4000-8000-0000000000d1');
    const queued = await list();
    const answers = { recorded, empty, queued };
    const refused = 'activation id must be a uuid (8-4-4-4-12 hex digits): ';
    expect(answers).toEqual({ recorded: { bad: `${refused}"not-a-uuid"`, braces: `${refused}"{00000000-0000-8000-a000-0000000000c1}"`, upper: undefined },
      empty: ['00000000-0000-8000-A000-0000000000C2'], queued: ['00000000-0000-8000-A000-0000000000C2'] });
    return answers;
  });

  parityTest('a repair list since that is not an ISO instant with a zone', {
    methods: ['transaction', 'recordHeldGenerationRow', 'listHeldGenerationRows', 'listUnmatchedGenerationRows', 'listRestorableGenerationRows'],
  }, async (engine) => {
    await engine.transaction(tx => tx.recordHeldGenerationRow({ sourceId: 'default', kind: 'since_parity', ownerKey: 'input:s' }, held('h-since', '{}', '[]')));
    const answers: Record<string, unknown> = {};
    for (const since of ['9999-12-31T23:59:59.999999Z', '9999-12-31T23:00:00-02:00', '0001-01-01T00:30:00+01:00', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00Z', '2026-01-01 00:00:00+00', '2026-01-01T02:00:00+02:00', '2026-01-01',
      '2026-01-01 10:00', 'yesterday', 'garbage', '2026-02-30T00:00:00Z']) {
      const pattern = /since must be an ISO 8601 instant[^:]*: "[^"]*"/;
      answers[since] = {
        held: await outcome(async () => (await engine.listHeldGenerationRows(['default'], 'since_parity', { since })).length, pattern),
        unmatched: await outcome(async () => (await engine.listUnmatchedGenerationRows(['default'], 'since_parity', { since })).length, pattern),
        restorable: await outcome(async () => (await engine.listRestorableGenerationRows(['default'], 'since_parity', { since })).length, pattern),
      };
    }
    const refused = (since: string) => {
      const message = `since must be an ISO 8601 instant with a zone, for example 2026-10-01T00:00:00Z: "${since}"`;
      return { held: message, unmatched: message, restorable: message };
    };
    const none = { held: 0, unmatched: 0, restorable: 0 };
    const one = { held: 1, unmatched: 0, restorable: 0 };
    expect(answers).toEqual({ '9999-12-31T23:59:59.999999Z': none, '9999-12-31T23:00:00-02:00': refused('9999-12-31T23:00:00-02:00'),
      '0001-01-01T00:30:00+01:00': refused('0001-01-01T00:30:00+01:00'), '2026-01-01T00:00:00.000Z': one, '2026-01-01T00:00:00Z': one,
      '2026-01-01 00:00:00+00': one, '2026-01-01T02:00:00+02:00': one, '2026-01-01': refused('2026-01-01'), '2026-01-01 10:00': refused('2026-01-01 10:00'),
      yesterday: refused('yesterday'), garbage: refused('garbage'), '2026-02-30T00:00:00Z': refused('2026-02-30T00:00:00Z') });
    return answers;
  });

  parityTest('a generation JSON number past the double range refuses on every engine, before anything is written', {
    methods: ['transaction', 'recordHeldGenerationRow', 'activateGenerationRows', 'listHeldGenerationRows', 'readHeldGenerationContext',
      'readLiveGenerationRow'],
  }, async (engine) => {
    const key = (kind: string, ownerKey: string) => ({ sourceId: 'default', kind, ownerKey });
    const refused = /[^:]*: a JSON number in [a-z_]+ is past the double range/;
    const hold = (kind: string, context: string, proposal: string | null) =>
      outcome(() => engine.transaction(tx => tx.recordHeldGenerationRow(key(kind, 'input:h'), held(`h-${kind}`, context, proposal))), refused);
    const written = {
      context: await hold('huge_context', '{"n":1e400}', null),
      proposal: await hold('huge_proposal', '{}', '[1, -1e400]'),
      completeness: await outcome(() => engine.transaction(tx =>
        tx.activateGenerationRows(key('huge_completeness', 'page:notes/h'), null, activation(1, 'huge-op', '{"fence":1e309}'), [])), refused),
      largest: await hold('largest_context', '{"n":1.7976931348623157e308,"tiny":1e-400}', null),
    };
    const kept = {
      held: await Promise.all(['huge_context', 'huge_proposal'].map(async kind => (await engine.listHeldGenerationRows(['default'], kind, {})).length)),
      live: await engine.readLiveGenerationRow(key('huge_completeness', 'page:notes/h')),
      largest: await engine.readHeldGenerationContext(key('largest_context', 'input:h'), 'h-largest_context'),
    };
    const answers = { written, kept };
    expect(answers).toEqual({
      written: { context: 'recordHeldGenerationRow: a JSON number in held_context is past the double range',
        proposal: 'recordHeldGenerationRow: a JSON number in proposal is past the double range',
        completeness: 'activateGenerationRows: a JSON number in completeness is past the double range', largest: undefined },
      kept: { held: [0, 0], live: null, largest: { held_context: { n: 1.7976931348623157e308, tiny: 0 } } },
    });
    return answers;
  });

  parityTest('the fact rows adapter reads the before-state of the facts of one source, by id, once each', {
    methods: ['insertFacts', 'expireFact', 'readFactPreimages'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other-facts');
    const mk = (fact: string, extra: Record<string, unknown> = {}) => ({ fact, entity_slug: 'people/preimage-example', source: 'fence',
      source_markdown_slug: 'people/preimage-example', kind: 'fact' as const, visibility: 'world' as const, valid_from: new Date('2026-02-01T01:02:03.250Z'), ...extra });
    const { ids } = await engine.insertFacts([mk('Alpha', { row_num: 1 }), mk('Beta', { row_num: 2, attributed_to: 'user' }),
      mk('Gamma', { visibility: 'private', kind: 'event' })] as never, { source_id: 'default' });
    const { ids: [elsewhere] } = await engine.insertFacts([mk('Elsewhere', { row_num: 1 })] as never, { source_id: 'other-facts' });
    expect(await engine.expireFact(ids[1]!, { supersededBy: ids[0]!, at: new Date('2026-04-05T06:07:08.125Z') })).toBe(true);
    const names = new Map<number, string>([[ids[0]!, 'Alpha'], [ids[1]!, 'Beta'], [ids[2]!, 'Gamma'], [elsewhere!, 'Elsewhere']]);
    const name = (id: number | null) => (id == null ? null : names.get(id) ?? '<unknown-id>');
    const named = (rows: Awaited<ReturnType<typeof factPreimages>>) => rows.map(row => ({ ...row, id: name(row.id), superseded_by: name(row.superseded_by),
      consolidated_into: name(row.consolidated_into) }));
    const answers = {
      rows: named(await factPreimages(engine, 'default', [ids[2]!, ids[1]!, elsewhere!, ids[2]!, 2 ** 52])),
      other: named(await factPreimages(engine, 'other-facts', [ids[0]!, elsewhere!])),
      none: await factPreimages(engine, 'default', []),
      fraction: await outcome(() => engine.readFactPreimages('default', [1.5]), /fact ids must be whole numbers: 1\.5/),
    };
    expect(answers.rows.map(row => [row.id, row.fact])).toEqual([['Beta', 'Beta'], ['Gamma', 'Gamma']]);
    expect(answers.rows[0]).toMatchObject({ row_num: 2, superseded_by: 'Alpha', attributed_to: 'user', expired_at: '2026-04-05T06:07:08.125+00:00' });
    expect(answers.other.map(row => row.fact)).toEqual(['Elsewhere']);
    expect(answers.none).toEqual([]);
    expect(answers.fraction).toBe('fact ids must be whole numbers: 1.5');
    return answers;
  });
});
