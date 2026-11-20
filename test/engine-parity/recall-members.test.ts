/**
 * BrainEngine parity: the candidate-pool reads a recall, a search and a facts block make (engine-sql/facts-recall.ts, called
 * from search/fact-relevance.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readFactsEmbeddingColumn, listNearestFacts, listSlotRows, listPoolUnbackedKeys, listCallOffCueFacts and
 *    listPoolEntityPairs return the same observable result on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm with GBRAIN_TEST_RUST_ARM=1). The edges are the ones the other file leaves out: the neighbour limit and the
 *    model and width filters, a fact with no embedding, a mismatched query width, slots of two sources, an entity whose page was
 *    deleted, cue words inside longer words, and a plural or past form of a cue.
 *  - Regression: the Rust brain refused all six with engine_capability_missing, so a recall, a search that adds facts and a
 *    question that reads a slot window or a call-off stopped on a Rust brain; an engine that answered one differently would change
 *    which facts a recall pools, which entity names it treats as unbacked and which later fact calls an earlier one off.
 *  - Why existing coverage misses it: test/engine-parity/facts-rest-sites.test.ts compares these members together with members
 *    the Rust brain still refuses, so its Rust arm stops at the first of those and never reaches them. The whole case here drives
 *    collectFactCandidates, laterRetractions, readSlotRows, poolUnbackedKeys and poolEntityPairs, the functions the search and the
 *    question recall call, so a stop on a member the Rust brain still refuses is named in the tally.
 *  - Seam: none. The facts and pages are seeded through typed members. Fact ids differ between arms: rows are named by fact text.
 *    Generated timestamps are folded to the stored valid_from, which each case sets.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { collectFactCandidates, laterRetractions, poolEntityPairs, poolUnbackedKeys, readSlotRows } from '../../src/core/search/fact-relevance.ts';
import { basisEmbedding, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const CONVERSATION = 'cli:extract-conversation-facts:chat';
const at = (s: string) => new Date(s);
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const round = (n: unknown) => (n == null ? null : Math.round(Number(n) * 1e5) / 1e5);
const note = (title: string, type = 'note') => ({ type: type as 'note', title, compiled_truth: 'x', frontmatter: {} });
const scope = (extra: Record<string, unknown> = {}) => ({ sourceId: SRC, worldOnly: false, excludePrivate: false, ...extra }) as never;
const key = (source_id: string, entity_slug: string) => ({ source_id, entity_slug });

type Seed = Partial<Parameters<BrainEngine['insertFact']>[0]> & { fact: string };

/** Insert facts one by one, in array order, and name each id by its fact text. */
async function remember(engine: BrainEngine, rows: Seed[], sourceId = SRC): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const [i, row] of rows.entries()) {
    const r = await engine.insertFact({ source: 'mcp:remember', entity_slug: null, valid_from: new Date(Date.UTC(2026, 4, 1 + i)), ...row }, { source_id: sourceId });
    ids.set(row.fact, r.id);
  }
  return ids;
}

/** Fence-style rows (they carry `source_markdown_slug`, which insertFact does not), named by fact text. */
async function fenced(engine: BrainEngine, rows: Array<Record<string, unknown> & { fact: string }>, sourceId = SRC): Promise<Map<string, number>> {
  const res = await engine.insertFacts(rows.map((r, i) => ({
    entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', row_num: i + 1, valid_from: new Date(Date.UTC(2026, 6, 1 + i)), ...r,
  })) as never, { source_id: sourceId });
  return new Map(rows.map((r, i) => [r.fact, Number(res.ids[i])]));
}

const namer = (names: Map<string, number>) => {
  const byId = new Map([...names].map(([name, id]) => [Number(id), name]));
  return (id: number | string | bigint) => byId.get(Number(id)) ?? `unknown:${id}`;
};

type Row = { id: number | string | bigint; fact: string; entity_slug: string | null; source_id: string; visibility?: string; valid_from: unknown; similarity?: number | null };
const view = (name: (id: number | string | bigint) => string) => (r: Row) => ({
  fact: r.fact, name: name(r.id), entity: r.entity_slug, source: r.source_id, visibility: r.visibility ?? null, from: iso(r.valid_from), sim: round(r.similarity),
});
const byFact = <T extends { fact: string }>(rows: T[]) => [...rows].sort((a, b) => a.fact.localeCompare(b.fact));

