/**
 * BrainEngine parity — the facts search-relevance and trust statements that ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listFactsForRelevance, countUncomparableFacts, matchSavedFacts, readFactForOwnerAction,
 *    listStandingPreferences, listLexicalContestCandidates, listRestatedPrivateCopies and countDerivedFactTaint return
 *    the same observable result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes which facts recall and `search` surface, which
 *    facts a lower-tier write contests or is held against, what an owner action binds to, and how much derived memory
 *    the taint share counts. The Rust engine has no SQL, so each read has to exist as a typed method it can implement
 *    or refuse; the trust reads that need write-gate receipts are refused there (countDerivedFactTaint is served: test/engine-parity/doctor-facts-trust.test.ts).
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines (docs/research/rust-cli-contract-map.md).
 *  - Seam: none. Rows are seeded through the typed `insertFact`, `insertFacts`, `putPage` and `softDeletePage`; a typed
 *    write always stamps `trust_tier = 'unknown'` and no write origin, and no typed method records a write-gate receipt,
 *    so the cases for the trust reads can compare only what that seeding reaches (their empty results included).
 *    Fact ids differ between arms: rows are named by fact text.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { basisEmbedding, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { callerFactRows, putCallerPages, readAsCallers } from './fact-callers.ts';
import { CORRECTION_CUE } from '../../src/core/search/saved-facts-match.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const at = (s: string) => new Date(s);
const note = (title: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: 'x', frontmatter });

type Seed = Partial<Parameters<BrainEngine['insertFact']>[0]> & { fact: string };

/** Insert facts one by one, in array order, and name each id by its fact text. */
async function remember(engine: BrainEngine, rows: Seed[], sourceId = SRC): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  // valid_from defaults to the write time, which differs between arms: give each row its own fixed day.
  for (const [i, row] of rows.entries()) {
    const valid_from = new Date(Date.UTC(2026, 4, 1 + i));
    const r = await engine.insertFact({ source: 'mcp:remember', entity_slug: null, valid_from, ...row }, { source_id: sourceId });
    ids.set(row.fact, r.id);
  }
  return ids;
}

/** A relevance read narrowed to the keys the case compares, named by fact text, with similarity rounded. */
type Hit = { fact: string; entity: string | null; visibility: string; page: string | null; from: string; sim: number | null };
async function relevance(engine: BrainEngine, q: Parameters<BrainEngine['listFactsForRelevance']>[0]): Promise<Hit[]> {
  const rows = await engine.listFactsForRelevance(q);
  return rows.map(r => ({
    fact: r.fact,
    entity: r.entity_slug,
    visibility: r.visibility,
    page: r.source_markdown_slug,
    from: new Date(r.valid_from).toISOString(),
    sim: r.similarity == null ? null : Math.round(Number(r.similarity) * 1e5) / 1e5,
  }));
}

const scope = (extra: Partial<Parameters<BrainEngine['listFactsForRelevance']>[0]['scope']> = {}) =>
  ({ sourceId: SRC, worldOnly: false, excludePrivate: false, ...extra });

