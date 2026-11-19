/**
 * BrainEngine parity — the facts statements of the command, cycle and fence paths that ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listActiveFactsForEntity, listFreshExtractionOutcomes, listFenceRowGroups, readFactSubject,
 *    listFactsForPage, countLegacyFactsPending, countUnconsolidatedFactsBySource, findBulkFactDays, maxFenceRowNum,
 *    readFenceRowOccupant, listStoredFenceFactRows and countWorldFacts return the same observable result on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes what enrich grounds on, which pages
 *    extract-conversation-facts skips, what the v0.32.2 verify and extract_facts reconcile compare, what consolidate
 *    buckets, which days doctor and repair call bulk loads, the next fence row number and the entity card's fact count;
 *    the Rust engine has no SQL, so each read has to exist as a typed method it can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: none; every row is seeded through the typed `putPage`, `softDeletePage`, `insertFact` and `insertFacts`.
 *    Generated values (fact ids, timestamps) are compared by relation or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { CALLER_ENTITIES, callerFactRows, putCallerPages, readAsCallers } from './fact-callers.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string, frontmatter: Record<string, unknown> = {}) => ({ type: 'note' as const, title, compiled_truth: title, frontmatter });
const LONG_AGO = new Date('2020-01-01T00:00:00Z');

/**
 * Fixture: one unfenced fact through the typed `insertFact`; `expired` closes it through the typed `expireFact`
 * (`insertFact` itself stores neither `expired_at` nor a page coordinate).
 */
async function fact(engine: BrainEngine, text: string, extra: Record<string, unknown> = {}, sourceId = 'default'): Promise<number> {
  const { expired, ...input } = extra;
  const out = await engine.insertFact({ fact: text, entity_slug: null, visibility: 'world', source: 't', embedding: null, ...input } as never, { source_id: sourceId });
  if (expired) expect(await engine.expireFact(out.id)).toBe(true);
  return Number(out.id);
}

/** Fixture: fenced rows (a row number on a page) through the typed `insertFacts`. */
async function fenced(engine: BrainEngine, rows: Array<Record<string, unknown>>, sourceId = 'default'): Promise<void> {
  await engine.insertFacts(rows.map((r) => ({ kind: 'fact', visibility: 'world', source: 'fence', embedding: null, entity_slug: null, ...r })) as never, { source_id: sourceId });
}