describe('engine parity: the candidate-pool reads of a recall', () => {
  parityTest('listNearestFacts ranks by cosine under the model and width filters, and cuts at the limit', {
    methods: ['readFactsEmbeddingColumn', 'listNearestFacts', 'insertFact', 'expireFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const mid = Float32Array.from({ length: 1536 }, (_, i) => (i === 0 ? 0.6 : i === 1 ? 0.8 : 0));
    const far = Float32Array.from({ length: 1536 }, (_, i) => (i === 2 ? 1 : 0));
    const ids = await remember(engine, [
      { fact: 'same direction', entity_slug: 'people/a', embedding: basisEmbedding(0), embedding_model: 'm1' },
      { fact: 'near', entity_slug: 'people/a', embedding: mid, embedding_model: 'm1' },
      { fact: 'orthogonal', entity_slug: 'people/a', embedding: far, embedding_model: 'm1' },
      { fact: 'opposite', entity_slug: 'people/a', embedding: Float32Array.from({ length: 1536 }, (_, i) => (i === 0 ? -1 : 0)), embedding_model: 'm1' },
      { fact: 'other model', entity_slug: 'people/a', embedding: basisEmbedding(0), embedding_model: 'm2' },
      { fact: 'no vector', entity_slug: 'people/a' },
      { fact: 'no entity', embedding: mid, embedding_model: 'm1' },
      { fact: 'ended', entity_slug: 'people/a', embedding: basisEmbedding(0), embedding_model: 'm1' },
    ]);
    await engine.expireFact(ids.get('ended')!);
    const elsewhere = await remember(engine, [{ fact: 'in other source', entity_slug: 'people/b', embedding: basisEmbedding(0), embedding_model: 'm1' }], 'other');
    const name = namer(new Map([...ids, ...elsewhere]));
    const column = (await engine.readFactsEmbeddingColumn())!;
    const lit = (v: Float32Array) => `[${Array.from(v).join(',')}]`;
    const vector = (v: Float32Array, model = 'm1', dims = v.length) => ({ literal: lit(v), type: 'halfvec' as const, model, dims });
    const read = async (extra: Record<string, unknown> = {}) =>
      (await engine.listNearestFacts({ scope: scope(), vector: vector(basisEmbedding(0)), declared: true, limit: 10, ...extra } as never)).map(view(name));
    const out = {
      column,
      ranked: await read(),
      limit2: await read({ limit: 2 }),
      limit0: await read({ limit: 0 }),
      otherModel: await read({ vector: vector(basisEmbedding(0), 'm2') }),
      unknownModel: await read({ vector: vector(basisEmbedding(0), 'm9') }),
      twoSources: await read({ scope: { sourceIds: [SRC, 'other'], worldOnly: false, excludePrivate: false } }),
      nearQuery: await read({ vector: vector(mid) }),
    };
    expect(column.dims).toBe(1536);
    expect(out.ranked.map(r => r.fact)).toEqual(['same direction', 'near', 'no entity', 'orthogonal', 'opposite']);
    expect(out.ranked[0]!.sim).toBe(1);
    expect(out.limit2.map(r => r.fact)).toEqual(['same direction', 'near']);
    expect(out.limit0).toEqual([]);
    expect(out.otherModel.map(r => r.fact)).toEqual(['other model']);
    expect(out.unknownModel).toEqual([]);
    expect(out.twoSources.map(r => r.fact)).toContain('in other source');
    return out;
  });

  parityTest('listSlotRows reads the active conversation slot rows of slots in two sources, and leaves out ended, superseded and unhashed rows', {
    methods: ['listSlotRows', 'insertFacts', 'expireFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const slot = (extra: Record<string, unknown> & { fact: string }) => ({ entity_slug: 'people/a', source: CONVERSATION, dimension: 'location', source_markdown_slug: 'notes/open', ...extra });
    const own = await fenced(engine, [
      slot({ fact: 'first', value: 'Lisbon', valid_from: at('2026-01-01T00:00:00Z') }),
      slot({ fact: 'second', value: 'Porto', valid_from: at('2026-03-01T00:00:00Z') }),
      slot({ fact: 'same time', value: 'Faro', valid_from: at('2026-03-01T00:00:00Z') }),
      slot({ fact: 'ended', value: 'Rome', valid_from: at('2026-02-01T00:00:00Z') }),
      slot({ fact: 'no value', value: null, valid_from: at('2026-02-02T00:00:00Z') }),
      slot({ fact: 'other dimension', dimension: 'employer', value: 'Acme', valid_from: at('2026-02-03T00:00:00Z') }),
      slot({ fact: 'other entity', entity_slug: 'people/b', value: 'Oslo', valid_from: at('2026-02-04T00:00:00Z') }),
    ]);
    await engine.expireFact(own.get('ended')!);
    const elsewhere = await fenced(engine, [slot({ fact: 'in other source', value: 'Bern', valid_from: at('2026-02-05T00:00:00Z') })], 'other');
    const name = namer(new Map([...own, ...elsewhere]));
    const slotOf = (source_id: string, entity_slug: string, dimension: string) => ({ source_id, entity_slug, dimension });
    const read = async (slots: ReturnType<typeof slotOf>[], extra: Record<string, unknown> = {}) =>
      (await engine.listSlotRows(scope(extra), slots)).map(r => ({ ...view(name)(r), dimension: r.dimension }));
    const out = {
      location: await read([slotOf(SRC, 'people/a', 'location')]),
      twoSources: await read([slotOf(SRC, 'people/a', 'location'), slotOf('other', 'people/a', 'location')], { sourceIds: [SRC, 'other'] }),
      sourceNotInScope: await read([slotOf('other', 'people/a', 'location')]),
      mixed: await read([slotOf(SRC, 'people/a', 'employer'), slotOf(SRC, 'people/b', 'location')]),
    };
    expect(out.location.map(r => r.fact)).toEqual(['first', 'second', 'same time']);
    expect(out.sourceNotInScope).toEqual([]);
    expect(out.mixed.map(r => r.fact)).toEqual(['other dimension', 'other entity']);
    return out;
  });

  parityTest('listCallOffCueFacts matches the cue words whole, newest first, and listPoolUnbackedKeys skips an entity whose page is live', {
    methods: ['listCallOffCueFacts', 'listPoolUnbackedKeys', 'listPoolEntityPairs', 'insertFact', 'putPage', 'deletePage'],
  }, async (engine) => {
    await engine.putPage('people/live', note('Live', 'person'));
    await engine.putPage('people/gone', note('Gone', 'person'));
    await engine.deletePage('people/gone');
    const cue = (fact: string, entity_slug: string, day: number) => ({ fact, entity_slug, valid_from: new Date(Date.UTC(2026, 5, day)) });
    const ids = await remember(engine, [
      cue('the launch was cancelled', 'people/live', 1),
      cue('the launch was cancelledX', 'people/live', 2),
      cue('Canceled for good', 'people/live', 3),
      cue('please disregard the invoice', 'people/live', 4),
      cue('RETRACTED by the sender', 'people/live', 5),
      cue('I misspoke about the date', 'people/live', 6),
      cue('that is not what I said', 'people/live', 7),
      cue('ignore that plan', 'people/live', 8),
      cue('a rumor about the merger', 'people/live', 9),
      cue('the retractor is a tool', 'people/live', 10),
      cue('nothing is called off-site', 'people/live', 11),
      cue('it fell through', 'people/gone', 12),
      cue('no cue words at all', 'people/gone', 13),
      cue('it is no longer planned', 'people/nobody', 14),
    ]);
    const name = namer(ids);
    const read = async (keys: ReturnType<typeof key>[], extra: Record<string, unknown> = {}) =>
      (await engine.listCallOffCueFacts(scope(extra), keys)).map(view(name));
    const out = {
      live: await read([key(SRC, 'people/live')]),
      goneAndNobody: await read([key(SRC, 'people/gone'), key(SRC, 'people/nobody')]),
      wrongSource: await read([key('other', 'people/live')]),
      unbacked: await engine.listPoolUnbackedKeys(scope(), ['people/live', 'people/gone', 'people/nobody'], 10),
      unbackedLimit1: await engine.listPoolUnbackedKeys(scope(), ['people/live', 'people/gone', 'people/nobody'], 1),
      unbackedNoKeys: await engine.listPoolUnbackedKeys(scope(), [], 10),
      pairs: await engine.listPoolEntityPairs(scope(), {}),
    };
    expect(out.live.map(r => r.fact)).toEqual([
      'nothing is called off-site', 'a rumor about the merger', 'ignore that plan', 'that is not what I said', 'I misspoke about the date',
      'RETRACTED by the sender', 'please disregard the invoice', 'Canceled for good', 'the launch was cancelled',
    ]);
    expect(out.live.map(r => r.fact)).not.toContain('the launch was cancelledX');
    expect(out.live.map(r => r.fact)).not.toContain('the retractor is a tool');
    expect(out.goneAndNobody.map(r => r.fact).sort()).toEqual(['it fell through', 'it is no longer planned']);
    expect(out.wrongSource).toEqual([]);
    expect(out.unbacked).toEqual([key(SRC, 'people/gone'), key(SRC, 'people/nobody')]);
    expect(out.unbackedLimit1).toEqual([key(SRC, 'people/gone')]);
    expect(out.unbackedNoKeys).toEqual([]);
    return out;
  });

  parityTest('the pool functions a search and a recall call read a whole pool: candidates, later retractions, slot windows, unbacked names and entity pairs', {
    methods: ['readFactsEmbeddingColumn', 'listNearestFacts', 'listFactsForRelevance', 'listSlotRows', 'listPoolUnbackedKeys', 'listCallOffCueFacts',
      'listPoolEntityPairs', 'insertFact', 'insertFacts', 'putPage', 'listPagesTitledIn', 'wordLexemes'],
  }, async (engine) => {
    await engine.putPage('people/alice', note('Alice', 'person'));
    const mid = Float32Array.from({ length: 1536 }, (_, i) => (i === 0 ? 0.6 : i === 1 ? 0.8 : 0));
    const ids = await remember(engine, [
      { fact: 'alice plans a trip to lisbon', entity_slug: 'people/alice', embedding: mid, embedding_model: 'm1', valid_from: at('2026-05-01T00:00:00Z') },
      { fact: 'alice trip to lisbon was cancelled', entity_slug: 'people/alice', valid_from: at('2026-05-03T00:00:00Z') },
      { fact: 'bob keeps bees', entity_slug: 'people/bob', embedding: basisEmbedding(0), embedding_model: 'm1', valid_from: at('2026-05-02T00:00:00Z') },
    ]);
    const slots = await fenced(engine, [
      { fact: 'alice lives in lisbon', entity_slug: 'people/alice', source: CONVERSATION, dimension: 'location', value: 'Lisbon', valid_from: at('2026-01-01T00:00:00Z'), source_markdown_slug: 'notes/open' },
    ]);
    const name = namer(new Map([...ids, ...slots]));
    const pool = await collectFactCandidates(engine, 'trip lisbon', scope(), basisEmbedding(0), { depth: { keyword: 10, cosine: 10, entity: 10 } });
    const candidates = byFact(pool.candidates.map(c => ({ ...view(name)(c as never), entityHit: c.entity })));
    const later = await laterRetractions(engine, scope(), pool.candidates);
    const retractions = [...later].map(([id, rows]) => [name(id), rows.map(r => r.fact)]);
    const windows = (await readSlotRows(engine, scope(), [{ source_id: SRC, entity_slug: 'people/alice', dimension: 'location' }])).map(view(name));
    const out = {
      cosine: pool.cosine, column: pool.column, candidates, retractions, windows,
      unbacked: await poolUnbackedKeys(engine, scope(), ['people/alice', 'people/bob'], 10),
      pairs: await poolEntityPairs(engine, scope(), {}),
    };
    expect(out.cosine).toBe(true);
    expect(out.candidates.map(c => c.fact)).toContain('alice plans a trip to lisbon');
    expect(out.retractions).toEqual([['alice plans a trip to lisbon', ['alice trip to lisbon was cancelled']]]);
    expect(out.unbacked).toEqual([key(SRC, 'people/bob')]);
    return out;
  });
});
