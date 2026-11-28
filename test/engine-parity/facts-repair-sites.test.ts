/**
 * BrainEngine parity: the facts statements the repair commands, three doctor checks and the fact write path ran through
 * `executeRaw` (engine-sql/facts-repair.ts, facts-doctor.ts, facts-trust.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listActiveSourceIds, listUnarchivedSourceRows, readRepairBrainId, listAgentSessionTakeCandidates,
 *    listSettledSessionFacts, reattributeSessionFacts, retireSessionTakes, listInactiveTakeIds, listFenceRewriteRows,
 *    listOtherAttributedFactIds, expireCapturedFacts, listExpiredFactIds, listPagelessEntityFacts, listSourceIncarnations,
 *    readEntityRehomeState, rehomeEntityFacts, countSegmentedCensusPages, listFactsPageBodies, readFactTableCatalog,
 *    readFactEntitySlugById, readSupersessionReplacement, linkSupersededFact, listLivePageTitles, listPageAliasNames,
 *    listCaptureDuplicateCandidates, computeFactFingerprints, listClaimConflictPairs and countClaimConflictPairs return the
 *    same observable result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes what `gbrain repair agent-session-facts`,
 *    `captured-facts` and `facts-rehome` preview and apply, what the fence_integrity, facts_undated_lines and unlinked_facts
 *    doctor checks report, which fact a write supersedes or drops as a duplicate, and which claim conflicts the dream cycle
 *    proposes; the Rust engine has no SQL, so each read and write has to exist as a typed member it can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call (D18), so
 *    no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: sources are created through createSource/archiveSource (harness.ts), as the other facts parity files do. Every
 *    fact, page, take, alias and consolidation is seeded through typed members. A page stored in segments comes from
 *    createSegmentedPageShell, so countSegmentedCensusPages and listFactsPageBodies are compared with segmented pages too. Generated values (ids, timestamps, the brain id, a source incarnation) are
 *    compared by relation or by shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { pageMeta } from '../helpers/page-body-fixtures.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { AUDIT_ROW_SOURCES } from '../../src/core/facts/audit-sources.ts';

const { parityTest } = parityArms(testBackends());

const LANE = 'hook:agent-session';
const EXTRACTOR = 'cli:extract-conversation-facts';
const NOTE = 'speaker: someone else';
const SEPARATOR = ' | ';

const note = (title: string, body = 'body', type = 'note') => ({ type: type as 'note', title, compiled_truth: body, frontmatter: {} });

/** The next fence row number of each engine, so every arm numbers its rows alike. */
const rows = new WeakMap<BrainEngine, number>();
function nextRow(engine: BrainEngine): number {
  const n = (rows.get(engine) ?? 0) + 1;
  rows.set(engine, n);
  return n;
}

/** One fact through the typed `insertFact`; `extra` overrides the defaults. Returns the id as a number. */
async function fact(engine: BrainEngine, text: string, extra: Record<string, unknown> = {}, sourceId = 'default'): Promise<number> {
  const out = await engine.insertFact({ fact: text, entity_slug: null, visibility: 'private', source: LANE, embedding: null, ...extra } as NewFact, { source_id: sourceId });
  expect(out.status).toBe('inserted');
  return Number(out.id);
}

