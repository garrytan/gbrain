/**
 * BrainEngine parity — the generation ledger reads and writes answer PGLite's output on Postgres and on a Rust brain:
 * row order (source, kind, owner and item keys in byte order, never the database collation; generations in id order,
 * never heap order), jsonb number text as Postgres keeps it (`1.0`, `1.50`, `1.00` for `100e-2`) in the text scrub, a
 * JSON `null` held context, proposal or fence as a value (not SQL NULL), an activation id that is not a uuid, a
 * `--since` that is not an ISO instant with a zone, the fact before-states the fact rows adapter records and puts back,
 * the consolidation adapter's restored check and `tie` hold clear, the take rows adapter's before-states, and the
 * extracted facts adapter's page check, own-row read, next row number and retire, and the page rows the single-page and
 * synthesis adapters read (a single-page publish with no derivation, end to end).
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
import { takePreimages } from '../../src/core/generations/adapters/take-rows.ts';
import { EXTRACTED_FACTS_KIND, extractedFactsAdapter } from '../../src/core/generations/adapters/extracted-facts.ts';
import { DREAM_SUMMARY_KIND, dreamSummaryAdapter, publishSinglePage, singlePageOwnerKey } from '../../src/core/generations/adapters/single-page.ts';
import { SYNTHESIS_KIND, synthesisAdapter, synthesisOwnerKey } from '../../src/core/generations/adapters/synthesis.ts';
import { ATOM_KIND, atomGenerationAdapter, atomOwnerKey } from '../../src/core/generations/adapters/atoms.ts';
import { importPageItem } from '../../src/core/generations/adapters/page.ts';
import { admitWrite, completeWrite } from '../../src/core/persistence/journal.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { CONSOLIDATION_KIND, clearConsolidationTies, consolidationOwnerKey, consolidationRestored, factPreimages, restoreFactRow }
  from '../../src/core/generations/adapters/fact-rows.ts';

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
async function admitPut(engine: BrainEngine, slug: string, requestId: string, intent: Record<string, unknown> = { body: slug }) {
  const source = await engine.readSourceMembership('default');
  const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source!.incarnation, slug);
  return admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source!.incarnation, slug, requestId, callerIntent: intent, intent });
}

describe('engine parity: generation ledger output', () => {
  parityTest('listGenerationSourceIncarnations lists the source ids in byte order', {
    methods: ['listGenerationSourceIncarnations'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'ab');
    await createSource(engine, backend, 'a-z');
    const ids = (await engine.listGenerationSourceIncarnations(['ab', 'default', 'a-z', 'missing'])).map(row => row.id);
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

  parityTest('the fact rows adapter puts a before-state back only on the same claim and visibility, and moves only to a free fence number', {
    methods: ['insertFacts', 'expireFact', 'consolidateFact', 'readFactPreimages', 'restoreFactPreimage'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other-restore');
    const mk = (fact: string, row_num: number) => ({ fact, entity_slug: 'people/restore-example', source: 'fence', source_markdown_slug: 'people/restore-example',
      kind: 'fact' as const, visibility: 'world' as const, valid_from: new Date('2026-02-01T01:02:03.250Z'), row_num });
    const { ids: [alpha, beta] } = await engine.insertFacts([mk('Alpha', 1), mk('Beta', 2)] as never, { source_id: 'default' });
    const [before] = await factPreimages(engine, 'default', [alpha!]);
    expect(await engine.expireFact(alpha!, { supersededBy: beta!, at: new Date('2026-04-05T06:07:08.125Z') })).toBe(true);
    await engine.consolidateFact(alpha!, 77);
    const state = async () => {
      const [row] = await factPreimages(engine, 'default', [alpha!]);
      return { row_num: row!.row_num, expired_at: row!.expired_at, valid_until: row!.valid_until, superseded_by: row!.superseded_by === beta ? 'Beta' : row!.superseded_by,
        consolidated_at: row!.consolidated_at === null ? null : 'set', consolidated_into: row!.consolidated_into };
    };
    const base = before as unknown as Record<string, unknown>;
    const refused = async (run: () => Promise<unknown>) => outcome(run, /violates foreign key constraint "facts_superseded_by_fkey"/);
    const answers = {
      changed: await state(),
      otherClaim: await restoreFactRow(engine, 'default', { ...base, fact: 'Changed' }),
      otherVisibility: await restoreFactRow(engine, 'default', { ...base, visibility: 'private' }),
      otherSource: await restoreFactRow(engine, 'other-restore', base),
      missingSuccessor: await refused(() => restoreFactRow(engine, 'default', { ...base, superseded_by: 2 ** 40 })),
      afterRefusals: await state(),
      restored: await restoreFactRow(engine, 'default', base),
      back: await state(),
      takenNumber: await restoreFactRow(engine, 'default', { ...base, row_num: 2, valid_until: '2026-05-01T10:00:00.5+02:00' }),
      keptNumber: await state(),
      freeNumber: await restoreFactRow(engine, 'default', { ...base, row_num: 9 }),
      moved: await state(),
    };
    expect(answers.changed).toEqual({ row_num: 1, expired_at: '2026-04-05T06:07:08.125+00:00', valid_until: null, superseded_by: 'Beta', consolidated_at: 'set', consolidated_into: 77 });
    expect([answers.otherClaim, answers.otherVisibility, answers.otherSource]).toEqual([false, false, false]);
    expect(answers.missingSuccessor).toBe('violates foreign key constraint "facts_superseded_by_fkey"');
    expect(answers.afterRefusals).toEqual(answers.changed);
    expect(answers.restored).toBe(true);
    expect(answers.back).toEqual({ row_num: 1, expired_at: null, valid_until: null, superseded_by: null, consolidated_at: null, consolidated_into: null });
    expect(answers.takenNumber).toBe(true);
    expect(answers.keptNumber).toEqual({ ...answers.back, valid_until: '2026-05-01T08:00:00.5+00:00' });
    expect(answers.moved).toEqual({ ...answers.back, row_num: 9 });
    return answers;
  });

  parityTest('the consolidation adapter reads a restored live row and clears only its entity\'s tie holds', {
    methods: ['transaction', 'activateGenerationRows', 'readGenerationRestored', 'recordHeldGenerationRow', 'clearTieHeldGenerationRows', 'listFenceHoldRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other-ties');
    const key = { sourceId: 'default', kind: CONSOLIDATION_KIND, ownerKey: consolidationOwnerKey('people/tie-example', [2, 1]) };
    const restored = () => consolidationRestored(engine, 'default', 'people/tie-example', [1, 2]);
    const answers: Record<string, unknown> = { none: await restored() };
    const first = await engine.transaction(tx => tx.activateGenerationRows(key, null, activation(1, 'restore-first', '{}'), []));
    answers.plain = await restored();
    await engine.transaction(tx => tx.activateGenerationRows(key, first, { ...activation(2, 'restore-second', '{}'), restoreOf: first }, []));
    answers.restore = await restored();
    const hold = async (sourceId: string, kind: string, entity: string, ids: number[], reason: string) =>
      engine.transaction(tx => tx.recordHeldGenerationRow({ sourceId, kind, ownerKey: consolidationOwnerKey(entity, ids) },
        { ...held(`h-${sourceId}-${kind}-${entity}-${reason}`, '{}', null), reason }));
    await hold('default', CONSOLIDATION_KIND, 'people/tie-example', [1, 2], 'tie');
    await hold('default', CONSOLIDATION_KIND, 'people/tie-example', [3, 4], 'no_proof');
    await hold('default', CONSOLIDATION_KIND, 'people/tie-example-2', [5, 6], 'tie');
    await hold('default', 'fact-fence', 'people/tie-example', [7, 8], 'tie');
    await hold('other-ties', CONSOLIDATION_KIND, 'people/tie-example', [9, 10], 'tie');
    // Postgres compares left(owner_key, <JavaScript length>): a slug past the BMP counts 2 there and 1 in Postgres, so its tie stays.
    await hold('default', CONSOLIDATION_KIND, 'people/\u{1F600}', [11, 12], 'tie');
    await clearConsolidationTies(engine, 'default', 'people/tie-example');
    await clearConsolidationTies(engine, 'default', 'people/\u{1F600}');
    answers.left = (await engine.listFenceHoldRows(['default', 'other-ties'], [CONSOLIDATION_KIND, 'fact-fence']))
      .map(row => `${row.source_id} ${row.kind} ${row.owner_key} ${row.held_reason}`).sort();
    expect(answers).toEqual({ none: false, plain: false, restore: true, left: [
      'default consolidation entity:people/tie-example-2:cluster:5,6 tie',
      'default consolidation entity:people/tie-example:cluster:3,4 no_proof',
      'default consolidation entity:people/\u{1F600}:cluster:11,12 tie',
      'default fact-fence entity:people/tie-example:cluster:7,8 tie',
      'other-ties consolidation entity:people/tie-example:cluster:9,10 tie',
    ] });
    return answers;
  });

  parityTest('the take rows adapter reads the full before-state of each gone or replaced take, once per joined row, by row number', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'resolveTake', 'readTakePreimages'],
  }, async (engine) => {
    const page = await engine.putPage('people/take-preimage-example', { type: 'person', title: 't', compiled_truth: 'x', timeline: '' });
    const other = await engine.putPage('people/take-preimage-other', { type: 'person', title: 'o', compiled_truth: 'x', timeline: '' });
    const take = (page_id: number, row_num: number, claim: string, extra: Record<string, unknown> = {}) => ({ page_id, row_num, claim, kind: 'take', holder: 'garry', ...extra });
    await engine.addTakesBatch([take(page.id, 3, 'third', { weight: 0.7, since_date: '2026-01-10', source: 'meeting' }), take(page.id, 1, 'first'),
      take(page.id, 2, 'second', { kind: 'bet', weight: 0.35 }), take(other.id, 1, 'elsewhere')] as never);
    await engine.resolveTake(page.id, 2, { quality: 'incorrect', value: 0.125, unit: 'pct', source: 'report', resolvedBy: 'garry' });
    const rows = [...(await engine.listTakes({ page_id: page.id, active: true })), ...(await engine.listTakes({ page_id: page.id, active: false }))];
    const idOf = new Map(rows.map(row => [row.claim, row.id]));
    const claimOf = new Map(rows.map(row => [row.id, row.claim]));
    const shown = (preimage: Record<string, unknown>): Record<string, unknown> => {
      expect(typeof preimage.resolved_at === 'string' ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/.test(preimage.resolved_at) : preimage.resolved_at === null).toBe(true);
      return { ...preimage, id: claimOf.get(Number(preimage.id)) ?? '<unknown-id>', page_id: preimage.page_id === page.id ? 'page' : preimage.page_id,
        resolved_at: preimage.resolved_at === null ? null : 'set' };
    };
    const incoming = (row_num: number, claim: string, kind = 'take', holder = 'garry') => ({ rowNum: row_num, claim, kind, holder });
    const adapter = await takePreimages(engine, page.id, [idOf.get('first')!], [incoming(3, 'changed'), incoming(2, 'second', 'bet'), incoming(9, 'new')]);
    const byRow = await engine.readTakePreimages({ pageId: page.id, by: 'row_num', gone: [1, 2],
      incoming: [{ row_num: 1, claim: 'first', kind: 'take', holder: 'garry' }, { row_num: 1, claim: 'x', kind: 'take', holder: 'garry' },
        { row_num: 3, claim: 'third', kind: 'take', holder: 'someone' }] });
    const answers = {
      gone: adapter.gone.map(row => shown(row as unknown as Record<string, unknown>)),
      replaced: adapter.replaced.map(row => shown(row as unknown as Record<string, unknown>)),
      byRow: byRow.map(row => ({ claim: row.preimage.claim, gone: row.gone })),
      resolved: shown(byRow.find(row => row.preimage.row_num === 2)!.preimage as unknown as Record<string, unknown>),
      none: await takePreimages(engine, page.id, [], []),
      otherPage: (await engine.readTakePreimages({ pageId: other.id, by: 'id', gone: [idOf.get('first')!], incoming: [] })).length,
      fraction: await outcome(() => engine.readTakePreimages({ pageId: page.id, by: 'row_num', gone: [1.5], incoming: [] }), /take row numbers must be whole numbers in range: 1\.5/),
    };
    expect(answers.gone.map(row => row.claim)).toEqual(['first']);
    expect(answers.replaced).toEqual([{ id: 'third', page_id: 'page', row_num: 3, claim: 'third', kind: 'take', holder: 'garry', weight: 0.7, since_date: '2026-01-10',
      until_date: null, source: 'meeting', superseded_by: null, active: true, resolved_at: null, resolved_outcome: null, resolved_value: null, resolved_unit: null,
      resolved_source: null, resolved_by: null, resolved_quality: null }]);
    expect(answers.byRow).toEqual([{ claim: 'first', gone: true }, { claim: 'first', gone: true }, { claim: 'second', gone: true }, { claim: 'third', gone: false }]);
    expect(answers.resolved).toMatchObject({ kind: 'bet', weight: 0.35, resolved_at: 'set', resolved_outcome: false, resolved_value: 0.125, resolved_unit: 'pct',
      resolved_source: 'report', resolved_by: 'garry', resolved_quality: 'incorrect' });
    expect(answers.none).toEqual({ gone: [], replaced: [] });
    expect(answers.otherPage).toBe(0);
    expect(answers.fraction).toBe('take row numbers must be whole numbers in range: 1.5');
    return answers;
  });

  parityTest('the extracted facts adapter reads its own rows of a live page, numbers new rows after the page\'s last, and retires only its live rows', {
    methods: ['putPage', 'insertFacts', 'expireFact', 'getPage', 'listFactIdsBySourcePrefix', 'readFactPreimages', 'transaction', 'maxFenceRowNum', 'expireFactRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other-extracted');
    const slug = 'conversations/extracted-example';
    await engine.putPage(slug, { type: 'person', title: 'e', compiled_truth: 'x', timeline: '' });
    const key = { kind: EXTRACTED_FACTS_KIND, sourceId: 'default', ownerKey: `page:${slug}:conversation` };
    const input = { pin: 'p', size: 1 };
    const mk = (fact: string, source: string, extra: Record<string, unknown> = {}) => ({ fact, entity_slug: null, source, source_markdown_slug: slug,
      kind: 'fact' as const, visibility: 'private' as const, valid_from: new Date('2026-03-01T00:00:00Z'), ...extra });
    const { ids } = await engine.insertFacts([mk('Own live', 'cli:extract-conversation-facts', { row_num: 4 }), mk('Own gone', 'cli:extract-conversation-facts:run-1'),
      mk('Backstop', 'backstop:extracted-facts'), mk('Fence', 'fence', { row_num: 7 }), mk('Lookalike', 'cli:extract-conversationXfacts')] as never, { source_id: 'default' });
    await engine.insertFacts([mk('Elsewhere', 'cli:extract-conversation-facts', { row_num: 9 })] as never, { source_id: 'other-extracted' });
    expect(await engine.expireFact(ids[1]!, { at: new Date('2026-04-01T00:00:00Z') })).toBe(true);
    const claims = async () => (await factPreimages(engine, 'default', await engine.listFactIdsBySourcePrefix('default', slug, 'cli:extract-conversation-facts')))
      .map(row => `${row.fact} ${row.row_num ?? '-'} ${row.expired_at === null ? 'live' : 'expired'}`);
    const items = await extractedFactsAdapter.readItems(engine, key, []);
    const answers: Record<string, unknown> = {
      livePage: await extractedFactsAdapter.readInput(engine, key, { input }),
      absentPage: await extractedFactsAdapter.readInput(engine, { ...key, ownerKey: 'page:conversations/absent-example:conversation' }, { input }),
      items: [...items.values()].map(item => item.live).sort(),
      own: await claims(),
      backstop: (await engine.listFactIdsBySourcePrefix('default', slug, 'backstop:')).length,
    };
    await engine.transaction(tx => extractedFactsAdapter.publishItems(tx, key, [{ key: 'fact:new', identityHash: 'h',
      content: JSON.stringify({ fact: 'Added', kind: 'fact', visibility: 'private', entity_slug: null, source: 'cli:extract-conversation-facts', valid_from: '2026-05-01T00:00:00.000Z', valid_until: null }) }], { input }));
    answers.published = await claims();
    await engine.transaction(tx => extractedFactsAdapter.retireItems(tx, key, [...items.keys()], 'generation-restore'));
    answers.retired = await claims();
    await engine.expireFactRows('other-extracted', [ids[3]!]);
    answers.otherSource = (await factPreimages(engine, 'default', [ids[3]!]))[0]!.expired_at;
    answers.wildcard = await outcome(() => engine.listFactIdsBySourcePrefix('default', slug, 'cli:%'), /a source prefix must not hold %, _ or \\: "cli:%"/);
    answers.fraction = await outcome(() => engine.expireFactRows('default', [1.5]), /fact ids must be whole numbers: 1\.5/);
    expect(answers).toEqual({ livePage: input, absentPage: null, items: [false, true], own: ['Own live 4 live', 'Own gone - expired'], backstop: 1,
      published: ['Own live 4 live', 'Own gone - expired', 'Added 8 live'], retired: ['Own live 4 expired', 'Own gone - expired', 'Added 8 live'],
      otherSource: null, wildcard: 'a source prefix must not hold %, _ or \\: "cli:%"', fraction: 'fact ids must be whole numbers: 1.5' });
    return answers;
  });
  parityTest('the single-page and synthesis adapters read their page rows, deleted rows included, and a single-page publish versions the page it changes', {
    methods: ['readGenerationPageRows', 'readLiveGenerationRow', 'readPageSnapshot', 'createVersion', 'putPage', 'addTag', 'getPage', 'getVersions',
      'softDeletePage', 'transaction', 'activateGenerationRows'],
  }, async (engine) => {
    // Slugs of lowercase letters after one shared prefix, so byte order and en_US order agree.
    const slug = 'dream/summary';
    const page = (body: string) => ({ type: 'note', title: 'Summary', compiled_truth: body, frontmatter: { dream: 'summary' }, tags: ['zeta', 'alpha'] });
    const first = await publishSinglePage(engine, { kind: DREAM_SUMMARY_KIND, sourceId: 'default', slug, page: page('one'), expectedRevision: null });
    const revision = (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))!.revision;
    const second = await publishSinglePage(engine, { kind: DREAM_SUMMARY_KIND, sourceId: 'default', slug, page: page('two'), expectedRevision: revision });
    const stale = await outcome(() => publishSinglePage(engine, { kind: DREAM_SUMMARY_KIND, sourceId: 'default', slug, page: page('three'), expectedRevision: revision }),
      /its input changed after the producer read it/);
    const singleKey = { kind: DREAM_SUMMARY_KIND, sourceId: 'default', ownerKey: singlePageOwnerKey(slug) };
    const single = [...(await dreamSummaryAdapter.readItems(engine, singleKey, [slug])).values()];
    const stored = await engine.getPage(slug);
    const versions = (await engine.getVersions(slug)).map(v => v.compiled_truth);

    // Synthesis: the recorded key of the live generation, a live output of the locator, a listed key, and outputs it skips.
    const dream = (rawSource: string, generated: unknown) => ({ type: 'note' as const, title: 'out', compiled_truth: 'o', timeline: '',
      frontmatter: { raw_source: rawSource, dream_generated: generated } });
    await engine.putPage('synth/recorded', dream('old.md', true));
    await engine.putPage('synth/current', dream('loc.md', true));
    await engine.putPage('synth/listed', dream('loc.md', 'yes'));
    await engine.putPage('synth/textual', dream('loc.md', 'true'));
    await engine.putPage('synth/elsewhere', dream('other.md', true));
    await engine.putPage('synth/gone', dream('loc.md', true));
    await engine.softDeletePage('synth/gone');
    const synthKey = { kind: SYNTHESIS_KIND, sourceId: 'default', ownerKey: synthesisOwnerKey('root/transcript.md') };
    await engine.transaction(tx => tx.activateGenerationRows(synthKey, null, activation(1, 'synth-1', '{}'), ledger(['synth/recorded'])));
    const context = { locator: 'loc.md', transcriptInput: { pin: 'p', size: 1 } };
    const items = async (keys: string[], locator: string | null) =>
      [...(await synthesisAdapter.readItems(engine, synthKey, keys, { ...context, locator: locator as string })).values()]
        .map(item => `${item.key} ${item.live ? 'live' : 'deleted'} ${item.owned ? 'owned' : 'not-owned'}`);
    const answers: Record<string, unknown> = {
      first: first.outcome.state, second: second.outcome.state, pageIds: first.pageId === second.pageId && typeof first.pageId === 'number', stale,
      single: single.map(item => `${item.key} ${item.live} ${item.owned} ${item.segmented} ${item.identityHash.length}`),
      preimage: single[0]!.preimage().json,
      stored: { body: stored?.compiled_truth, frontmatter: stored?.frontmatter }, versions,
      synthesis: await items(['synth/listed', 'synth/gone'], 'loc.md'),
      noLocator: await items([], null),
      absent: [...(await dreamSummaryAdapter.readItems(engine, { ...singleKey, ownerKey: singlePageOwnerKey('dream/absent') }, [])).keys()],
    };
    expect(answers).toEqual({
      first: 'published', second: 'published', pageIds: true, stale: 'its input changed after the producer read it',
      single: ['dream/summary true true false 64'],
      preimage: { slug, type: 'note', title: 'Summary', compiled_truth: 'two', timeline: '', frontmatter: { dream: 'summary' }, tags: ['alpha', 'zeta'], deleted: false },
      stored: { body: 'two', frontmatter: { dream: 'summary' } }, versions: ['one'],
      synthesis: ['synth/current live owned', 'synth/gone deleted owned', 'synth/listed live not-owned', 'synth/recorded live owned',
        'synth/textual live not-owned'],
      noLocator: ['synth/recorded live owned'],
      absent: [],
    });
    return answers;
  });
  parityTest('the atom adapter reads its page origin input, its atom rows, and the version and receipt evidence of atoms written before the ledger', {
    methods: ['readAtomOriginInput', 'readGenerationPageRows', 'listProducerVersionRows', 'listAtomWriteReceipts', 'putPage', 'getPage', 'createVersion',
      'transaction', 'readSourceMembership', 'stampWriteClaim', 'recordGenerationActivation', 'activateGenerationRows', 'markGenerationActivated'],
  }, async (engine) => {
    // Slugs of lowercase letters after one shared prefix, so byte order and en_US order agree.
    const origin = 'notes/origin';
    await engine.putPage(origin, { type: 'note', title: 'Origin', compiled_truth: 'héllo', timeline: 'ab' });
    const key = { kind: ATOM_KIND, sourceId: 'default', ownerKey: atomOwnerKey({ kind: 'page', slug: origin }) };
    const atom = (slug: string, by: string) => serializeMarkdown({ source_slug: origin, extracted_by: by }, `${slug} body`, '', { type: 'atom', title: slug, tags: [] });
    const imported = (slug: string, by: string) => engine.transaction(tx => importPageItem(tx, 'default', slug, atom(slug, by)));
    // Version evidence: an unedited extractor version (its live page later stamped private), an edited one, another producer's.
    await imported('atoms/versioned', 'extract_atoms:v1');
    await engine.createVersion('atoms/versioned');
    const live = (await engine.getPage('atoms/versioned'))!;
    await engine.putPage('atoms/versioned', { type: live.type, title: live.title, compiled_truth: live.compiled_truth, timeline: live.timeline,
      frontmatter: { ...live.frontmatter, visibility: 'private' } });
    await imported('atoms/edited', 'extract_atoms');
    await engine.createVersion('atoms/edited');
    await engine.putPage('atoms/edited', { type: 'atom', title: 'edited', compiled_truth: 'edited by hand', frontmatter: { source_slug: origin, extracted_by: 'extract_atoms' } });
    await imported('atoms/lookalike', 'xextract_atoms');
    await engine.createVersion('atoms/lookalike');
    // Receipt evidence: a committed managed atom write, one whose activation activated, one whose activation never did.
    const activationKey = { sourceId: 'default', kind: ATOM_KIND, ownerKey: 'source_slug:notes/elsewhere' };
    const record = (activationId: string) => engine.transaction(tx => tx.recordGenerationActivation(activationKey,
      { activationId, expectedGeneration: 0, inputPin: 'p', setHash: 'h', members: [] }));
    await record('00000000-0000-8000-a000-0000000000c1');
    await record('00000000-0000-8000-a000-0000000000c2');
    const generation = await engine.transaction(tx => tx.activateGenerationRows(activationKey, null,
      activation(1, 'atom-act', '{}', '00000000-0000-8000-a000-0000000000c1'), ledger(['atoms/elsewhere'])));
    await engine.markGenerationActivated('00000000-0000-8000-a000-0000000000c1', generation);
    const receipt = async (slug: string, requestId: string, activationId?: string) => {
      const content = atom(slug, 'extract_atoms');
      await engine.transaction(tx => importPageItem(tx, 'default', slug, content));
      const admitted = await admitPut(engine, slug, requestId, { kind: 'managed_atom_page', content, ...(activationId ? { activationId } : {}) });
      const claimed = await engine.stampWriteClaim(admitted.id, 'c0000000-0000-4000-8000-0000000000c1', 60_000, JSON.stringify({ phase: 'parity' }));
      await engine.transaction(tx => completeWrite(tx, claimed as WriteRequest, 'committed', { slug }));
    };
    await registerLocalWriter(engine, 'cli');
    await receipt('atoms/receipt', 'b0000000-0000-4000-8000-0000000000e1');
    await receipt('atoms/activated', 'b0000000-0000-4000-8000-0000000000e2', '00000000-0000-8000-a000-0000000000c1');
    await receipt('atoms/pending', 'b0000000-0000-4000-8000-0000000000e3', '00000000-0000-8000-a000-0000000000c2');
    const input = await atomGenerationAdapter.readInput(engine, key, undefined);
    const stored = (await engine.getPage(origin))!;
    const items = await atomGenerationAdapter.readItems(engine, key, [], undefined);
    const rows = [...items.values()].sort((a, b) => a.key < b.key ? -1 : 1);
    const evidence = await atomGenerationAdapter.legacyEvidence(engine, key, rows);
    const answers = {
      input: { size: input?.size, hash: input?.pin.startsWith(`${stored.content_hash}:${stored.id}:`), parts: input?.pin.split(':').length },
      absent: await atomGenerationAdapter.readInput(engine, { ...key, ownerKey: atomOwnerKey({ kind: 'page', slug: 'notes/absent' }) }, undefined),
      items: rows.map(row => `${row.key} ${row.live} ${row.owned}`),
      evidence: [...evidence].sort(),
      noRows: [...await atomGenerationAdapter.legacyEvidence(engine, key, [])],
      producer: await outcome(() => engine.listProducerVersionRows('default', ['atoms/versioned'], 'synthetic' as never), /not a version producer: "synthetic"/),
    };
    expect(answers).toEqual({
      input: { size: 8, hash: true, parts: 3 },
      absent: null,
      items: ['atoms/activated true true', 'atoms/edited true true', 'atoms/lookalike true true', 'atoms/pending true true', 'atoms/receipt true true',
        'atoms/versioned true true'],
      evidence: ['atoms/activated', 'atoms/receipt', 'atoms/versioned'],
      noRows: [],
      producer: 'not a version producer: "synthetic"',
    });
    return answers;
  });
});
