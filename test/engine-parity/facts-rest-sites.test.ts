/**
 * BrainEngine parity: the facts write-path and recall-pool statements that left `executeRaw` (engine-sql/facts-trust.ts and
 * engine-sql/facts-recall.ts, called from facts/*.ts, search/fact-relevance.ts and ops/facts.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readPendingWriteReceipt, lockSourceShared, lockAgentWritebackSetting, listOversizedStaleFacts, listLivePersonTitles,
 *    readLiveFactEntityPage, listFactsToRetireFromPage, listContestedProposalPairs, listFactProvenance,
 *    readFactsFtsIndexState, swapFactsFtsIndex, readFactsEmbeddingColumn, listNearestFacts, listSlotRows,
 *    listPoolUnbackedKeys, listCallOffCueFacts, listPoolEntityPairs and listFactRowsByIds return the same observable
 *    result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes which receipt or lock a write waits on, which
 *    facts a retire or an embedding backfill picks, which proposals a recall flags as contested, which facts recall pools,
 *    ranks and calls off, and whether the keyword index swap leaves search an index. The Rust engine has no SQL, so each
 *    read and write has to exist as a typed member it can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call (D18), so
 *    no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: none for the facts, pages and proposals, which are seeded through typed members. A write-gate
 *    receipt has no typed writer, so readPendingWriteReceipt is compared on a request with none (its text is pinned in
 *    test/facts-rest-sites-sql-pin.test.ts). Fact ids differ between arms: rows are named by fact text. Generated timestamps
 *    are compared by shape or by relation, never by value. The keyword index swap runs through ensureFactsFtsIndex and
 *    restores the language it started with.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { ensureFactsFtsIndex } from '../../src/core/facts/fts-index.ts';
import { getFtsLanguage } from '../../src/core/fts-language.ts';
import { basisEmbedding, createSource, archiveSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const at = (s: string) => new Date(s);
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const PG_TEXT = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/;
const CONVERSATION = 'cli:extract-conversation-facts:chat';
const note = (title: string, frontmatter: Record<string, unknown> = {}, type = 'note') =>
  ({ type: type as 'note', title, compiled_truth: 'x', frontmatter });

type Seed = Partial<Parameters<BrainEngine['insertFact']>[0]> & { fact: string };

/** Insert facts one by one, in array order, and name each id by its fact text (each row keeps a fixed valid_from). */
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

/** Maps generated ids back to the names a case gave them. */
const namer = (names: Map<string, number>) => {
  const byId = new Map([...names].map(([name, id]) => [Number(id), name]));
  return (id: number | string | bigint) => byId.get(Number(id)) ?? `unknown:${id}`;
};

/** The whole fact rows of one entity, expired ones included, in fact order, as the keys a case compares. */
async function factState(engine: BrainEngine, slug: string, name: (id: number | string | bigint) => string, sourceId = SRC) {
  const rows = await engine.listFactsByEntity(sourceId, slug, { activeOnly: false, limit: 100 } as never);
  return rows.map(r => ({
    fact: r.fact, expired: r.expired_at != null, valid_until: iso(r.valid_until),
    superseded_by: r.superseded_by == null ? null : name(r.superseded_by),
  })).sort((a, b) => a.fact.localeCompare(b.fact));
}

const scope = (extra: Record<string, unknown> = {}) => ({ sourceId: SRC, worldOnly: false, excludePrivate: false, ...extra }) as never;