describe('engine parity: facts command, cycle and fence reads', () => {
  parityTest('listActiveFactsForEntity orders by confidence then newest id and drops expired and lapsed facts', { methods: ['listActiveFactsForEntity'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const about = (text: string, extra: Record<string, unknown> = {}) => fact(engine, text, { entity_slug: 'people/a-example', ...extra });
    await about('low', { confidence: 0.2 });
    await about('high-old', { confidence: 0.9, context: 'ctx' });
    await about('high-new', { confidence: 0.9 });
    await about('lapsed', { confidence: 1, valid_until: LONG_AGO });
    await about('expired', { confidence: 1, expired: true });
    await fact(engine, 'other entity', { entity_slug: 'people/b-example', confidence: 1 });
    await fact(engine, 'other source', { entity_slug: 'people/a-example', confidence: 1 }, 'other');
    const all = await engine.listActiveFactsForEntity('default', 'people/a-example', 10);
    expect(all.map((r) => r.fact)).toEqual(['high-new', 'high-old', 'low']);
    const capped = await engine.listActiveFactsForEntity('default', 'people/a-example', 2);
    expect(capped.map((r) => r.fact)).toEqual(['high-new', 'high-old']);
    const none = await engine.listActiveFactsForEntity('default', 'people/none', 10);
    expect(none).toEqual([]);
    return { all, capped, none };
  });

  parityTest('listFreshExtractionOutcomes lists the unexpired audit rows of the named pages, the preferred source first', { methods: ['listFreshExtractionOutcomes'] }, async (engine) => {
    await engine.putPage('chat/a', note('A'));
    await engine.putPage('chat/b', note('B'));
    await fenced(engine, [
      { fact: 'x', source: 'audit:other', source_session: 's1', source_markdown_slug: 'chat/b', row_num: 1 },
      { fact: 'x', source: 'audit:terminal', source_session: 's2', source_markdown_slug: 'chat/b', row_num: 2 },
      { fact: 'x', source: 'audit:other', source_session: 's3', source_markdown_slug: 'chat/a', row_num: 1 },
      { fact: 'x', source: 'audit:terminal', source_session: 'gone', source_markdown_slug: 'chat/a', row_num: 2, expired_at: LONG_AGO },
      { fact: 'x', source: 'chat', source_session: 'ignored', source_markdown_slug: 'chat/a', row_num: 3 },
    ]);
    const rows = await engine.listFreshExtractionOutcomes('default', ['chat/b', 'chat/a', 'chat/a', 'chat/none'], ['audit:terminal', 'audit:other'], 'audit:terminal');
    expect(rows.map((r) => `${r.slug}:${r.source_session}`)).toEqual(['chat/a:s3', 'chat/b:s2', 'chat/b:s1']);
    const nothing = await engine.listFreshExtractionOutcomes('default', [], ['audit:terminal'], 'audit:terminal');
    expect(nothing).toEqual([]);
    return { rows, nothing };
  });

  parityTest('listFenceRowGroups groups fenced rows per page with their row numbers and whether all are expired, leaving out cli rows', { methods: ['listFenceRowGroups'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await fenced(engine, [
      { fact: 'a3', row_num: 3, source_markdown_slug: 'n/a' },
      { fact: 'a1', row_num: 1, source_markdown_slug: 'n/a' },
      { fact: 'b1', row_num: 1, source_markdown_slug: 'n/b', expired_at: LONG_AGO },
      { fact: 'b2', row_num: 2, source_markdown_slug: 'n/b', expired_at: LONG_AGO },
      { fact: 'c1', row_num: 1, source_markdown_slug: 'n/c', source: 'cli:extract-conversation-facts' },
      { fact: 'm1', row_num: 1, source_markdown_slug: 'n/m', expired_at: LONG_AGO },
      { fact: 'm2', row_num: 2, source_markdown_slug: 'n/m' },
    ]);
    await fenced(engine, [{ fact: 'o1', row_num: 1, source_markdown_slug: 'n/a' }], 'other');
    const groups = sorted(await engine.listFenceRowGroups(), (g) => `${g.source_id}:${g.source_markdown_slug}`);
    expect(groups.map((g) => `${g.source_id}:${g.source_markdown_slug}:${g.row_nums.join(',')}:${g.all_expired}`)).toEqual([
      'default:n/a:1,3:false', 'default:n/b:1,2:true', 'default:n/m:1,2:false', 'other:n/a:1:false',
    ]);
    return groups;
  });

  parityTest('readFactSubject names the source and the row\'s page, else its entity, and null for no row', { methods: ['readFactSubject'] }, async (engine) => {
    const { ids: [onPage = 0] } = await engine.insertFacts([{ fact: 'on a page', entity_slug: 'people/a-example', source_markdown_slug: 'n/p', row_num: 1, kind: 'fact', visibility: 'world', source: 'fence' }] as never, { source_id: 'default' });
    const entityOnly = await fact(engine, 'entity only', { entity_slug: 'people/a-example' });
    const neither = await fact(engine, 'neither');
    const subjects = {
      onPage: await engine.readFactSubject(onPage),
      entityOnly: await engine.readFactSubject(entityOnly),
      neither: await engine.readFactSubject(neither),
      missing: await engine.readFactSubject(Math.max(onPage, entityOnly, neither) + 1000),
    };
    expect(subjects.onPage).toEqual({ source_id: 'default', slug: 'n/p' });
    expect(subjects.entityOnly).toEqual({ source_id: 'default', slug: 'people/a-example' });
    expect(subjects.missing).toBeNull();
    return subjects;
  });

  parityTest('listFactsForPage returns the fence-owned rows by row number, leaving out cli rows', { methods: ['listFactsForPage', 'mergeOntologyFact', 'expireFact'] }, async (engine) => {
    await fenced(engine, [
      { fact: 'r2', row_num: 2, source_markdown_slug: 'n/a', confidence: 0.8, claim_metric: 'arr', claim_value: 1.5, claim_unit: 'usd', claim_period: 'q1',
        valid_from: new Date('2026-01-01T00:00:00Z'), valid_until: new Date('2030-01-01T00:00:00Z'), context: 'ctx', notability: 'high' },
      { fact: 'r1 expired', row_num: 1, source_markdown_slug: 'n/a', expired_at: LONG_AGO, valid_from: LONG_AGO },
      { fact: 'chat', row_num: 7, source_markdown_slug: 'n/a', source: 'cli:extract-conversation-facts' },
      { fact: 'elsewhere', row_num: 1, source_markdown_slug: 'n/b' },
    ]);
    // Ontology observations carry the page as their source and no row number; one the page no longer states is expired, so it is not fence-owned.
    const merge = (value: string, validFrom: string) => engine.mergeOntologyFact({ entitySlug: 'people/a-example', dimension: 'role', value, source: 'n/a', validFrom } as never);
    const founder = await merge('founder', '2024-01-01');
    await merge('advisor', '2026-05-01');
    expect(await engine.expireFact(Number(founder.factId))).toBe(true);
    const rows = await engine.listFactsForPage('default', 'n/a');
    expect(rows.map((r) => `${r.row_num === null ? 'unfenced' : Number(r.row_num)}:${r.fact}`)).toEqual(['1:r1 expired', '2:r2', 'unfenced:role: advisor']);
    expect(rows[0]!.expired_at).toBeInstanceOf(Date);
    expect(rows[1]!.valid_from).toBeInstanceOf(Date);
    expect(rows[1]!.has_embedding).toBe(false);
    expect(await engine.listFactsForPage('default', 'n/none')).toEqual([]);
    return rows.map(({ id: _id, superseded_by: _s, ...r }) => r);
  });

  parityTest('countLegacyFactsPending counts the unfenced rows of live entity pages in a source with a checkout', { methods: ['countLegacyFactsPending', 'mergeOntologyFact'] }, async (engine, backend) => {
    await createSource(engine, backend, 'repo', {}, '/srv/repo');
    await createSource(engine, backend, 'dbonly');
    await engine.putPage('people/a-example', note('A'), { sourceId: 'repo' });
    await engine.putPage('people/gone-example', note('Gone'), { sourceId: 'repo' });
    await engine.putPage('people/a-example', note('A'), { sourceId: 'dbonly' });
    await engine.softDeletePage('people/gone-example', { sourceId: 'repo' });
    const about = (text: string, entity: string | null, extra: Record<string, unknown> = {}) => fact(engine, text, { entity_slug: entity, ...extra }, 'repo');
    await about('one', 'people/a-example');
    await about('two', 'people/a-example');
    await engine.mergeOntologyFact({ entitySlug: 'people/a-example', dimension: 'role', value: 'cto', source: 'people/a-example', sourceId: 'repo' } as never);
    await about('expired', 'people/a-example', { expired: true });
    await about('no page', 'people/missing-example');
    await about('deleted page', 'people/gone-example');
    await about('no entity', null);
    await engine.insertFacts([{ fact: 'fenced', entity_slug: 'people/a-example', source_markdown_slug: 'people/a-example', row_num: 1, source: 'fence', embedding: null }] as never, { source_id: 'repo' });
    await fact(engine, 'no checkout', { entity_slug: 'people/a-example' }, 'dbonly');
    const repo = await engine.countLegacyFactsPending('repo');
    const dbonly = await engine.countLegacyFactsPending('dbonly');
    const none = await engine.countLegacyFactsPending('nothing');
    expect(repo.map((r) => `${r.entity_slug}:${Number(r.n)}`)).toEqual(['people/a-example:2']);
    expect(dbonly).toEqual([]);
    // The count's JavaScript type differs by driver (a number on PGLite, text on Postgres); it is compared as a number.
    return { repo: repo.map((r) => ({ ...r, n: Number(r.n) })), dbonly, none };
  });

  parityTest('countUnconsolidatedFactsBySource buckets live entity pages by attribution, visibility and readers', { methods: ['countUnconsolidatedFactsBySource'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    for (const slug of ['people/a-example', 'people/b-example', 'people/gone-example', 'notes/open']) await engine.putPage(slug, note(slug));
    await engine.putPage('notes/readers', note('readers', { readable_by: ['someone'] }));
    await engine.putPage('people/a-example', note('A other'), { sourceId: 'other' });
    await engine.softDeletePage('people/gone-example');
    const about = (text: string, entity: string, extra: Record<string, unknown> = {}, sourceId = 'default') => fact(engine, text, { entity_slug: entity, ...extra }, sourceId);
    await about('a1', 'people/a-example');
    await about('a2', 'people/a-example', { visibility: 'private', attributed_to: 'user' });
    await about('a3', 'people/a-example', { attributed_to: 'assistant' });
    await about('a3b', 'people/a-example', { attributed_to: 'other' });
    await about('a3c', 'people/a-example', { attributed_to: 'assistant' });
    await about('a4', 'people/a-example', { valid_until: LONG_AGO });
    await about('a5', 'people/a-example', { expired: true });
    await about('b1', 'people/b-example');
    await about('g1', 'people/gone-example');
    await about('n1', 'people/nopage-example');
    await about('o1', 'people/a-example', {}, 'other');
    await fenced(engine, [
      { fact: 'a6', entity_slug: 'people/a-example', source_markdown_slug: 'notes/readers', row_num: 1 },
      { fact: 'a7', entity_slug: 'people/a-example', source_markdown_slug: 'notes/open', row_num: 1 },
    ]);
    const read = async (opts: { sourceId?: string; worldOnly: boolean; minPerBucket: number }) =>
      sorted(await engine.countUnconsolidatedFactsBySource(opts), (r) => `${r.source_id}:${r.entity_slug}`).map((r) => ({ ...r, count: Number(r.count) }));
    const everything = await read({ worldOnly: false, minPerBucket: 1 });
    const worldOnly = await read({ worldOnly: true, minPerBucket: 1 });
    const oneSource = await read({ sourceId: 'default', worldOnly: false, minPerBucket: 1 });
    const twoOrMore = await read({ worldOnly: false, minPerBucket: 2 });
    expect(everything.map((r) => `${r.source_id}:${r.entity_slug}:${r.count}`)).toEqual([
      'default:people/a-example:3', 'default:people/b-example:1', 'other:people/a-example:1',
    ]);
    expect(oneSource.map((r) => `${r.entity_slug}:${r.count}`)).toEqual(['people/a-example:3', 'people/b-example:1']);
    expect(twoOrMore.map((r) => `${r.source_id}:${r.entity_slug}:${r.count}`)).toEqual(['default:people/a-example:3']);
    return { everything, worldOnly, oneSource, twoOrMore };
  });

  parityTest('findBulkFactDays finds the days that clear the thresholds, with their top sources and self-dated claims', { methods: ['findBulkFactDays'] }, async (engine, backend) => {
    await createSource(engine, backend, 'arch');
    const day = new Date('2026-03-10T09:00:00Z');
    const claims: Array<[string, string]> = [
      ['s2', 'plain'], ['s1', 'since 2026-01-05 it grew'], ['s1', '2024-02-30 is no date'], ['s1', '2026-03-10 is the day itself'],
      ['s1', 'between 2025-12-01 and 2025-12-02'], ['s3', 'see 1899-12-31 or v2025-12-0123'],
    ];
    for (const [i, [source, text]] of claims.entries()) await fact(engine, text, { entity_slug: `e/${i % 3}`, source, valid_from: day });
    await fact(engine, 'other day', { entity_slug: 'e/9', source: 's1', valid_from: new Date('2026-03-11T00:00:00Z') });
    await fact(engine, 'archived', { entity_slug: 'e/1', source: 's1', valid_from: day }, 'arch');
    await archiveSource(engine, backend, 'arch');
    const rule = { min_facts: 6, min_share: 0.5, min_entities: 3 };
    const days = await engine.findBulkFactDays(undefined, rule);
    expect(days.map((d) => `${d.source_id}:${d.day}:${d.facts}:${d.dated_claims}`)).toEqual(['default:2026-03-10:6:1']);
    const tooMany = await engine.findBulkFactDays(undefined, { ...rule, min_facts: 7 });
    const tooSmallShare = await engine.findBulkFactDays(undefined, { ...rule, min_share: 0.9 });
    const tooFewEntities = await engine.findBulkFactDays(undefined, { ...rule, min_entities: 4 });
    const noSources = await engine.findBulkFactDays([], rule);
    const archived = await engine.findBulkFactDays(['arch'], { min_facts: 1, min_share: 0.1, min_entities: 1 });
    const narrowed = await engine.findBulkFactDays(['default'], { min_facts: 1, min_share: 0.1, min_entities: 1 });
    expect([tooMany, tooSmallShare, tooFewEntities, noSources, archived]).toEqual([[], [], [], [], []]);
    expect(narrowed.map((d) => d.day)).toEqual(['2026-03-10', '2026-03-11']);
    return { days, narrowed };
  });

  parityTest('maxFenceRowNum is the largest row number of the page coordinate, 0 for none', { methods: ['maxFenceRowNum'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await fenced(engine, [
      { fact: 'second', row_num: 5, source_markdown_slug: 'n/a' },
      { fact: 'first', row_num: 2, source_markdown_slug: 'n/a' },
      { fact: 'other page', row_num: 9, source_markdown_slug: 'n/b' },
    ]);
    const result = {
      page: await engine.maxFenceRowNum('default', 'n/a'),
      none: await engine.maxFenceRowNum('default', 'n/none'),
      otherSource: await engine.maxFenceRowNum('other', 'n/a'),
    };
    expect(result).toEqual({ page: 5, none: 0, otherSource: 0 });
    return result;
  });

  parityTest('readFenceRowOccupant answers the fact holding a row number of the page coordinate, null for none', { methods: ['readFenceRowOccupant', 'listFactsForPage'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await fenced(engine, [
      { fact: 'first holder', row_num: 4, source_markdown_slug: 'n/a' },
      // A second fact at a held row is skipped (one fact per fence row), so the first stays the occupant.
      { fact: 'second holder', row_num: 4, source_markdown_slug: 'n/a' },
      { fact: 'other row', row_num: 7, source_markdown_slug: 'n/a' },
      { fact: 'other page', row_num: 4, source_markdown_slug: 'n/b' },
    ]);
    const label = new Map((await engine.listFactsForPage('default', 'n/a')).map((r) => [Number(r.id), r.fact]));
    const of = async (sourceId: string, slug: string, rowNum: number) => {
      const id = await engine.readFenceRowOccupant(sourceId, slug, rowNum);
      return id === null ? null : label.get(Number(id)) ?? 'unlabelled';
    };
    const result = {
      held: await of('default', 'n/a', 4),
      single: await of('default', 'n/a', 7),
      freeRow: await of('default', 'n/a', 5),
      noPage: await of('default', 'n/none', 4),
      otherSource: await of('other', 'n/a', 4),
    };
    expect(result).toEqual({ held: 'first holder', single: 'other row', freeRow: null, noPage: null, otherSource: null });
    return result;
  });

  parityTest('listStoredFenceFactRows lists the page coordinate\'s numbered rows oldest id first', { methods: ['listStoredFenceFactRows'] }, async (engine) => {
    await fenced(engine, [
      { fact: 'second', row_num: 5, source_markdown_slug: 'n/a' },
      { fact: 'first', row_num: 2, source_markdown_slug: 'n/a' },
      { fact: 'other page', row_num: 9, source_markdown_slug: 'n/b' },
    ]);
    const rows = await engine.listStoredFenceFactRows('default', 'n/a');
    expect(rows.map((r) => `${Number(r.row_num)}:${r.fact}`)).toEqual(['5:second', '2:first']);
    expect(await engine.listStoredFenceFactRows('default', 'n/none')).toEqual([]);
    return rows.map((r) => ({ row_num: Number(r.row_num), fact: r.fact }));
  });

  parityTest('countWorldFacts counts unexpired entity facts, hiding deleted and quarantined pages', { methods: ['countWorldFacts'] }, async (engine) => {
    for (const slug of ['people/a-example', 'people/q-example', 'people/d-example']) await engine.putPage(slug, note(slug));
    await engine.putPage('notes/quarantined', note('Q', { quarantine: { reason: 'x' } }));
    await engine.putPage('notes/private', note('P', { visibility: 'private' }));
    await engine.softDeletePage('people/d-example');
    const about = (text: string, entity: string, extra: Record<string, unknown> = {}) => fact(engine, text, { entity_slug: entity, ...extra });
    await about('w', 'people/a-example');
    await about('p', 'people/a-example', { visibility: 'private' });
    await about('lapsed', 'people/a-example', { valid_until: LONG_AGO });
    await about('expired', 'people/a-example', { expired: true });
    await fenced(engine, [
      { fact: 'q', entity_slug: 'people/q-example', source_markdown_slug: 'notes/quarantined', row_num: 1 },
      { fact: 'from a private page', entity_slug: 'people/a-example', source_markdown_slug: 'notes/private', row_num: 1 },
    ]);
    await about('d', 'people/d-example');
    await about('no page', 'people/none-example');
    const count = (entitySlugs: string[], worldOnly: boolean) =>
      engine.countWorldFacts({ sourceId: 'default', entitySlugs, worldOnly, excludePrivate: false });
    const result = {
      one: await count(['people/a-example'], false),
      worldOnly: await count(['people/a-example', 'people/a-example'], true),
      several: await count(['people/a-example', 'people/q-example', 'people/d-example', 'people/none-example'], false),
      empty: await count([], false),
    };
    expect(result).toEqual({ one: 4, worldOnly: 3, several: 5, empty: 0 });
    return result;
  });

  parityTest('countWorldFacts under a trust floor drops a fact below the floor', { methods: ['countWorldFacts'] }, async (engine) => {
    await engine.putPage('people/a-example', note('A'));
    await fact(engine, 'w', { entity_slug: 'people/a-example' });
    const floored = await engine.countWorldFacts({ sourceId: 'default', entitySlugs: ['people/a-example'], worldOnly: false, excludePrivate: false, eligibility: { floor: 'user_confirmed' } });
    expect(floored).toBe(0);
    return floored;
  });

  parityTest('countWorldFacts with excludePrivate applies a caller\'s reader identity and private-readable grant', { methods: ['countWorldFacts'] }, async (engine) => {
    await putCallerPages(engine);
    await fenced(engine, callerFactRows());
    // One count per entity: the open entity holds one fact per provenance page, each other entity one fact.
    const kept = await readAsCallers(async () => {
      const out: Record<string, number> = {};
      for (const [slug] of CALLER_ENTITIES) {
        out[slug] = await engine.countWorldFacts({ sourceId: 'default', entitySlugs: [slug], worldOnly: false, excludePrivate: true });
      }
      return out;
    });
    const none = { 'people/open-example': 2, 'people/private-example': 0, 'people/readers-example': 0, 'people/team-example': 0, 'people/bob-only-example': 0 };
    expect(kept.none).toEqual(none);
    expect(kept.stranger).toEqual(none);
    // This policy reads no identity on the provenance page, the caller's own member page included.
    expect(kept.member).toEqual({ ...none, 'people/readers-example': 1, 'people/team-example': 1 });
    expect(kept.granted).toEqual({ ...none, 'people/readers-example': 1, 'people/private-example': 1 });
    return kept;
  });

  parityTest('countWorldFacts with excludePrivate drops facts of a private-provenance page', { methods: ['countWorldFacts'] }, async (engine) => {
    await engine.putPage('people/a-example', note('A'));
    await engine.putPage('notes/private', note('P', { visibility: 'private' }));
    await fact(engine, 'w', { entity_slug: 'people/a-example' });
    await fenced(engine, [{ fact: 'from a private page', entity_slug: 'people/a-example', source_markdown_slug: 'notes/private', row_num: 1 }]);
    const all = await engine.countWorldFacts({ sourceId: 'default', entitySlugs: ['people/a-example'], worldOnly: false, excludePrivate: false });
    const noPrivate = await engine.countWorldFacts({ sourceId: 'default', entitySlugs: ['people/a-example'], worldOnly: false, excludePrivate: true });
    expect({ all, noPrivate }).toEqual({ all: 2, noPrivate: 1 });
    return { all, noPrivate };
  });
});