describe('engine parity: facts relevance and trust statements', () => {
  parityTest('listFactsForRelevance keyword arm ranks by text match then newest, reads the entity name, and applies the pool', { methods: ['listFactsForRelevance'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/open', note('Open'));
    await engine.putPage('notes/quarantined', note('Quarantined', { quarantine: { reason: 'junk_pattern' } }));
    await engine.putPage('notes/deleted', note('Deleted'));
    await engine.putPage('notes/private', note('Private', { visibility: 'private' }));
    await remember(engine, [
      { fact: 'tea kettle tea kettle', entity_slug: 'people/bob', valid_from: at('2025-12-01T00:00:00Z'), visibility: 'world' },
      { fact: 'Cats purr', entity_slug: 'tea-house', valid_from: at('2026-03-01T00:00:00Z'), visibility: 'world' },
      { fact: 'Alice drinks green tea daily', entity_slug: 'people/alice', valid_from: at('2026-01-01T00:00:00Z') },
      { fact: 'Dogs bark', entity_slug: 'people/dan', valid_from: at('2026-04-01T00:00:00Z') },
      { fact: 'tea audit checkpoint', source: 'cli:extract-conversation-facts:terminal:v2', entity_slug: 'people/e' },
      { fact: 'tea that lapsed', valid_until: at('2020-01-01T00:00:00Z'), entity_slug: 'people/e' },
    ]);
    // Fence rows carry their provenance page (insertFact does not), one per page rule the pool applies.
    await engine.insertFacts(['open', 'private', 'quarantined', 'deleted'].map((page, i) => ({
      fact: `tea on the ${page} page`, entity_slug: 'people/e', source_markdown_slug: `notes/${page}`, row_num: 1,
      kind: 'fact' as const, visibility: 'world' as const, source: 'fence', valid_from: new Date(Date.UTC(2026, 6, 1 + i)),
    })) as never, { source_id: SRC });
    const forgotten = await remember(engine, [{ fact: 'tea forgotten', entity_slug: 'people/e' }]);
    await engine.expireFact(forgotten.get('tea forgotten')!);
    await remember(engine, [{ fact: 'tea in another source', entity_slug: 'people/e' }], 'other');
    await engine.softDeletePage('notes/deleted');
    const keyword = (terms: string, extra: Partial<Parameters<BrainEngine['listFactsForRelevance']>[0]> = {}) =>
      relevance(engine, { arm: 'keyword', scope: scope(), vector: null, terms, limit: 50, ...extra });
    const ranked = await keyword('tea kettle');
    expect(ranked[0]!.fact).toBe('tea kettle tea kettle');
    expect(ranked.map(h => h.fact)).not.toContain('Dogs bark');
    expect(ranked.map(h => h.fact)).not.toContain('tea audit checkpoint');
    expect(ranked.map(h => h.fact)).toContain('tea on the open page');
    expect(ranked.map(h => h.fact)).not.toContain('tea on the quarantined page');
    expect(ranked.map(h => h.fact)).not.toContain('tea on the deleted page');
    expect(ranked.find(h => h.fact === 'tea on the open page')!.page).toBe('notes/open');
    const out = {
      ranked,
      limited: await keyword('tea', { limit: 2 }),
      stopWordsOnly: await keyword('the of'),
      worldOnly: await keyword('tea', { scope: scope({ worldOnly: true }) }),
      excludePrivate: await keyword('tea', { scope: scope({ excludePrivate: true }) }),
      includeExpired: await keyword('tea', { filters: { includeExpired: true } }),
      twoSources: await keyword('tea', { scope: { sourceIds: [SRC, 'other'], worldOnly: false, excludePrivate: false } }),
    };
    const names = (hits: Hit[]) => hits.map(h => h.fact);
    // The row naming both words ranks first though it is the oldest; the rest tie on text and come newest first.
    expect(names(ranked)).toEqual(['tea kettle tea kettle', 'tea on the private page', 'tea on the open page', 'Cats purr', 'Alice drinks green tea daily']);
    expect(names(out.limited)).toEqual(['tea kettle tea kettle', 'tea on the private page']);
    expect(out.stopWordsOnly).toEqual([]);
    expect(names(out.worldOnly)).not.toContain('Alice drinks green tea daily');
    expect(names(out.excludePrivate)).not.toContain('tea on the private page');
    expect(names(out.excludePrivate)).toContain('Alice drinks green tea daily');
    expect(names(out.includeExpired)).toEqual(expect.arrayContaining(['tea that lapsed', 'tea forgotten']));
    expect(names(out.includeExpired)).not.toContain('tea audit checkpoint');
    expect(names(out.twoSources)).toContain('tea in another source');
    return out;
  });

  parityTest('listFactsForRelevance under excludePrivate applies a caller\'s reader identity, own member page and private-readable grant', { methods: ['listFactsForRelevance'] }, async (engine) => {
    await putCallerPages(engine);
    await engine.insertFacts(callerFactRows().map((r, i) => ({
      ...r, fact: `tea ${r.fact}`, kind: 'fact' as const, visibility: 'world' as const, source: 'fence', valid_from: new Date(Date.UTC(2026, 6, 1 + i)),
    })) as never, { source_id: SRC });
    const kept = await readAsCallers(async () => (await relevance(engine, {
      arm: 'keyword', scope: scope({ excludePrivate: true }), vector: null, terms: 'tea', limit: 50,
    })).map(h => h.fact).sort());
    const open = ['tea entity:people/open-example', 'tea prov:notes/open'];
    const member = 'tea prov:memory/members/alice-example';
    expect(kept.none).toEqual(open);
    expect(kept.stranger).toEqual(open);
    expect(kept.member).toEqual([...open, member, 'tea entity:people/readers-example', 'tea entity:people/team-example'].sort());
    expect(kept.granted).toEqual([...open, member, 'tea entity:people/readers-example', 'tea entity:people/private-example'].sort());
    return kept;
  });

  parityTest('listFactsForRelevance entity arm reads one entity newest first, scores comparable vectors, and applies the filters', { methods: ['listFactsForRelevance'] }, async (engine) => {
    await remember(engine, [
      { fact: 'old', entity_slug: 'people/a', valid_from: at('2026-01-01T00:00:00Z'), source_session: 's1' },
      { fact: 'new 100% sure', entity_slug: 'people/a', valid_from: at('2026-03-01T00:00:00Z'), source_session: 's2' },
      { fact: 'mid', entity_slug: 'people/a', valid_from: at('2026-02-01T00:00:00Z'), source_session: 's1' },
      { fact: 'other entity', entity_slug: 'people/b', valid_from: at('2026-04-01T00:00:00Z') },
      { fact: 'sim near', entity_slug: 'people/v', embedding: basisEmbedding(0), embedding_model: 'm1' },
      { fact: 'sim far', entity_slug: 'people/v', embedding: basisEmbedding(1), embedding_model: 'm1' },
      { fact: 'sim other model', entity_slug: 'people/v', embedding: basisEmbedding(0), embedding_model: 'm2' },
      { fact: 'sim bare', entity_slug: 'people/v' },
      { fact: 'sim mid', entity_slug: 'people/v', embedding: Float32Array.from({ length: 1536 }, (_, i) => (i === 0 ? 0.6 : i === 1 ? 0.8 : 0)), embedding_model: 'm1' },
    ]);
    const entity = (slug: string) => ({ sourceId: SRC, slug });
    const read = (slug: string, extra: Partial<Parameters<BrainEngine['listFactsForRelevance']>[0]> = {}) =>
      relevance(engine, { arm: 'entity', scope: scope(), vector: null, entity: entity(slug), limit: 50, ...extra });
    const near0 = { literal: `[${Array.from(basisEmbedding(0)).join(',')}]`, type: 'halfvec' as const, model: 'm1', dims: 1536 };
    const rows = await read('people/v', { vector: near0 });
    expect(rows.find(r => r.fact === 'sim near')!.sim).toBe(1);
    expect(rows.find(r => r.fact === 'sim mid')!.sim).toBeGreaterThan(0.5);
    expect(rows.find(r => r.fact === 'sim other model')!.sim).toBeNull();
    const out = {
      newestFirst: await read('people/a'),
      limited: await read('people/a', { limit: 1 }),
      none: await read('people/zzz'),
      scored: rows,
      narrowed: {
        entities: await read('people/a', { filters: { entities: [entity('people/a')] } }),
        wrongEntity: await read('people/a', { filters: { entities: [entity('people/b')] } }),
        session: await read('people/a', { filters: { sessionId: 's1' } }),
        since: await read('people/a', { filters: { since: at('2026-02-01T00:00:00Z') } }),
        grep: await read('people/a', { filters: { grep: '100%' } }),
        grepFolded: await read('people/a', { filters: { grep: 'MID' } }),
      },
    };
    const names = (hits: Hit[]) => hits.map(h => h.fact);
    expect(names(out.newestFirst)).toEqual(['new 100% sure', 'mid', 'old']);
    expect(names(out.limited)).toEqual(['new 100% sure']);
    expect(out.none).toEqual([]);
    expect(names(out.narrowed.entities)).toEqual(['new 100% sure', 'mid', 'old']);
    expect(out.narrowed.wrongEntity).toEqual([]);
    expect(names(out.narrowed.session)).toEqual(['mid', 'old']);
    expect(names(out.narrowed.since)).toEqual(['new 100% sure', 'mid']);
    expect(names(out.narrowed.grep)).toEqual(['new 100% sure']);
    expect(names(out.narrowed.grepFolded)).toEqual(['mid']);
    return out;
  });

  parityTest('countUncomparableFacts counts, per source, the pool facts the cosine arm cannot compare', { methods: ['countUncomparableFacts'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await remember(engine, [
      { fact: 'ok', entity_slug: 'people/u', embedding: basisEmbedding(0), embedding_model: 'm1' },
      { fact: 'no vector', entity_slug: 'people/u' },
      { fact: 'other model', entity_slug: 'people/u', embedding: basisEmbedding(0), embedding_model: 'm2' },
      { fact: 'no model', entity_slug: 'people/u', embedding: basisEmbedding(0) },
      { fact: 'private world check', entity_slug: 'people/u', visibility: 'world' },
    ]);
    await remember(engine, [{ fact: 'bare in other', entity_slug: 'people/u' }, { fact: 'bare again', entity_slug: 'people/u' }], 'other');
    const gone = await remember(engine, [{ fact: 'expired bare', entity_slug: 'people/u' }]);
    await engine.expireFact(gone.get('expired bare')!);
    const count = (extra: Partial<Parameters<BrainEngine['countUncomparableFacts']>[0]> = {}) =>
      engine.countUncomparableFacts({ scope: { sourceIds: [SRC, 'other'], worldOnly: false, excludePrivate: false }, dims: 1536, model: 'm1', declared: true, ...extra });
    const out = {
      declared: await count(),
      undeclared: await count({ declared: false }),
      otherWidth: await count({ declared: false, dims: 3 }),
      worldOnly: await count({ scope: { sourceIds: [SRC, 'other'], worldOnly: true, excludePrivate: false } }),
      includeExpired: await count({ filters: { includeExpired: true } }),
    };
    const n = (rows: Array<{ source_id: string; n: number }>) => rows.map(r => `${r.source_id}:${r.n}`);
    // Declared: no vector, another model, no model and the bare row count; the world check row has no vector either.
    expect(n(out.declared)).toEqual(['default:4', 'other:2']);
    // Undeclared, three-valued: a vector with no model is unknown, not uncomparable.
    expect(n(out.undeclared)).toEqual(['default:3', 'other:2']);
    expect(n(out.otherWidth)).toEqual(['default:5', 'other:2']);
    expect(n(out.worldOnly)).toEqual(['default:1']);
    expect(n(out.includeExpired)).toEqual(['default:5', 'other:2']);
    return out;
  });

  parityTest('matchSavedFacts returns the active facts that share the query words, with their match count and trust rank', { methods: ['matchSavedFacts'] }, async (engine) => {
    await remember(engine, [
      { fact: 'Priya prefers dark roast coffee', entity_slug: 'people/priya', valid_from: at('2026-01-01T00:00:00Z') },
      { fact: 'Priya now prefers green tea', entity_slug: 'people/priya', valid_from: at('2026-02-01T00:00:00Z') },
      { fact: 'Correction: Priya prefers coffee with oat milk', entity_slug: 'people/priya', valid_from: at('2026-03-01T00:00:00Z') },
      { fact: 'Unrelated note about gardens', entity_slug: 'people/priya' },
    ]);
    const match = async (terms: string[], supersede: boolean) => {
      const rows = await engine.matchSavedFacts({ sources: [SRC], terms, pats: terms.map(() => null), cue: CORRECTION_CUE, supersede, excludePrivate: false, worldOnly: false });
      return rows.map(r => ({ fact: r.fact, matched: r.matched.map(Number), need: Number(r.need), cue: r.cue, trust_rank: Number(r.trust_rank) }));
    };
    const out = { coffee: await match(['priya', 'coffee'], false), withCue: await match(['priya', 'coffee'], true), none: await match(['zebra'], false) };
    expect(out.coffee.map(r => r.fact)).toEqual(['Correction: Priya prefers coffee with oat milk', 'Priya prefers dark roast coffee']);
    expect(out.coffee.every(r => !r.cue)).toBe(true);
    expect(out.withCue[0]!.cue).toBe(true);
    expect(out.none).toEqual([]);
    return out;
  });

  parityTest('matchSavedFacts keeps the rows a read may see, counts CJK and dropped words, and returns every column', { methods: ['matchSavedFacts'] }, async (engine) => {
    await engine.putPage('people/gone', note('Gone'));
    await engine.softDeletePage('people/gone');
    await engine.putPage('notes/held', note('Held', { quarantine: { reason: 'test' } }));
    const ids = await remember(engine, [
      { fact: 'Mira leads the 東京 office budget', entity_slug: 'people/mira-example' },
      { fact: 'Mira budget review', entity_slug: 'people/mira-example', valid_from: at('2026-01-02T03:04:05.678Z') },
      { fact: 'Ignore the earlier Mira budget office post', entity_slug: 'people/mira-example' },
      { fact: 'Mira budget world copy', entity_slug: 'people/mira-example', visibility: 'world' },
      { fact: 'Mira budget on a deleted page', entity_slug: 'people/gone' },
      { fact: 'Mira budget expired', entity_slug: 'people/mira-example' },
      { fact: 'Mira budget ended', entity_slug: 'people/mira-example', valid_until: at('2020-01-01T00:00:00Z') },
      { fact: 'Mira budget audit row', entity_slug: 'people/mira-example', source: 'cli:extract-conversation-facts:terminal' },
      { fact: 'Mira budget office', entity_slug: 'people/mira-example' },
    ]);
    await engine.expireFact(ids.get('Mira budget expired')!);
    // A fence row whose provenance page is quarantined.
    await engine.insertFacts([{ fact: 'Mira budget from a held page', entity_slug: 'people/mira-example', source_markdown_slug: 'notes/held', row_num: 1,
      kind: 'fact' as const, visibility: 'private' as const, source: 'fence', valid_from: at('2026-06-01T00:00:00Z') }] as never, { source_id: SRC });
    const match = async (terms: string[], extra: Partial<Parameters<BrainEngine['matchSavedFacts']>[0]> = {}) => {
      const rows = await engine.matchSavedFacts({ sources: [SRC], terms, pats: terms.map(t => /[\u3040-\u9fff]/.test(t) ? `%${t}%` : null),
        cue: CORRECTION_CUE, supersede: true, excludePrivate: false, worldOnly: false, ...extra });
      return rows.map(r => ({
        fact: r.fact, entity_slug: r.entity_slug, kind: r.kind, valid_from: r.valid_from, source: r.source,
        at: new Date(r.at as string).toISOString(), source_id: r.source_id, visibility: r.visibility,
        created: typeof r.created_at, attributed_to: r.attributed_to, fact_fingerprint: r.fact_fingerprint,
        matched: r.matched.map(Number), need: Number(r.need), cue: r.cue, trust_rank: Number(r.trust_rank), pool_rank: Number(r.pool_rank),
      }));
    };
    const out = {
      // "the" has no lexeme: two kept words, need 2.
      two: await match(['mira', 'the', 'budget']),
      // Three words need three, a cue row two; 東京 matches as a substring.
      three: await match(['budget', '東京', 'office']),
      noCue: await match(['budget', '東京', 'office'], { supersede: false }),
      world: await match(['mira', 'budget'], { worldOnly: true }),
      floor: await match(['mira', 'budget'], { minTrust: 'operator_curated' }),
      dropped: await match(['the', 'a']),
    };
    const facts = (rows: Array<{ fact: string }>) => rows.map(r => r.fact);
    expect(facts(out.two)).toEqual(['Mira budget office', 'Mira budget world copy', 'Ignore the earlier Mira budget office post',
      'Mira leads the 東京 office budget', 'Mira budget review']);
    expect(out.two.every(r => r.need === 2)).toBe(true);
    expect(out.two.find(r => r.fact === 'Mira budget review')!.valid_from).toBe('2026-01-02 03:04:05.678+00');
    expect(facts(out.three)).toEqual(['Mira leads the 東京 office budget', 'Ignore the earlier Mira budget office post']);
    expect(out.three.map(r => r.matched)).toEqual([[1, 2, 3], [1, 3]]);
    expect(out.three.map(r => r.cue)).toEqual([false, true]);
    expect(facts(out.noCue)).toEqual(['Mira leads the 東京 office budget']);
    expect(facts(out.world)).toEqual(['Mira budget world copy']);
    expect(out.dropped).toEqual([]);
    return out;
  });

  parityTest('matchSavedFacts applies the word threshold, CJK substrings, the cue pool and the read policy, and returns each row\'s columns', { methods: ['matchSavedFacts'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/open', note('Open'));
    await engine.putPage('notes/quarantined', note('Quarantined', { quarantine: { reason: 'junk_pattern' } }));
    await engine.putPage('notes/deleted', note('Deleted'));
    await engine.putPage('notes/private', note('Private', { visibility: 'private' }));
    await remember(engine, [
      { fact: 'Orbix ships widgets from Lisbon every spring', entity_slug: 'companies/orbix', valid_from: at('2026-01-01T00:00:00Z'), visibility: 'world' },
      { fact: 'Orbix ships widgets', entity_slug: 'companies/orbix', valid_from: at('2026-02-01T00:00:00Z'), visibility: 'world' },
      { fact: 'Orbix widgets are blue', entity_slug: 'companies/orbix', valid_from: at('2026-03-01T00:00:00Z') },
      { fact: 'Disregard what I said about Orbix widgets', entity_slug: 'companies/orbix', valid_from: at('2026-04-01T00:00:00Z') },
      { fact: 'Orbix widgets in Lisbon', entity_slug: 'people/zed', valid_from: at('2026-04-01T00:00:00Z') },
      { fact: 'オルビクスは東京で生産する', entity_slug: 'companies/orbix', valid_from: at('2026-05-01T00:00:00Z'), visibility: 'world' },
      { fact: 'Orbix widgets audit', source: 'cli:extract-conversation-facts:terminal:v2', entity_slug: 'companies/orbix' },
      { fact: 'Orbix widgets lapsed', valid_until: at('2020-01-01T00:00:00Z'), entity_slug: 'companies/orbix' },
      { fact: 'Lisbon spring widgets', entity_slug: 'companies/orbix-lisbon', valid_from: at('2026-06-01T00:00:00Z') },
    ]);
    await engine.insertFacts(['open', 'private', 'quarantined', 'deleted'].map((page, i) => ({
      fact: `Orbix widgets on the ${page} page`, entity_slug: 'companies/orbix', source_markdown_slug: `notes/${page}`, row_num: 1,
      kind: 'fact' as const, visibility: 'world' as const, source: 'fence', valid_from: new Date(Date.UTC(2026, 6, 1 + i)),
    })) as never, { source_id: SRC });
    const forgotten = await remember(engine, [{ fact: 'Orbix widgets forgotten', entity_slug: 'companies/orbix' }]);
    await engine.expireFact(forgotten.get('Orbix widgets forgotten')!);
    await remember(engine, [{ fact: 'Orbix widgets in another source', entity_slug: 'companies/orbix' }], 'other');
    await engine.softDeletePage('notes/deleted');
    const cjk = (t: string) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(t) ? `%${t}%` : null;
    const match = async (terms: string[], extra: Partial<Parameters<BrainEngine['matchSavedFacts']>[0]> = {}) => {
      const rows = await engine.matchSavedFacts({ sources: [SRC], terms, pats: terms.map(cjk), cue: CORRECTION_CUE, supersede: false, excludePrivate: false, worldOnly: false, ...extra });
      return rows.map(r => ({
        fact: r.fact, entity_slug: r.entity_slug, kind: r.kind, valid_from: r.valid_from, source: r.source, at: new Date(r.at as string).toISOString(),
        source_id: r.source_id, visibility: r.visibility, attributed_to: r.attributed_to ?? null, fact_fingerprint: r.fact_fingerprint,
        matched: r.matched.map(Number), need: Number(r.need), cue: r.cue, trust_rank: Number(r.trust_rank), pool_rank: Number(r.pool_rank),
      }));
    };
    const facts = (rows: Array<{ fact: string }>) => rows.map(r => r.fact);
    const out = {
      three: await match(['orbix', 'widgets', 'lisbon']),
      cue: await match(['orbix', 'widgets', 'lisbon'], { supersede: true }),
      one: await match(['spring']),
      stopWord: await match(['the', 'orbix', 'about']),
      cjk: await match(['東京', '生産']),
      cjkHalf: await match(['東京', '大阪']),
      worldOnly: await match(['orbix', 'widgets'], { worldOnly: true }),
      excludePrivate: await match(['orbix', 'widgets'], { excludePrivate: true }),
      floorUnknown: await match(['orbix', 'widgets'], { minTrust: 'unknown' }),
      floorAgent: await match(['orbix', 'widgets'], { minTrust: 'agent_written' }),
      twoSources: await match(['orbix', 'widgets'], { sources: [SRC, 'other'] }),
      none: await match(['zebra']),
    };
    // Three words need all three. The entity name counts, but 'companies/orbix lisbon' parses as a path token and a word, so
    // the row on companies/orbix-lisbon matches 'lisbon' and not 'orbix'; words match by stem ('ships', 'widgets').
    expect(facts(out.three)).toEqual(['Orbix widgets in Lisbon', 'Orbix ships widgets from Lisbon every spring']);
    expect(out.three[0]).toMatchObject({ matched: [1, 2, 3], need: 3, cue: false, trust_rank: 2, pool_rank: 1, valid_from: '2026-04-01 00:00:00+00', at: '2026-04-01T00:00:00.000Z' });
    // With supersede on, a cue row matching two of three words is kept in its own pool.
    expect(out.three.find(r => r.fact === 'Disregard what I said about Orbix widgets')).toBeUndefined();
    expect(out.cue.find(r => r.fact === 'Disregard what I said about Orbix widgets')).toMatchObject({ matched: [1, 2], need: 3, cue: true, pool_rank: 1 });
    expect(facts(out.stopWord)).toEqual(expect.arrayContaining(['Disregard what I said about Orbix widgets']));
    expect(out.stopWord.every(r => r.need === 1 && r.matched.join() === '2')).toBe(true);
    expect(facts(out.cjk)).toEqual(['オルビクスは東京で生産する']);
    expect(out.cjk[0]).toMatchObject({ matched: [1, 2], need: 2 });
    expect(out.cjkHalf).toEqual([]);
    expect(facts(out.worldOnly)).not.toContain('Orbix widgets are blue');
    expect(facts(out.floorUnknown)).toContain('Orbix widgets are blue');
    expect(facts(out.excludePrivate)).not.toContain('Orbix widgets on the private page');
    expect(facts(out.floorUnknown)).toContain('Orbix widgets on the open page');
    const shown = facts(out.floorUnknown);
    for (const hidden of ['Orbix widgets audit', 'Orbix widgets lapsed', 'Orbix widgets forgotten', 'Orbix widgets on the quarantined page', 'Orbix widgets on the deleted page', 'Orbix widgets in another source']) {
      expect(shown).not.toContain(hidden);
    }
    expect(out.floorAgent).toEqual([]);
    expect(facts(out.twoSources)).toContain('Orbix widgets in another source');
    expect(out.none).toEqual([]);
    return out;
  });

  parityTest('matchSavedFacts under excludePrivate applies a caller\'s reader identity, own member page and private-readable grant', { methods: ['matchSavedFacts'] }, async (engine) => {
    await putCallerPages(engine);
    await engine.insertFacts(callerFactRows().map((r, i) => ({
      ...r, fact: `tea ${r.fact}`, kind: 'fact' as const, visibility: 'world' as const, source: 'fence', valid_from: new Date(Date.UTC(2026, 6, 1 + i)),
    })) as never, { source_id: SRC });
    return readAsCallers(async () => (await engine.matchSavedFacts({ sources: [SRC], terms: ['tea'], pats: [null], cue: CORRECTION_CUE, supersede: false, excludePrivate: true, worldOnly: false }))
      .map(r => r.fact).sort());
  });

  parityTest('readFactForOwnerAction returns the fact an owner action binds to, or null for an id no fact has', { methods: ['readFactForOwnerAction'] }, async (engine) => {
    const ids = await remember(engine, [
      { fact: 'Pat leads Acme', entity_slug: 'people/pat', claim_metric: 'headcount', claim_value: 12, claim_unit: 'people', claim_period: '2026-Q1' },
      { fact: 'Pat left Acme', entity_slug: 'people/pat' },
    ]);
    await engine.expireFact(ids.get('Pat left Acme')!, { supersededBy: ids.get('Pat leads Acme')! });
    const read = async (id: number) => {
      const row = await engine.readFactForOwnerAction(id);
      if (!row) return null;
      const { id: _id, superseded_by, ...rest } = row as Record<string, unknown>;
      return { ...rest, superseded: superseded_by != null, expired: rest.expired_at != null, expired_at: undefined };
    };
    const out = { live: await read(ids.get('Pat leads Acme')!), ended: await read(ids.get('Pat left Acme')!), missing: await engine.readFactForOwnerAction(987654321) };
    expect(out.live).toMatchObject({ fact: 'Pat leads Acme', trust_tier: 'unknown', claim_metric: 'headcount', superseded: false, expired: false });
    expect(out.ended).toMatchObject({ fact: 'Pat left Acme', superseded: true, expired: true });
    expect(out.missing).toBeNull();
    return out;
  });

  parityTest('listStandingPreferences lists flagged standing instructions awaiting the owner (none without a write-gate receipt)', { methods: ['listStandingPreferences'] }, async (engine) => {
    await remember(engine, [
      { fact: 'Always reply in French', kind: 'preference', entity_slug: 'people/pat' },
      { fact: 'Send the report every Friday', kind: 'commitment', entity_slug: 'people/pat' },
    ]);
    // No typed method records a write-gate receipt, so the flagged set is empty on every arm.
    const out = { all: await engine.listStandingPreferences({}), source: await engine.listStandingPreferences({ sourceId: SRC }), since: await engine.listStandingPreferences({ since: at('2020-01-01T00:00:00Z') }) };
    expect(out).toEqual({ all: [], source: [], since: [] });
    return out;
  });

  parityTest('listLexicalContestCandidates returns the active facts on the slot that are more trusted than the writer', { methods: ['listLexicalContestCandidates'] }, async (engine) => {
    await engine.putPage('memory/members/pat', note('Pat'));
    await remember(engine, [
      { fact: 'Pat lives in Lisbon', entity_slug: 'people/pat', kind: 'fact', visibility: 'private' },
      { fact: 'Pat lives in Faro', entity_slug: 'people/pat', kind: 'fact', visibility: 'private', valid_until: at('2020-01-01T00:00:00Z') },
    ]);
    // The member-page fact is a fence row: insertFact does not carry the page.
    await engine.insertFacts([{ fact: 'Pat lives in Porto', entity_slug: 'people/pat', source_markdown_slug: 'memory/members/pat', row_num: 1,
      kind: 'fact' as const, visibility: 'private' as const, source: 'fence', valid_from: at('2026-06-01T00:00:00Z') }] as never, { source_id: SRC });
    const read = async (writer: 'agent_written' | 'unknown' | 'external_untrusted' | 'user_confirmed', pageSlug?: string) =>
      (await engine.listLexicalContestCandidates({ sourceId: SRC, entitySlug: 'people/pat', kind: 'fact', visibility: 'private', pageSlug, writer })).map(r => ({ fact: r.fact, trust_tier: r.trust_tier }));
    const out = { external: await read('external_untrusted'), agent: await read('agent_written'), confirmed: await read('user_confirmed'), memberPage: await read('external_untrusted', 'memory/members/pat') };
    // Typed writes are tier unknown (rank 2): a lower-tier writer contests them, an equal or higher one does not.
    expect(out.external.map(r => r.fact)).toEqual(['Pat lives in Lisbon']);
    expect(out.agent).toEqual([]);
    expect(out.confirmed).toEqual([]);
    expect(out.memberPage.map(r => r.fact)).toEqual(['Pat lives in Porto']);
    return out;
  });

  parityTest('listRestatedPrivateCopies returns the private copy of a claim unless a world copy states it', { methods: ['listRestatedPrivateCopies'] }, async (engine) => {
    await remember(engine, [
      { fact: 'Pat owns the Acme account', entity_slug: 'people/pat', visibility: 'private' },
      { fact: 'Sam owns the Beta account', entity_slug: 'people/sam', visibility: 'private' },
      { fact: 'Sam owns the Beta account', entity_slug: 'people/sam', visibility: 'world' },
      { fact: 'Unattached claim', entity_slug: null, visibility: 'private' },
    ]);
    const read = async (claim: string, entity: string | null, writer: 'external_untrusted' | 'user_confirmed' = 'external_untrusted') =>
      (await engine.listRestatedPrivateCopies({ sourceId: SRC, claim, entity, writer })).map(r => ({ visibility: r.visibility, trust_tier: r.trust_tier }));
    const out = {
      restated: await read('Pat owns the Acme account', 'people/pat'),
      liftedByWorldCopy: await read('Sam owns the Beta account', 'people/sam'),
      noEntity: await read('Unattached claim', null),
      wrongEntity: await read('Pat owns the Acme account', 'people/sam'),
      moreTrustedWriter: await read('Pat owns the Acme account', 'people/pat', 'user_confirmed'),
    };
    expect(out.restated).toEqual([{ visibility: 'private', trust_tier: 'unknown' }]);
    expect(out.liftedByWorldCopy).toEqual([]);
    expect(out.noEntity).toHaveLength(1);
    expect(out.wrongEntity).toEqual([]);
    expect(out.moreTrustedWriter).toEqual([]);
    return out;
  });

  parityTest('countDerivedFactTaint counts facts whose write origin names taint inputs (zero for typed writes)', { methods: ['countDerivedFactTaint'] }, async (engine) => {
    await remember(engine, [{ fact: 'A plain fact', entity_slug: 'people/pat' }, { fact: 'Another fact', entity_slug: 'people/pat' }]);
    // A typed write records no write origin, so no fact is derived on any arm.
    const out = await engine.countDerivedFactTaint();
    expect(out).toEqual({ derived: 0, external: 0 });
    return out;
  });
});