describe('engine parity: facts write-path and recall statements that left executeRaw', () => {
  parityTest('readPendingWriteReceipt finds no receipt for a request nothing queued', { methods: ['readPendingWriteReceipt'] }, async (engine) => {
    const found = await engine.readPendingWriteReceipt('mcp', 'alice-example', randomUUID());
    expect(found).toBeNull();
    return { found };
  });

  parityTest('lockSourceShared and lockAgentWritebackSetting take their locks inside a transaction and return nothing', {
    methods: ['lockSourceShared', 'lockAgentWritebackSetting', 'transaction'],
  }, async (engine) => {
    const out = await engine.transaction(async tx => {
      const source = await tx.lockSourceShared(SRC);
      const missing = await tx.lockSourceShared('no-such-source');
      const setting = await tx.lockAgentWritebackSetting('writeback.enabled');
      return { source, missing, setting };
    });
    expect(out).toEqual({ source: undefined, missing: undefined, setting: undefined });
    return out;
  });

  parityTest('listOversizedStaleFacts lists the long facts that still need an embedding, in id order, of one source or all', {
    methods: ['listOversizedStaleFacts', 'insertFact', 'insertFacts', 'expireFact', 'putPage', 'softDeletePage'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await createSource(engine, backend, 'retired');
    const long = (tag: string) => `${tag} ${'x'.repeat(60)}`;
    await engine.putPage('notes/gone', note('Gone'));
    await remember(engine, [
      { fact: long('stale unembedded'), entity_slug: 'people/a' },
      { fact: 'short', entity_slug: 'people/a' },
      { fact: long('stale other model'), entity_slug: 'people/a', embedding: basisEmbedding(0), embedding_model: 'm2' },
      { fact: long('expired'), entity_slug: 'people/a' },
    ]);
    await fenced(engine, [{ fact: long('page deleted'), entity_slug: 'people/a', source_markdown_slug: 'notes/gone' }]);
    await remember(engine, [{ fact: long('in other source'), entity_slug: 'people/a' }], 'other');
    await remember(engine, [{ fact: long('in retired source'), entity_slug: 'people/a' }], 'retired');
    const expired = (await engine.listFactsByEntity(SRC, 'people/a', { limit: 100 } as never)).find(f => f.fact.startsWith('expired'))!;
    await engine.expireFact(expired.id);
    await engine.softDeletePage('notes/gone');
    await archiveSource(engine, backend, 'retired');
    const read = async (sourceId?: string, maxTokens = 40) =>
      (await engine.listOversizedStaleFacts({ ...(sourceId ? { sourceId } : {}), model: 'm1', dims: 1536, maxTokens }))
        .map(r => ({ fact: r.fact.split(' ').slice(0, 2).join(' '), source_id: r.source_id, slug: r.slug, id: typeof r.id }));
    const out = { scoped: await read(SRC), all: await read(), tight: await read(SRC, 200) };
    expect(out.scoped.map(r => r.fact)).toEqual(['stale unembedded', 'stale other']);
    expect(out.all.map(r => r.fact)).toEqual(['stale unembedded', 'stale other', 'in other']);
    expect(out.tight).toEqual([]);
    return out;
  });

  parityTest('listLivePersonTitles lists the live, non-retired person pages named, and readLiveFactEntityPage reads one live page under the privacy floor', {
    methods: ['listLivePersonTitles', 'readLiveFactEntityPage', 'putPage', 'softDeletePage'],
  }, async (engine) => {
    await engine.putPage('people/alice-example', note('Alice Example', {}, 'person'));
    await engine.putPage('people/bob-example', note('Bob Example', {}, 'person'));
    await engine.putPage('people/carol-example', note('Carol Example', { visibility: 'private' }, 'person'));
    await engine.putPage('companies/acme-example', note('Acme Example', {}, 'company'));
    await engine.softDeletePage('people/bob-example');
    const slugs = ['people/alice-example', 'people/bob-example', 'people/carol-example', 'companies/acme-example', 'people/missing'];
    const titles = await engine.listLivePersonTitles(SRC, slugs);
    const out = {
      titles: titles.sort((a, b) => a.slug.localeCompare(b.slug)),
      noSlugs: await engine.listLivePersonTitles(SRC, []),
      otherSource: await engine.listLivePersonTitles('other', slugs),
      pages: {} as Record<string, unknown>,
    };
    for (const slug of slugs) {
      out.pages[slug] = { open: await engine.readLiveFactEntityPage(SRC, slug), floor: await engine.readLiveFactEntityPage(SRC, slug, true) };
    }
    expect(out.titles.map(t => t.slug)).toEqual(['people/alice-example', 'people/carol-example']);
    expect(out.pages['people/bob-example']).toEqual({ open: null, floor: null });
    expect(out.pages['people/alice-example']).toEqual({ open: { slug: 'people/alice-example', type: 'person' }, floor: { slug: 'people/alice-example', type: 'person' } });
    expect((out.pages['people/carol-example'] as { floor: unknown }).floor).toBeNull();
    return out;
  });

  parityTest('listFactsToRetireFromPage lists the active facts a session or a page context produced, in id order', {
    methods: ['listFactsToRetireFromPage', 'insertFact', 'expireFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'by session', entity_slug: 'people/a', source_session: 'sess-1' },
      { fact: 'by exact context', entity_slug: 'people/a', context: 'notes/p' },
      { fact: 'by context pattern', entity_slug: 'people/a', context: 'notes/p#section' },
      { fact: 'unrelated', entity_slug: 'people/a', context: 'notes/q', source_session: 'sess-2' },
      { fact: 'already expired', entity_slug: 'people/a', source_session: 'sess-1' },
    ]);
    await remember(engine, [{ fact: 'in other source', entity_slug: 'people/a', source_session: 'sess-1' }], 'other');
    await engine.expireFact(ids.get('already expired')!);
    const name = namer(ids);
    const read = async (sourceId: string, session: string, slug: string, pattern: string) =>
      (await engine.listFactsToRetireFromPage(sourceId, session, slug, pattern)).map(r => ({ fact: name(r.id), entity: r.entity_slug, slug: r.source_markdown_slug, row_num: r.row_num }));
    const out = {
      all: await read(SRC, 'sess-1', 'notes/p', 'notes/p#%'),
      sessionOnly: await read(SRC, 'sess-1', 'none', 'none%'),
      none: await read(SRC, 'sess-9', 'none', 'none%'),
      otherSource: (await engine.listFactsToRetireFromPage('other', 'sess-1', 'none', 'none%')).length,
    };
    expect(out.all.map(r => r.fact)).toEqual(['by session', 'by exact context', 'by context pattern']);
    expect(out.sessionOnly.map(r => r.fact)).toEqual(['by session']);
    expect(out.none).toEqual([]);
    return out;
  });

  parityTest('listContestedProposalPairs lists the pending proposals naming a fact, both facts readable under the policy, in proposal order', {
    methods: ['listContestedProposalPairs', 'insertDecideProposal', 'insertFact', 'insertFacts', 'putPage', 'expireFact'],
  }, async (engine) => {
    await engine.putPage('notes/hidden', note('Hidden', { visibility: 'private' }));
    const plain = await remember(engine, [
      { fact: 'a world new', entity_slug: 'people/a', visibility: 'world' },
      { fact: 'b world old', entity_slug: 'people/a', visibility: 'world' },
      { fact: 'c private new', entity_slug: 'people/a', visibility: 'private' },
      { fact: 'd world old', entity_slug: 'people/a', visibility: 'world' },
      { fact: 'g gone new', entity_slug: 'people/a', visibility: 'world' },
      { fact: 'h world old', entity_slug: 'people/a', visibility: 'world' },
    ]);
    const hidden = await fenced(engine, [{ fact: 'e world new on a private page', entity_slug: 'people/a', source_markdown_slug: 'notes/hidden' }]);
    const ids = new Map([...plain, ...hidden, ...await remember(engine, [{ fact: 'f world old', entity_slug: 'people/a', visibility: 'world' }])]);
    await engine.expireFact(ids.get('g gone new')!);
    const pair = (i: number, n: string, o: string) => ({
      source_id: SRC, sweep_id: 'sweep-1', pair_index: i, new_fact_id: ids.get(n)!, old_fact_id: ids.get(o)!,
      direction: 'new_supersedes_old' as const, p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'model-a',
    });
    for (const [i, [n, o]] of ([['a world new', 'b world old'], ['c private new', 'd world old'], ['e world new on a private page', 'f world old'], ['g gone new', 'h world old']] as const).entries()) {
      expect(await engine.insertDecideProposal(pair(i, n, o))).not.toBeNull();
    }
    const name = namer(ids);
    const read = async (all: string[], policy: { remote: boolean; excludePrivate: boolean }) =>
      (await engine.listContestedProposalPairs(all.map(n => ids.get(n)!), policy))
        .map(r => ({ delivered: name(r.delivered), new: name(r.new_fact_id), old: name(r.old_fact_id) }));
    const everything = [...ids.keys()];
    const out = {
      local: await read(everything, { remote: false, excludePrivate: false }),
      remote: await read(everything, { remote: true, excludePrivate: false }),
      floor: await read(everything, { remote: false, excludePrivate: true }),
      byOld: await read(['b world old'], { remote: false, excludePrivate: false }),
      none: await read([], { remote: false, excludePrivate: false }),
    };
    expect(out.local.map(r => r.new)).toEqual(['a world new', 'a world new', 'c private new', 'c private new', 'e world new on a private page', 'e world new on a private page']);
    expect(out.remote.map(r => r.new)).not.toContain('c private new');
    expect(out.floor.map(r => r.new)).not.toContain('e world new on a private page');
    expect(out.byOld).toEqual([{ delivered: 'b world old', new: 'a world new', old: 'b world old' }]);
    expect(out.none).toEqual([]);
    return out;
  });

  parityTest('listFactProvenance reads the stored provenance of the named facts of one source', {
    methods: ['listFactProvenance', 'insertFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'from remember', entity_slug: 'people/a', source: 'mcp:remember' },
      { fact: 'from a cli', entity_slug: 'people/a', source: 'cli:capture' },
      { fact: 'from nowhere', entity_slug: 'people/a', source: 'hook:agent-session' },
    ]);
    const elsewhere = await remember(engine, [{ fact: 'in other source', entity_slug: 'people/a', source: 'mcp:remember' }], 'other');
    const name = namer(new Map([...ids, ...elsewhere]));
    const read = async (sourceId: string, wanted: number[]) =>
      (await engine.listFactProvenance(sourceId, wanted)).map(r => ({ fact: name(r.id), source: r.source })).sort((a, b) => a.fact.localeCompare(b.fact));
    const out = {
      two: await read(SRC, [ids.get('from remember')!, ids.get('from a cli')!, 999_999]),
      otherSource: await read(SRC, [elsewhere.get('in other source')!]),
      inOther: await read('other', [elsewhere.get('in other source')!]),
      none: await read(SRC, []),
    };
    expect(out.two).toEqual([{ fact: 'from a cli', source: 'cli:capture' }, { fact: 'from remember', source: 'mcp:remember' }]);
    expect(out.otherSource).toEqual([]);
    expect(out.inOther).toEqual([{ fact: 'in other source', source: 'mcp:remember' }]);
    return out;
  });

  parityTest('readFactsFtsIndexState reads the keyword index and swapFactsFtsIndex swaps the built one into place (ensureFactsFtsIndex)', {
    methods: ['readFactsFtsIndexState', 'swapFactsFtsIndex', 'transaction'],
  }, async (engine) => {
    const lang = getFtsLanguage();
    const other = lang === 'simple' ? 'english' : 'simple';
    const language = (s: { valid: boolean; def: string } | null) => (s ? `${s.valid ? 'valid' : 'invalid'}:${/to_tsvector\('(\w+)'/.exec(s.def)?.[1]}` : 'missing');
    const states = async () => ({
      live: language(await engine.readFactsFtsIndexState('idx_facts_fts')),
      next: language(await engine.readFactsFtsIndexState('idx_facts_fts_next')),
      old: language(await engine.readFactsFtsIndexState('idx_facts_fts_old')),
      none: language(await engine.readFactsFtsIndexState('idx_no_such_index')),
    });
    const before = await states();
    const steps: string[] = [];
    const swapped = await ensureFactsFtsIndex(engine, { lang: other, version: 237, onStep: async (s) => { steps.push(s); } });
    const afterSwap = await states();
    const again = await ensureFactsFtsIndex(engine, { lang: other, version: 237 });
    const restored = await ensureFactsFtsIndex(engine, { lang, version: 237 });
    const afterRestore = await states();
    const out = { before, swapped, steps, afterSwap, again, restored, afterRestore };
    expect(before.live).toBe(`valid:${lang}`);
    expect(afterSwap).toEqual({ live: `valid:${other}`, next: 'missing', old: 'missing', none: 'missing' });
    expect(afterRestore.live).toBe(`valid:${lang}`);
    expect([swapped, again, restored]).toEqual(['swapped', 'present', 'swapped']);
    return out;
  });

  /** One brain the recall-pool cases read: backed and unbacked entities, call-off cues, slot facts and embeddings. */
  async function seedPool(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await createSource(engine, backend, 'other');
    await engine.putPage('people/alice', note('Alice', {}, 'person'));
    await engine.putPage('notes/hidden', note('Hidden', { visibility: 'private' }));
    const mid = Float32Array.from({ length: 1536 }, (_, i) => (i === 0 ? 0.6 : i === 1 ? 0.8 : 0));
    const plain = await remember(engine, [
      { fact: 'alice likes tea', entity_slug: 'people/alice', visibility: 'world', embedding: basisEmbedding(0), embedding_model: 'm1' },
      { fact: 'alice dislikes coffee', entity_slug: 'people/alice', visibility: 'private', embedding: basisEmbedding(1), embedding_model: 'm1' },
      { fact: 'alice trip was called off', entity_slug: 'people/alice', visibility: 'world', embedding: mid, embedding_model: 'm1' },
      { fact: 'alice other model', entity_slug: 'people/alice', visibility: 'world', embedding: basisEmbedding(0), embedding_model: 'm2' },
      { fact: 'ghost said scratch that', entity_slug: 'people/ghost', visibility: 'world' },
      { fact: 'ghost party was cancelled', entity_slug: 'people/ghost', visibility: 'private' },
      { fact: 'alice earlier cancelled', entity_slug: 'people/alice', visibility: 'world' },
    ]);
    await engine.expireFact(plain.get('alice earlier cancelled')!);
    const other = await remember(engine, [{ fact: 'bob in other was retracted', entity_slug: 'people/bob', visibility: 'world', embedding: basisEmbedding(0), embedding_model: 'm1' }], 'other');
    const slots = await fenced(engine, [
      { fact: 'alice lived in Lisbon', entity_slug: 'people/alice', source: CONVERSATION, dimension: 'location', value: 'Lisbon', valid_from: at('2026-01-01T00:00:00Z'), source_markdown_slug: 'notes/open' },
      { fact: 'alice moved to Porto', entity_slug: 'people/alice', source: CONVERSATION, dimension: 'location', value: 'Porto', valid_from: at('2026-03-01T00:00:00Z'), source_markdown_slug: 'notes/open' },
      { fact: 'alice works at Acme', entity_slug: 'people/alice', source: CONVERSATION, dimension: 'employer', value: 'Acme', valid_from: at('2026-02-01T00:00:00Z'), source_markdown_slug: 'notes/open' },
      { fact: 'alice private slot', entity_slug: 'people/alice', source: CONVERSATION, dimension: 'location', value: 'Rome', visibility: 'private', valid_from: at('2026-04-01T00:00:00Z'), source_markdown_slug: 'notes/hidden' },
      { fact: 'alice not a conversation slot', entity_slug: 'people/alice', source: 'fence', dimension: 'location', value: 'Oslo', valid_from: at('2026-05-01T00:00:00Z'), source_markdown_slug: 'notes/open' },
    ]);
    const all = new Map([...plain, ...other, ...slots]);
    return { ids: all, name: namer(all) };
  }

  const view = (name: (id: number | string | bigint) => string) => (r: { id: number | string | bigint; fact: string; entity_slug: string | null; source_id: string; visibility?: string; valid_from: unknown; similarity?: number | null }) => ({
    fact: r.fact, name: name(r.id), entity: r.entity_slug, source: r.source_id, visibility: r.visibility ?? null, from: iso(r.valid_from),
    sim: r.similarity == null ? null : Math.round(Number(r.similarity) * 1e5) / 1e5,
  });

  parityTest('readFactsEmbeddingColumn and listNearestFacts rank the pool facts nearest a vector under the read policy, with or without the iterative scan', {
    methods: ['readFactsEmbeddingColumn', 'listNearestFacts', 'insertFact', 'putPage', 'expireFact'],
  }, async (engine, backend) => {
    const { name } = await seedPool(engine, backend);
    const column = (await engine.readFactsEmbeddingColumn())!;
    expect(column).not.toBeNull();
    expect(column.dims).toBe(1536);
    const vector = { literal: `[${Array.from(basisEmbedding(0)).join(',')}]`, type: (column.type === 'halfvec' ? 'halfvec' : 'vector') as 'halfvec' | 'vector', model: 'm1', dims: 1536 };
    const declared = column.dims > 0;
    const read = async (extra: Record<string, unknown> = {}) =>
      (await engine.listNearestFacts({ scope: scope(), vector, declared, limit: 10, ...extra } as never)).map(view(name));
    const out = {
      column,
      plain: await read(),
      limited: await read({ limit: 1 }),
      worldOnly: await read({ scope: scope({ worldOnly: true }) }),
      excludePrivate: await read({ scope: scope({ excludePrivate: true }) }),
      twoSources: await read({ scope: { sourceIds: [SRC, 'other'], worldOnly: false, excludePrivate: false } }),
      undeclared: await read({ declared: false }),
      narrowed: await read({ filters: { sessionId: 'nobody' } }),
      strict: await read({ hnswIterativeScan: 'strict_order' }),
      relaxed: await read({ hnswIterativeScan: 'relaxed_order' }),
      off: await read({ hnswIterativeScan: 'off' }),
    };
    expect(out.plain.map(r => r.fact)).toEqual(['alice likes tea', 'alice trip was called off', 'alice dislikes coffee']);
    expect(out.plain[0]!.sim).toBe(1);
    expect(out.limited.map(r => r.fact)).toEqual(['alice likes tea']);
    expect(out.twoSources.map(r => r.fact)).toContain('bob in other was retracted');
    expect(out.narrowed).toEqual([]);
    expect(out.strict).toEqual(out.plain);
    expect(out.off).toEqual(out.plain);
    return out;
  });

  parityTest('listSlotRows reads the active conversation slot rows of the named slots under the pool policy, oldest first', {
    methods: ['listSlotRows', 'insertFacts', 'insertFact', 'putPage'],
  }, async (engine, backend) => {
    const { name } = await seedPool(engine, backend);
    const slot = (entity_slug: string, dimension: string) => ({ source_id: SRC, entity_slug, dimension });
    const read = async (slots: Array<{ source_id: string; entity_slug: string; dimension: string }>, extra: Record<string, unknown> = {}) =>
      (await engine.listSlotRows(scope(extra), slots)).map(r => ({ ...view(name)(r), dimension: r.dimension, hashed: r.value_hash != null }));
    const out = {
      location: await read([slot('people/alice', 'location')]),
      both: await read([slot('people/alice', 'location'), slot('people/alice', 'employer')]),
      worldOnly: await read([slot('people/alice', 'location')], { worldOnly: true }),
      excludePrivate: await read([slot('people/alice', 'location')], { excludePrivate: true }),
      none: await read([]),
      otherEntity: await read([slot('people/nobody', 'location')]),
    };
    expect(out.location.map(r => r.fact)).toEqual(['alice lived in Lisbon', 'alice moved to Porto', 'alice private slot']);
    expect(out.both.map(r => r.fact)).toEqual(['alice lived in Lisbon', 'alice works at Acme', 'alice moved to Porto', 'alice private slot']);
    expect(out.worldOnly.map(r => r.fact)).not.toContain('alice private slot');
    expect(out.excludePrivate.map(r => r.fact)).not.toContain('alice private slot');
    expect(out.none).toEqual([]);
    return out;
  });

  parityTest('listPoolUnbackedKeys, listPoolEntityPairs and listCallOffCueFacts read the pool: entities without a live page, entities with a fact, and the facts that call one off', {
    methods: ['listPoolUnbackedKeys', 'listPoolEntityPairs', 'listCallOffCueFacts', 'insertFact', 'insertFacts', 'putPage', 'expireFact'],
  }, async (engine, backend) => {
    const { name } = await seedPool(engine, backend);
    const key = (sourceId: string, slug: string) => ({ source_id: sourceId, entity_slug: slug });
    const out = {
      unbacked: await engine.listPoolUnbackedKeys(scope(), ['people/alice', 'people/ghost', 'people/nobody'], 10),
      unbackedLimited: await engine.listPoolUnbackedKeys(scope(), ['people/alice', 'people/ghost'], 0),
      unbackedWorld: await engine.listPoolUnbackedKeys(scope({ worldOnly: true }), ['people/ghost'], 10),
      unbackedTwoSources: await engine.listPoolUnbackedKeys({ sourceIds: [SRC, 'other'], worldOnly: false, excludePrivate: false } as never, ['people/ghost', 'people/bob'], 10),
      pairs: await engine.listPoolEntityPairs(scope(), {}),
      pairsEntity: await engine.listPoolEntityPairs(scope(), { entities: [{ sourceId: SRC, slug: 'people/ghost' }] }),
      pairsGrep: await engine.listPoolEntityPairs(scope(), { grep: 'cancelled' }),
      pairsExpired: await engine.listPoolEntityPairs(scope({ worldOnly: true }), { includeExpired: true, grep: 'earlier' }),
      pairsTwoSources: await engine.listPoolEntityPairs({ sourceIds: [SRC, 'other'], worldOnly: false, excludePrivate: false } as never, {}),
      cues: (await engine.listCallOffCueFacts(scope(), [key(SRC, 'people/alice'), key(SRC, 'people/ghost')])).map(view(name)).sort((a, b) => a.fact.localeCompare(b.fact)),
      cuesWorld: (await engine.listCallOffCueFacts(scope({ worldOnly: true }), [key(SRC, 'people/alice'), key(SRC, 'people/ghost')])).map(view(name)).sort((a, b) => a.fact.localeCompare(b.fact)),
      cuesOneEntity: (await engine.listCallOffCueFacts(scope(), [key(SRC, 'people/ghost')])).map(view(name)).sort((a, b) => a.fact.localeCompare(b.fact)),
      cuesNone: await engine.listCallOffCueFacts(scope(), []),
    };
    expect(out.unbacked).toEqual([key(SRC, 'people/ghost')]);
    expect(out.unbackedLimited).toEqual([]);
    expect(out.unbackedWorld).toEqual([key(SRC, 'people/ghost')]);
    expect(out.pairs.map(p => p.entity_slug)).toEqual(['people/alice', 'people/ghost']);
    expect(out.pairsEntity).toEqual([key(SRC, 'people/ghost')]);
    expect(out.cues.map(r => r.fact)).toEqual(['alice trip was called off', 'ghost party was cancelled', 'ghost said scratch that']);
    expect(out.cuesWorld.map(r => r.fact)).not.toContain('ghost party was cancelled');
    return out;
  });

  parityTest('listFactRowsByIds reads whole fact rows of the named ids within the named sources', {
    methods: ['listFactRowsByIds', 'insertFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'first', entity_slug: 'people/a', visibility: 'world', valid_from: at('2026-01-01T00:00:00Z') },
      { fact: 'second', entity_slug: 'people/a', visibility: 'private', valid_from: at('2026-01-02T00:00:00Z') },
    ]);
    const elsewhere = await remember(engine, [{ fact: 'third', entity_slug: 'people/a', valid_from: at('2026-01-03T00:00:00Z') }], 'other');
    const name = namer(new Map([...ids, ...elsewhere]));
    const read = async (sources: string[], wanted: number[]) =>
      (await engine.listFactRowsByIds(sources, wanted)).map(r => ({
        fact: r.fact, name: name(r.id), source: r.source_id, entity: r.entity_slug, visibility: r.visibility, from: iso(r.valid_from), kind: r.kind,
        expired: r.expired_at != null,
      })).sort((a, b) => a.fact.localeCompare(b.fact));
    const every = [...ids.values(), ...elsewhere.values()];
    const out = {
      both: await read([SRC, 'other'], every),
      one: await read([SRC], every),
      someIds: await read([SRC, 'other'], [ids.get('second')!, 999_999]),
      noSources: await read([], every),
      noIds: await read([SRC], []),
    };
    expect(out.both.map(r => r.fact)).toEqual(['first', 'second', 'third']);
    expect(out.one.map(r => r.fact)).toEqual(['first', 'second']);
    expect(out.someIds.map(r => r.fact)).toEqual(['second']);
    expect(out.noSources).toEqual([]);
    expect(out.noIds).toEqual([]);
    return out;
  });
});