/** A fact held by a page's fence: `insertFacts` keeps `row_num` and `source_markdown_slug`. */
async function fenced(engine: BrainEngine, text: string, extra: Record<string, unknown> = {}, sourceId = 'default'): Promise<number> {
  const res = await engine.insertFacts([{ fact: text, entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', row_num: nextRow(engine), ...extra }] as never, { source_id: sourceId });
  return Number(res.ids[0]);
}

/** Maps generated ids back to the names a case gave them. */
const namer = (names: Record<string, number>) => {
  const byId = new Map(Object.entries(names).map(([name, id]) => [id, name]));
  return (id: number | string) => byId.get(Number(id)) ?? `unknown:${id}`;
};

describe('engine parity: facts repair, doctor and trust statements that left executeRaw', () => {
  parityTest('listActiveSourceIds and listUnarchivedSourceRows list the sources that are not archived, by id', {
    methods: ['listActiveSourceIds', 'listUnarchivedSourceRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'zeta');
    await createSource(engine, backend, 'alpha');
    await createSource(engine, backend, 'retired');
    await archiveSource(engine, backend, 'retired');
    const active = await engine.listActiveSourceIds();
    const unarchived = await engine.listUnarchivedSourceRows();
    expect(active.map(r => r.id)).toEqual(['alpha', 'default', 'zeta']);
    expect(unarchived.map(r => r.id)).toEqual(['alpha', 'default', 'zeta']);
    return { active, unarchived };
  });

  parityTest('readRepairBrainId reads the brain id the repair preview hashes, the one readPersistenceBrainId reads, or null', {
    methods: ['readRepairBrainId', 'readPersistenceBrainId'],
  }, async (engine) => {
    const id = await engine.readRepairBrainId();
    expect(id).toBe(await engine.readPersistenceBrainId());
    const shape = { string: typeof id === 'string', length: typeof id === 'string' ? id.length : null };
    expect(shape.string || id === null).toBe(true);
    return shape;
  });

  parityTest('listAgentSessionTakeCandidates groups the consolidated facts of each take, noted or not; retireSessionTakes retires the takes with no user fact', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'insertFact', 'consolidateFact', 'listAgentSessionTakeCandidates', 'retireSessionTakes', 'listInactiveTakeIds'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const page = await engine.putPage('notes/takes', note('Takes'));
    const take = (row_num: number, claim: string) => ({ page_id: page.id, row_num, claim, kind: 'fact' as const, holder: 'self' });
    await engine.addTakesBatch([take(1, 'noted take'), take(2, 'other only take'), take(3, 'user take'), take(4, 'unconsolidated take')]);
    const takes = await engine.listTakes({ page_id: page.id });
    const takeId = (claim: string) => Number(takes.find(t => t.claim === claim)!.id);
    const noted = takeId('noted take'), otherOnly = takeId('other only take'), userTake = takeId('user take');
    const a1 = await fact(engine, 'a1', { attributed_to: 'user' });
    const a2 = await fact(engine, 'a2', { attributed_to: 'other', context: `heard ${NOTE}` });
    const b1 = await fact(engine, 'b1', { attributed_to: 'other' });
    const c1 = await fact(engine, 'c1');
    const elsewhere = await fact(engine, 'elsewhere', { attributed_to: 'user' }, 'other');
    for (const [id, take] of [[a1, noted], [a2, noted], [b1, otherOnly], [c1, userTake], [elsewhere, userTake]] as const) await engine.consolidateFact(id, take);
    const takeName = (id: number | string) => ({ [noted]: 'noted', [otherOnly]: 'other-only', [userTake]: 'user' } as Record<number, string>)[Number(id)] ?? `unknown:${id}`;
    const factName = namer({ a1, a2, b1, c1, elsewhere });
    const view = (list: Awaited<ReturnType<BrainEngine['listAgentSessionTakeCandidates']>>) => list.map(r => ({
      take: takeName(r.id), slug: r.slug, row_num: Number(r.row_num), claim: r.claim, source_id: r.source_id,
      facts: r.fact_ids.map(factName), user_facts: r.user_fact_ids.map(factName), noted: r.noted }));
    const all = view(await engine.listAgentSessionTakeCandidates(['default'], null, NOTE));
    expect(all).toEqual([
      { take: 'noted', slug: 'notes/takes', row_num: 1, claim: 'noted take', source_id: 'default', facts: ['a1', 'a2'], user_facts: ['a1'], noted: true },
      { take: 'other-only', slug: 'notes/takes', row_num: 2, claim: 'other only take', source_id: 'default', facts: ['b1'], user_facts: [], noted: false },
      { take: 'user', slug: 'notes/takes', row_num: 3, claim: 'user take', source_id: 'default', facts: ['c1'], user_facts: ['c1'], noted: false },
    ]);
    const named = view(await engine.listAgentSessionTakeCandidates(['default'], [otherOnly, 999_999], NOTE));
    expect(named.map(r => r.take)).toEqual(['other-only']);
    const noSource = await engine.listAgentSessionTakeCandidates([], null, NOTE);
    expect(noSource).toEqual([]);

    const retired = (await engine.retireSessionTakes('default', [noted, otherOnly, userTake])).map(r => takeName(r.id));
    expect(retired).toEqual(['other-only']);
    const wrongSource = await engine.retireSessionTakes('other', [noted]);
    expect(wrongSource).toEqual([]);
    const inactive = (await engine.listInactiveTakeIds([noted, otherOnly, userTake])).map(r => takeName(r.id));
    expect(inactive).toEqual(['other-only']);
    const after = view(await engine.listAgentSessionTakeCandidates(['default'], null, NOTE));
    expect(after.map(r => r.take)).toEqual(['noted', 'user']);
    return { all, named, noSource, retired, wrongSource, inactive, after };
  });

  parityTest('reattributeSessionFacts re-attributes the active user facts without a fence row, appending the note once; listSettledSessionFacts reads them', {
    methods: ['insertFact', 'insertFacts', 'expireFact', 'reattributeSessionFacts', 'listSettledSessionFacts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const plain = await fact(engine, 'plain', { attributed_to: 'user', context: 'ctx' });
    const bare = await fact(engine, 'bare', { attributed_to: 'user' });
    const unset = await fact(engine, 'unset', { context: 'kept' });
    const already = await fact(engine, 'already', { attributed_to: 'user', context: `said ${NOTE}` });
    const settled = await fact(engine, 'settled', { attributed_to: 'other', context: 'earlier' });
    const fencedFact = await fenced(engine, 'fenced', { attributed_to: 'user', source_markdown_slug: 'notes/a', source: LANE });
    const gone = await fact(engine, 'gone', { attributed_to: 'user' });
    expect(await engine.expireFact(gone)).toBe(true);
    const away = await fact(engine, 'away', { attributed_to: 'user' }, 'other');
    const name = namer({ plain, bare, unset, already, settled, fencedFact, gone, away });
    const facts = [plain, bare, unset, already, settled, fencedFact, gone, away].map(id => ({ id, note: NOTE }));
    const changed = (await engine.reattributeSessionFacts('default', facts, SEPARATOR)).map(r => name(r.id)).sort();
    expect(changed).toEqual(['already', 'bare', 'plain', 'unset']);
    const none = await engine.reattributeSessionFacts('default', [], SEPARATOR);
    expect(none).toEqual([]);
    const read = (await engine.listSettledSessionFacts('default', facts.map(f => f.id))).map(r => ({ fact: name(r.id), context: r.context }))
      .sort((a, b) => a.fact.localeCompare(b.fact));
    expect(read).toEqual([
      { fact: 'already', context: `said ${NOTE}` },
      { fact: 'bare', context: NOTE },
      { fact: 'plain', context: `ctx${SEPARATOR}${NOTE}` },
      { fact: 'settled', context: 'earlier' },
      { fact: 'unset', context: `kept${SEPARATOR}${NOTE}` },
    ]);
    const empty = await engine.listSettledSessionFacts('default', []);
    expect(empty).toEqual([]);
    return { changed, none, read, empty };
  });

  parityTest('listFenceRewriteRows, expireCapturedFacts and listExpiredFactIds answer for the named facts of one source', {
    methods: ['insertFact', 'insertFacts', 'expireFact', 'listFactsByEntity', 'listFenceRewriteRows', 'expireCapturedFacts', 'listExpiredFactIds'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const f1 = await fenced(engine, 'fence one', { source_markdown_slug: 'notes/a', entity_slug: 'people/x', attributed_to: 'other' });
    const f2 = await fenced(engine, 'fence two', { source_markdown_slug: 'notes/a', entity_slug: 'people/x' });
    const f3 = await fenced(engine, 'fence three', { source_markdown_slug: 'notes/b' }, 'other');
    const f4 = await fenced(engine, 'fence four', { source_markdown_slug: 'notes/a', entity_slug: 'people/x' });
    expect(await engine.expireFact(f4)).toBe(true);
    const g1 = await fact(engine, 'db one', { entity_slug: 'people/x', context: 'was' });
    const g2 = await fact(engine, 'db two', { entity_slug: 'people/x' });
    const g3 = await fact(engine, 'db three', { entity_slug: 'people/x', attributed_to: 'other' });
    const away = await fact(engine, 'db away', { entity_slug: 'people/x' }, 'other');
    const name = namer({ f1, f2, f3, f4, g1, g2, g3, away });
    const all = [f1, f2, f3, f4, g1, g2, g3, away];
    const rewrite = (await engine.listFenceRewriteRows('default', all)).map(r => ({ id: name(r.id), fact: r.fact, row_num: r.row_num === null ? null : 1 }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(rewrite).toEqual([
      { id: 'f1', fact: 'fence one', row_num: 1 }, { id: 'f2', fact: 'fence two', row_num: 1 },
      { id: 'g1', fact: 'db one', row_num: null }, { id: 'g2', fact: 'db two', row_num: null }, { id: 'g3', fact: 'db three', row_num: null },
    ]);
    const expired = (await engine.expireCapturedFacts('default', [g1, g2, f2, away, g3], 'expired by repair')).map(r => name(r.id)).sort();
    expect(expired).toEqual(['g1', 'g2', 'g3']);
    const again = await engine.expireCapturedFacts('default', [g1, g2], 'expired by repair');
    expect(again).toEqual([]);
    const contexts = (await engine.listFactsByEntity('default', 'people/x', { activeOnly: false })).filter(r => [g1, g2].includes(Number(r.id)))
      .map(r => ({ fact: name(r.id), context: r.context, expired: r.expired_at !== null })).sort((a, b) => a.fact.localeCompare(b.fact));
    expect(contexts).toEqual([{ fact: 'g1', context: 'expired by repair | was', expired: true }, { fact: 'g2', context: 'expired by repair', expired: true }]);
    const listed = (await engine.listExpiredFactIds('default', all)).map(r => name(r.id)).sort();
    expect(listed).toEqual(['f4', 'g1', 'g2', 'g3']);
    const none = await engine.listExpiredFactIds('default', []);
    expect(none).toEqual([]);
    return { rewrite, expired, again, contexts, listed, none };
  });

  parityTest('listOtherAttributedFactIds names the named facts of one source that another speaker holds', {
    methods: ['insertFact', 'insertFacts', 'listOtherAttributedFactIds'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const f1 = await fenced(engine, 'fence one', { source_markdown_slug: 'notes/a', entity_slug: 'people/x', attributed_to: 'other' });
    const f2 = await fenced(engine, 'fence two', { source_markdown_slug: 'notes/a', entity_slug: 'people/x' });
    const g1 = await fact(engine, 'db one', { entity_slug: 'people/x', context: 'was' });
    const g3 = await fact(engine, 'db three', { entity_slug: 'people/x', attributed_to: 'other' });
    const away = await fact(engine, 'db away', { entity_slug: 'people/x', attributed_to: 'other' }, 'other');
    const name = namer({ f1, f2, g1, g3, away });
    const other = (await engine.listOtherAttributedFactIds('default', [f1, f2, g1, g3, away])).map(r => name(r.id)).sort();
    expect(other).toEqual(['f1', 'g3']);
    return { other };
  });

  parityTest('listPagelessEntityFacts, listSourceIncarnations, readEntityRehomeState and rehomeEntityFacts move the database-only facts of a page-less entity', {
    methods: ['putPage', 'softDeletePage', 'insertFact', 'insertFacts', 'listFactsByEntity', 'listPagelessEntityFacts', 'listSourceIncarnations', 'readEntityRehomeState', 'rehomeEntityFacts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('people/real', note('Real'));
    await engine.putPage('people/removed', note('Removed'));
    await engine.softDeletePage('people/removed');
    const d1 = await fact(engine, 'ghost one', { entity_slug: 'people/ghost' });
    const d2 = await fact(engine, 'ghost two', { entity_slug: 'people/ghost' });
    const fx = await fenced(engine, 'ghost fenced', { entity_slug: 'people/ghost', source_markdown_slug: 'notes/a' });
    const rm = await fact(engine, 'removed one', { entity_slug: 'people/removed' });
    const ro = await fact(engine, 'real one', { entity_slug: 'people/real' });
    await fact(engine, 'no entity');
    const o1 = await fact(engine, 'other ghost', { entity_slug: 'people/ghost' }, 'other');
    const name = namer({ d1, d2, fx, rm, o1, ro });
    const view = (list: Awaited<ReturnType<BrainEngine['listPagelessEntityFacts']>>) =>
      list.map(r => ({ source_id: r.source_id, slug: r.slug, ids: (r.ids ?? []).map(name), fenced: Number(r.fenced) }));
    const pageless = view(await engine.listPagelessEntityFacts(['other', 'default']));
    expect(pageless).toEqual([
      { source_id: 'default', slug: 'people/ghost', ids: ['d1', 'd2'], fenced: 1 },
      { source_id: 'default', slug: 'people/removed', ids: ['rm'], fenced: 0 },
      { source_id: 'other', slug: 'people/ghost', ids: ['o1'], fenced: 0 },
    ]);
    const scoped = view(await engine.listPagelessEntityFacts(['other']));
    expect(scoped.map(r => r.ids)).toEqual([['o1']]);
    const noSources = await engine.listPagelessEntityFacts([]);
    expect(noSources).toEqual([]);
    const incarnations = (await engine.listSourceIncarnations(['other', 'default', 'missing'])).map(r => ({ id: r.id, text: typeof r.incarnation === 'string' && r.incarnation.length > 0 }));
    expect(incarnations).toEqual([{ id: 'default', text: true }, { id: 'other', text: true }]);
    const state = async (from: string, to: string) => {
      const row = await engine.readEntityRehomeState('default', from, to);
      return row ? { from_live: row.from_live, to_live: row.to_live, ids: (row.ids ?? []).map(name) } : null;
    };
    const before = await state('people/ghost', 'people/real');
    expect(before).toEqual({ from_live: false, to_live: true, ids: ['d1', 'd2'] });
    const live = await state('people/real', 'people/ghost');
    expect(live).toEqual({ from_live: true, to_live: false, ids: ['ro'] });
    const removedTarget = await state('people/ghost', 'people/removed');
    expect(removedTarget).toEqual({ from_live: false, to_live: false, ids: ['d1', 'd2'] });
    await engine.rehomeEntityFacts('default', 'people/ghost', 'people/real');
    const moved = (await engine.listFactsByEntity('default', 'people/real')).map(r => name(r.id)).sort();
    expect(moved).toEqual(['d1', 'd2', 'ro']);
    const left = view(await engine.listPagelessEntityFacts(['default', 'other']));
    expect(left).toEqual([
      { source_id: 'default', slug: 'people/ghost', ids: [], fenced: 1 },
      { source_id: 'default', slug: 'people/removed', ids: ['rm'], fenced: 0 },
      { source_id: 'other', slug: 'people/ghost', ids: ['o1'], fenced: 0 },
    ]);
    return { pageless, scoped, noSources, incarnations, before, live, removedTarget, moved, left };
  });

  parityTest('rehomeEntityFacts refuses a move that would give two facts one ontology key, and moves none of them', {
    methods: ['putPage', 'insertFact', 'mergeOntologyFact', 'listFactsByEntity', 'rehomeEntityFacts'],
  }, async (engine) => {
    await engine.putPage('people/new', note('New'));
    const observe = async (entity: string) => Number((await engine.mergeOntologyFact({
      entitySlug: entity, dimension: 'location', value: 'Lisbon', source: 'meetings/a', validFrom: '2026-01-01T00:00:00.000Z',
    } as never)).factId);
    const held = await observe('people/new');
    const free = await fact(engine, 'free', { entity_slug: 'people/old' });
    const colliding = await observe('people/old');
    const name = namer({ held, free, colliding });
    let rejected: string | null = null;
    try { await engine.rehomeEntityFacts('default', 'people/old', 'people/new'); } catch (error) { rejected = String((error as Error).message); }
    expect(rejected).toContain('idx_facts_ontology_stint_dedup');
    const at = async (slug: string) => (await engine.listFactsByEntity('default', slug, { activeOnly: false })).map(r => name(r.id)).sort();
    const stayed = { old: await at('people/old'), new: await at('people/new') };
    expect(stayed).toEqual({ old: ['colliding', 'free'], new: ['held'] });
    return { rejected: rejected !== null, stayed };
  });

  parityTest('rehomeEntityFacts expires a moved fact a withdrawal reaches on the new entity, and moves the others open', {
    methods: ['putPage', 'insertFact', 'insertFactWithdrawal', 'listFactsByEntity', 'rehomeEntityFacts'],
  }, async (engine) => {
    await engine.putPage('people/real', note('Real'));
    const reached = await fact(engine, 'Ghost likes tea', { entity_slug: 'people/ghost' });
    const otherClaim = await fact(engine, 'Ghost likes jam', { entity_slug: 'people/ghost' });
    const otherTier = await fact(engine, 'Ghost likes tea', { entity_slug: 'people/ghost', visibility: 'world' });
    const when = '2026-03-01T12:34:56.000Z';
    expect(await engine.insertFactWithdrawal('default', 'private', 'Ghost likes tea', 'people/real', when)).toBe(true);
    expect(await engine.insertFactWithdrawal('default', 'private', 'Ghost likes jam', 'people/elsewhere', when)).toBe(true);
    await engine.rehomeEntityFacts('default', 'people/ghost', 'people/real');
    const name = namer({ reached, otherClaim, otherTier });
    const moved = (await engine.listFactsByEntity('default', 'people/real', { activeOnly: false }))
      .map(r => ({ fact: name(r.id), expired: r.expired_at !== null, until: r.valid_until ? new Date(r.valid_until).toISOString() : null }))
      .sort((a, b) => a.fact.localeCompare(b.fact));
    expect(moved).toEqual([
      { fact: 'otherClaim', expired: false, until: null },
      { fact: 'otherTier', expired: false, until: null },
      { fact: 'reached', expired: true, until: when },
    ]);
    return { moved };
  });

  parityTest('countSegmentedCensusPages counts none on a brain that stores no page in segments', { methods: ['putPage', 'countSegmentedCensusPages'] }, async (engine) => {
    await engine.putPage('notes/whole', note('Whole'));
    const counted = await engine.countSegmentedCensusPages(['default'], []);
    const none = await engine.countSegmentedCensusPages([], ['default']);
    expect(counted).toEqual({ n: 0 });
    expect(none).toEqual({ n: 0 });
    return { counted, none };
  });

  parityTest('listFactsPageBodies lists the live facts pages by source and slug with their body, never a deleted or other page', {
    methods: ['putPage', 'softDeletePage', 'listFactsPageBodies'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('me/facts', note('Me', '- 2026-01-01 born\n- undated line', 'facts'));
    await engine.putPage('company/facts', note('Company', '- 2026-02-02 founded', 'facts'));
    await engine.putPage('gone/facts', note('Gone', '- gone', 'facts'));
    await engine.softDeletePage('gone/facts');
    await engine.putPage('notes/plain', note('Plain', '- not a facts page'));
    await engine.putPage('me/facts', note('Elsewhere', '- elsewhere line', 'facts'), { sourceId: 'other' });
    const listed = (await engine.listFactsPageBodies()).map(r => ({ source_id: r.source_id, slug: r.slug, segmented: r.segmented, body: r.body }));
    expect(listed).toEqual([
      { source_id: 'default', slug: 'company/facts', segmented: false, body: '- 2026-02-02 founded' },
      { source_id: 'default', slug: 'me/facts', segmented: false, body: '- 2026-01-01 born\n- undated line' },
      { source_id: 'other', slug: 'me/facts', segmented: false, body: '- elsewhere line' },
    ]);
    return listed;
  });

  parityTest('countSegmentedCensusPages counts the live segmented markdown pages of the sources that no walked file covers', {
    methods: ['putPage', 'createSegmentedPageShell', 'softDeletePage', 'countSegmentedCensusPages'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/whole', note('Whole'));
    await engine.createSegmentedPageShell('notes/seg-a', pageMeta('Seg A'), { sourceId: 'default' });
    await engine.createSegmentedPageShell('notes/seg-b', pageMeta('Seg B'), { sourceId: 'default' });
    await engine.createSegmentedPageShell('notes/seg-c', pageMeta('Seg C'), { sourceId: 'other' });
    const counts = {
      unwalked: await engine.countSegmentedCensusPages(['default'], []),
      walked: await engine.countSegmentedCensusPages(['default'], ['default']),
      both: await engine.countSegmentedCensusPages(['default', 'other'], ['other']),
      none: await engine.countSegmentedCensusPages([], ['default']),
    };
    await engine.softDeletePage('notes/seg-a');
    const afterDelete = await engine.countSegmentedCensusPages(['default'], []);
    // A shell has no source path, so a walked source still counts it.
    expect(counts).toEqual({ unwalked: { n: 2 }, walked: { n: 2 }, both: { n: 3 }, none: { n: 0 } });
    expect(afterDelete).toEqual({ n: 1 });
    return { counts, afterDelete };
  });

  parityTest('listFactsPageBodies lists a segmented facts page with no published body as segmented with a null body', {
    methods: ['putPage', 'createSegmentedPageShell', 'listFactsPageBodies'],
  }, async (engine) => {
    await engine.putPage('me/facts', note('Me', '- 2026-01-01 born', 'facts'));
    await engine.createSegmentedPageShell('seg/facts', { ...pageMeta('Seg facts'), type: 'facts' }, { sourceId: 'default' });
    await engine.putPage('company-x/facts', note('Company X', '- dash sorts before slash', 'facts'));
    await engine.putPage('company/facts', note('Company', '- slash', 'facts'));
    const listed = (await engine.listFactsPageBodies()).map(r => ({ slug: r.slug, segmented: r.segmented, body: r.body }));
    expect(listed).toEqual([
      { slug: 'company-x/facts', segmented: false, body: '- dash sorts before slash' },
      { slug: 'company/facts', segmented: false, body: '- slash' },
      { slug: 'me/facts', segmented: false, body: '- 2026-01-01 born' },
      { slug: 'seg/facts', segmented: true, body: null },
    ]);
    return listed;
  });

  parityTest('readFactTableCatalog names the facts and relink-attempt tables a brain has', { methods: ['readFactTableCatalog'] }, async (engine) => {
    const catalog = await engine.readFactTableCatalog();
    expect(catalog).toEqual({ facts: 'facts', attempts: 'fact_relink_attempts' });
    return catalog;
  });

  parityTest('readFactEntitySlugById, readSupersessionReplacement and linkSupersededFact read and link a replaced fact', {
    methods: ['insertFact', 'insertFacts', 'listFactsByEntity', 'readFactEntitySlugById', 'readSupersessionReplacement', 'linkSupersededFact'],
  }, async (engine) => {
    const old = await fenced(engine, 'moved to Paris', { source_markdown_slug: 'notes/a', entity_slug: 'people/x' });
    const replacement = await fenced(engine, 'moved to Rome', { source_markdown_slug: 'notes/a', entity_slug: 'people/x' });
    const elsewhere = await fenced(engine, 'moved to Oslo', { source_markdown_slug: 'notes/b', entity_slug: 'people/y' });
    const bare = await fact(engine, 'no entity');
    const slugs = { old: await engine.readFactEntitySlugById(old), bare: await engine.readFactEntitySlugById(bare), missing: await engine.readFactEntitySlugById(999_999) };
    expect(slugs).toEqual({ old: 'people/x', bare: null, missing: null });
    const same = await engine.readSupersessionReplacement(replacement, old);
    const other = await engine.readSupersessionReplacement(elsewhere, old);
    const missing = await engine.readSupersessionReplacement(999_999, old);
    const view = (r: typeof same) => r ? { same_page: r.same_page, fenced: r.row_num !== null, ordered: new Date(r.valid_from!).getTime() >= new Date(r.old_from!).getTime(), open: r.old_until === null } : null;
    expect({ same: view(same), other: view(other), missing: view(missing) }).toEqual({
      same: { same_page: true, fenced: true, ordered: true, open: true }, other: { same_page: false, fenced: true, ordered: true, open: true }, missing: null });
    await engine.linkSupersededFact(old, replacement);
    const linked = (await engine.listFactsByEntity('default', 'people/x', { activeOnly: false })).find(r => Number(r.id) === old)!;
    expect(Number(linked.superseded_by)).toBe(replacement);
    return { slugs, same: view(same), other: view(other), missing: view(missing), superseded: Number(linked.superseded_by) === replacement };
  });

  parityTest('listLivePageTitles and listPageAliasNames name the live pages and aliases of a source', {
    methods: ['putPage', 'softDeletePage', 'setPageAliases', 'listLivePageTitles', 'listPageAliasNames'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('people/a', note('Alice Example', 'a', 'person'));
    await engine.putPage('people/b', note('Bob Example', 'b', 'person'));
    await engine.putPage('people/gone', note('Gone Example', 'g', 'person'));
    await engine.softDeletePage('people/gone');
    await engine.putPage('people/a', note('Elsewhere Alice', 'a', 'person'), { sourceId: 'other' });
    await engine.setPageAliases('people/a', 'default', ['ali', 'alice e']);
    await engine.setPageAliases('people/b', 'default', ['bobby']);
    await engine.setPageAliases('people/a', 'other', ['other alias']);
    const titles = (await engine.listLivePageTitles('default', ['people/a', 'people/b', 'people/gone', 'people/none'])).map(r => ({ slug: r.slug, title: r.title }))
      .sort((x, y) => x.slug.localeCompare(y.slug));
    expect(titles).toEqual([{ slug: 'people/a', title: 'Alice Example' }, { slug: 'people/b', title: 'Bob Example' }]);
    const aliases = (await engine.listPageAliasNames('default', ['people/a', 'people/b', 'people/none'])).map(r => `${r.slug}:${r.alias_norm}`).sort();
    expect(aliases).toEqual(['people/a:ali', 'people/a:alice e', 'people/b:bobby']);
    const noSlugs = { titles: await engine.listLivePageTitles('default', []), aliases: await engine.listPageAliasNames('default', []) };
    expect(noSlugs).toEqual({ titles: [], aliases: [] });
    return { titles, aliases, noSlugs };
  });

  parityTest('listCaptureDuplicateCandidates lists the unexpired same-text facts of the visibilities, newest first, minus the excluded ones', {
    methods: ['insertFact', 'insertFacts', 'expireFact', 'listCaptureDuplicateCandidates'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const text = 'Alice moved to Paris';
    const world = await fact(engine, text, { visibility: 'world', entity_slug: 'people/a', source: 'mcp:remember' });
    const privateCopy = await fact(engine, 'alice  MOVED to paris', { entity_slug: 'people/a' });
    const user = await fact(engine, text, { attributed_to: 'user' });
    const speaker = await fact(engine, text, { attributed_to: 'other' });
    const expired = await fact(engine, text);
    expect(await engine.expireFact(expired)).toBe(true);
    const lapsed = await fact(engine, text, { valid_until: new Date('2020-01-01T00:00:00Z') });
    const rewrite = await fenced(engine, text, { visibility: 'private', source: `${EXTRACTOR}:v2`, source_markdown_slug: 'chats/one' });
    const member = await fenced(engine, text, { visibility: 'private', source: 'mcp:remember', source_markdown_slug: 'memory/members/ann' });
    const away = await fact(engine, text, {}, 'other');
    await fact(engine, 'a different fact');
    const name = namer({ world, privateCopy, user, speaker, expired, lapsed, rewrite, member, away });
    const run = async (opts: Partial<Parameters<BrainEngine['listCaptureDuplicateCandidates']>[0]> = {}) =>
      (await engine.listCaptureDuplicateCandidates({ sourceId: 'default', visibilities: ['world', 'private'], fact: text, attributedTo: null, replacingPage: null, scanLimit: 50, ...opts }))
        .map(r => name(r.id));
    const all = await run();
    expect(all.slice().sort()).toEqual(['privateCopy', 'rewrite', 'speaker', 'user', 'world']);
    expect(all).toEqual(all.slice().sort((a, b) => ['world', 'privateCopy', 'user', 'speaker', 'rewrite'].indexOf(b) - ['world', 'privateCopy', 'user', 'speaker', 'rewrite'].indexOf(a)));
    const worldOnly = await run({ visibilities: ['world'] });
    expect(worldOnly).toEqual(['world']);
    const asUser = (await run({ attributedTo: 'user' })).sort();
    expect(asUser).toEqual(['privateCopy', 'rewrite', 'user', 'world']);
    const replacing = (await run({ replacingPage: 'chats/one' })).sort();
    expect(replacing).toEqual(['privateCopy', 'speaker', 'user', 'world']);
    const limited = await run({ scanLimit: 2 });
    expect(limited).toEqual(all.slice(0, 2));
    const otherSource = await engine.listCaptureDuplicateCandidates({ sourceId: 'other', visibilities: ['world', 'private'], fact: text, attributedTo: null, replacingPage: null, scanLimit: 50 });
    expect(otherSource.map(r => name(r.id))).toEqual(['away']);
    return { all, worldOnly, asUser, replacing, limited };
  });

  parityTest('computeFactFingerprints fingerprints each text in order, equal for texts that differ only in case and spacing', {
    methods: ['computeFactFingerprints'],
  }, async (engine) => {
    const prints = await engine.computeFactFingerprints(['Alice moved to Paris', 'alice  MOVED to paris', 'Bob likes tea']);
    expect(prints.length).toBe(3);
    expect(prints[0]).toBe(prints[1]);
    expect(prints[0]).not.toBe(prints[2]);
    expect(prints[0]).toMatch(/^[0-9a-f]{64}$/);
    const none = await engine.computeFactFingerprints([]);
    expect(none).toEqual([]);
    return { equal: prints[0] === prints[1], distinct: prints[0] !== prints[2], hex: /^[0-9a-f]{64}$/.test(prints[0]!), none };
  });

  parityTest('listClaimConflictPairs and countClaimConflictPairs find the active same-slot claims with different values, newest over oldest', {
    methods: ['insertFact', 'expireFact', 'listClaimConflictPairs', 'countClaimConflictPairs'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const claim = (text: string, value: number, extra: Record<string, unknown> = {}, sourceId = 'default') =>
      fact(engine, text, { entity_slug: 'companies/acme', visibility: 'world', source: 'mcp:remember', claim_metric: 'arr', claim_value: value, claim_unit: 'usd', claim_period: 'annual',
        valid_from: new Date('2026-03-01T00:00:00Z'), ...extra }, sourceId);
    const oldest = await claim('ARR is 10', 10, { valid_from: new Date('2026-01-10T00:00:00Z') });
    const newer = await claim('ARR is 12', 12, { valid_from: new Date('2026-02-10T00:00:00Z') });
    const newest = await claim('ARR is 15', 15);
    const sameValue = await claim('ARR is also 12', 12, { valid_from: new Date('2026-02-11T00:00:00Z') });
    const priorYear = await claim('ARR was 7', 7, { valid_from: new Date('2025-02-10T00:00:00Z') });
    const otherMetric = await claim('Churn is 3', 3, { claim_metric: 'churn' });
    const audit = await claim('audit ARR 99', 99, { source: AUDIT_ROW_SOURCES[0] });
    const gone = await claim('ARR was 11', 11, { valid_from: new Date('2026-02-12T00:00:00Z') });
    expect(await engine.expireFact(gone)).toBe(true);
    const privatePair = await claim('private ARR 1', 1, { visibility: 'private' });
    const away = await claim('away ARR 5', 5, {}, 'other');
    const name = namer({ oldest, newer, newest, sameValue, priorYear, otherMetric, audit, gone, privatePair, away });
    const view = (list: Awaited<ReturnType<BrainEngine['listClaimConflictPairs']>>) => list.map(r => `${name(Number(r.new_fact_id))}>${name(Number(r.old_fact_id))}`);
    const audits = [...AUDIT_ROW_SOURCES];
    const pairs = view(await engine.listClaimConflictPairs('default', audits, 50));
    expect(pairs).toEqual(['newer>oldest', 'newest>oldest', 'newest>newer', 'newest>sameValue', 'sameValue>oldest']);
    const capped = view(await engine.listClaimConflictPairs('default', audits, 2));
    expect(capped).toEqual(pairs.slice(0, 2));
    const counted = await engine.countClaimConflictPairs('default', audits);
    expect(Number(counted?.n)).toBe(pairs.length);
    const withAudit = view(await engine.listClaimConflictPairs('default', [], 50));
    const otherSource = view(await engine.listClaimConflictPairs('other', audits, 50));
    expect(otherSource).toEqual([]);
    return { pairs, capped, counted: Number(counted?.n), withAudit, otherSource };
  });
  parityTest('listClaimConflictPairs buckets claims by cadence, keeps owned pages apart from other pages and leaves out the pairs a proposal covers', {
    methods: ['insertFact', 'insertFacts', 'insertDecideProposal', 'insertTrustProposal', 'transitionTrustProposal', 'listClaimConflictPairs', 'countClaimConflictPairs'],
  }, async (engine) => {
    const claim = (text: string, entity: string, value: number, from: string, extra: Record<string, unknown> = {}) =>
      fact(engine, text, { entity_slug: entity, visibility: 'world', source: 'mcp:remember', claim_metric: 'arr', claim_value: value, claim_unit: 'usd', valid_from: new Date(from), ...extra });
    const filed = (text: string, entity: string, value: number, slug: string) =>
      fenced(engine, text, { entity_slug: entity, claim_metric: 'arr', claim_value: value, claim_unit: 'usd', claim_period: 'annual', source_markdown_slug: slug, valid_from: new Date('2026-03-01T00:00:00Z') });
    // Days: the UTC day decides, not the clock time.
    const dayA = await claim('day a', 'companies/day', 1, '2026-03-01T00:30:00Z');
    const dayB = await claim('day b', 'companies/day', 2, '2026-03-01T23:30:00Z');
    const dayC = await claim('day c', 'companies/day', 3, '2026-03-02T00:30:00Z');
    // Weeks: Monday and Thursday of one ISO week pair up; the next Monday does not; a week that crosses the year pairs up too.
    const weekA = await claim('week a', 'companies/week', 1, '2026-03-02T09:00:00Z', { claim_period: 'weekly' });
    const weekB = await claim('week b', 'companies/week', 2, '2026-03-05T09:00:00Z', { claim_period: 'weekly' });
    const weekC = await claim('week c', 'companies/week', 3, '2026-03-09T09:00:00Z', { claim_period: 'weekly' });
    const yearA = await claim('year a', 'companies/year', 1, '2024-12-30T09:00:00Z', { claim_period: 'weekly' });
    const yearB = await claim('year b', 'companies/year', 2, '2025-01-02T09:00:00Z', { claim_period: 'weekly' });
    // Months and quarters.
    const monthA = await claim('month a', 'companies/month', 1, '2026-03-01T09:00:00Z', { claim_period: 'monthly' });
    const monthB = await claim('month b', 'companies/month', 2, '2026-03-31T09:00:00Z', { claim_period: 'monthly' });
    const monthC = await claim('month c', 'companies/month', 3, '2026-04-01T09:00:00Z', { claim_period: 'monthly' });
    const quarterA = await claim('quarter a', 'companies/quarter', 1, '2026-01-05T09:00:00Z', { claim_period: 'quarterly' });
    const quarterB = await claim('quarter b', 'companies/quarter', 2, '2026-03-25T09:00:00Z', { claim_period: 'quarterly' });
    const quarterC = await claim('quarter c', 'companies/quarter', 3, '2026-04-02T09:00:00Z', { claim_period: 'quarterly' });
    // An owned memory page keeps its claims apart from any other page's, and pairs the claims of the same page.
    const aliceA = await filed('alice a', 'companies/owned', 1, 'memory/members/alice');
    const aliceB = await filed('alice b', 'companies/owned', 2, 'memory/members/alice');
    const bobA = await filed('bob a', 'companies/owned', 3, 'memory/members/bob');
    const plainA = await filed('plain a', 'companies/plain', 1, 'notes/one');
    const plainB = await filed('plain b', 'companies/plain', 2, 'notes/two');
    // A decide proposal covers a pair in any status; a pending supersede proposal covers its pair; a rejected one does not.
    const decided = [await claim('decided a', 'companies/decided', 1, '2026-03-01T01:00:00Z'), await claim('decided b', 'companies/decided', 2, '2026-03-01T02:00:00Z')];
    const pending = [await claim('pending a', 'companies/pending', 1, '2026-03-01T01:00:00Z'), await claim('pending b', 'companies/pending', 2, '2026-03-01T02:00:00Z')];
    const rejected = [await claim('rejected a', 'companies/rejected', 1, '2026-03-01T01:00:00Z'), await claim('rejected b', 'companies/rejected', 2, '2026-03-01T02:00:00Z')];
    expect(await engine.insertDecideProposal({
      source_id: 'default', sweep_id: 'claim_conflicts:parity', pair_index: 0, new_fact_id: decided[1]!, old_fact_id: decided[0]!,
      direction: 'new_supersedes_old', p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'model-a',
    })).not.toBeNull();
    const supersede = (older: number, newer: number) => ({ action: 'supersede_fact' as const, sourceId: 'default', target: { table: 'facts' as const, id: older },
      related: { table: 'facts' as const, id: newer }, before: { trust_tier: 'operator_curated' }, proposer: 'parity' });
    await engine.insertTrustProposal(supersede(pending[0]!, pending[1]!));
    const rejectedProposal = await engine.insertTrustProposal(supersede(rejected[0]!, rejected[1]!));
    expect(await engine.transitionTrustProposal(rejectedProposal.id, 'pending', 'rejected', { decidedBy: { kind: 'operator', id: 'cli' } })).toBeTruthy();
    const name = namer({ dayA, dayB, dayC, weekA, weekB, weekC, yearA, yearB, monthA, monthB, monthC, quarterA, quarterB, quarterC, aliceA, aliceB, bobA, plainA, plainB,
      decidedA: decided[0]!, decidedB: decided[1]!, pendingA: pending[0]!, pendingB: pending[1]!, rejectedA: rejected[0]!, rejectedB: rejected[1]! });
    const list = await engine.listClaimConflictPairs('default', [...AUDIT_ROW_SOURCES], 100);
    const pairs = list.map(r => ({ pair: `${name(Number(r.new_fact_id))}>${name(Number(r.old_fact_id))}`, bucket: r.bucket, new: Number(r.new_value), old: Number(r.old_value), entity: r.entity_slug }));
    const counted = Number((await engine.countClaimConflictPairs('default', [...AUDIT_ROW_SOURCES]))?.n);
    expect(counted).toBe(pairs.length);
    const byPair = new Map(pairs.map(p => [p.pair, p.bucket]));
    expect(byPair.get('dayB>dayA')).toBe('2026-03-01');
    expect(byPair.get('weekB>weekA')).toBe('2026-W10');
    expect(byPair.get('yearB>yearA')).toBe('2025-W01');
    expect(byPair.get('monthB>monthA')).toBe('2026-03');
    expect(byPair.get('quarterB>quarterA')).toBe('2026-Q1');
    for (const absent of ['dayC>dayB', 'weekC>weekB', 'monthC>monthB', 'quarterC>quarterB', 'bobA>aliceA', 'aliceB>bobA', 'decidedB>decidedA', 'pendingB>pendingA']) {
      expect(byPair.has(absent), absent).toBe(false);
    }
    expect(byPair.has('aliceB>aliceA')).toBe(true);
    expect(byPair.has('plainB>plainA')).toBe(true);
    expect(byPair.has('rejectedB>rejectedA')).toBe(true);
    return { pairs, counted };
  });
});
