/**
 * BrainEngine parity: the facts write-path and recall-pool statements that left `executeRaw` (engine-sql/facts-trust.ts and
 * engine-sql/facts-recall.ts, called from facts/*.ts, search/fact-relevance.ts and ops/facts.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readPendingWriteReceipt, lockSourceShared, lockAgentWritebackSetting, listOversizedStaleFacts, listLivePersonTitles,
 *    readLiveFactEntityPage, listFactsToRetireFromPage, listContestedProposalPairs, listFactProvenance, recordDerivationEdges,
 *    listDerivedRows, expireDerivedFacts, deactivateDerivedTakes, softDeleteDerivedPages, markNeedsRederive,
 *    readMemberPageWithdrawal, readClaimWithdrawal, readFactVisibility, readReplacementTarget, readPairFactRow, expireSupersededFact,
 *    restoreSupersededFact, readFactForForget, expireFactSuperseded, expireFactAtDate, readWithdrawalAnchor, readFactActivity,
 *    readReviewAcceptedMark, readFactsFtsIndexState, swapFactsFtsIndex, readFactsEmbeddingColumn, listNearestFacts,
 *    listSlotRows, listPoolUnbackedKeys, listCallOffCueFacts, listPoolEntityPairs and listFactRowsByIds return the same observable
 *    result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes which fact a write supersedes, replaces, forgets or
 *    refuses, which derived rows a purge hides, which proposals a recall flags as contested, which facts recall pools, ranks and
 *    calls off, and whether the keyword index swap leaves search an index. The Rust engine has no SQL, so each read and write
 *    has to exist as a typed member it can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call (D18), so
 *    no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: none for the facts, pages, takes, proposals and withdrawals, which are seeded through typed members. A write-gate
 *    receipt has no typed writer, so readPendingWriteReceipt is compared on a request with none (its text is pinned in
 *    test/facts-rest-sites-sql-pin.test.ts). Fact ids differ between arms: rows are named by fact text. Generated timestamps
 *    are compared by shape or by relation, never by value. The keyword index swap runs through ensureFactsFtsIndex and
 *    restores the language it started with.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { derivedRowsFrom, hideDerivedRows, recordDerivationInputs } from '../../src/core/facts/derivation-inputs.ts';
import { ensureFactsFtsIndex } from '../../src/core/facts/fts-index.ts';
import { getFtsLanguage } from '../../src/core/fts-language.ts';
import { basisEmbedding, createSource, archiveSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { factWithdrawnRefusal } from '../../src/core/facts/single-prepare.ts';
import { FACT_WITHDRAWN_MESSAGE } from '../../src/core/facts/withdrawal.ts';

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

/**
 * On the Rust arm, runs a case that must stop on its member's typed refusal and pins the refusal's exact words, so a
 * refusal of another input, or a member that starts serving the input, fails the case. Other arms run it as written.
 */
async function rustStopsWith<T>(backend: ParityBackend, stop: string, run: () => Promise<T>): Promise<T> {
  if (backend !== 'rust') return run();
  try {
    await run();
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toContain(`does not support ${stop} yet`);
    throw error;
  }
  throw new Error(`[rust] expected the typed refusal of ${stop}, but the case ran`);
}

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

  parityTest('readLiveFactEntityPage reads one live page, none for a deleted, missing or other-source page, and none under the floor for a private one', {
    methods: ['readLiveFactEntityPage', 'putPage', 'softDeletePage'],
  }, async (engine) => {
    await engine.putPage('people/dana-example', note('Dana Example', {}, 'person'));
    await engine.putPage('people/erin-example', note('Erin Example', {}, 'person'));
    await engine.putPage('people/fred-example', note('Fred Example', { visibility: 'private' }, 'person'));
    await engine.putPage('companies/globex-example', note('Globex Example', {}, 'company'));
    await engine.softDeletePage('people/erin-example');
    const out: Record<string, unknown> = {};
    for (const slug of ['people/dana-example', 'people/erin-example', 'people/fred-example', 'companies/globex-example', 'people/missing']) {
      out[slug] = { open: await engine.readLiveFactEntityPage(SRC, slug), floor: await engine.readLiveFactEntityPage(SRC, slug, true) };
    }
    out.otherSource = await engine.readLiveFactEntityPage('other', 'people/dana-example');
    expect(out['people/dana-example']).toEqual({ open: { slug: 'people/dana-example', type: 'person' }, floor: { slug: 'people/dana-example', type: 'person' } });
    expect(out['companies/globex-example']).toEqual({ open: { slug: 'companies/globex-example', type: 'company' }, floor: { slug: 'companies/globex-example', type: 'company' } });
    expect(out['people/erin-example']).toEqual({ open: null, floor: null });
    expect(out['people/missing']).toEqual({ open: null, floor: null });
    expect((out['people/fred-example'] as { floor: unknown }).floor).toBeNull();
    expect(out.otherSource).toBeNull();
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

  parityTest('lockAgentWritebackSetting takes its lock for any setting name and returns nothing', {
    methods: ['lockAgentWritebackSetting'],
  }, async (engine) => {
    const named = await engine.lockAgentWritebackSetting('writeback.enabled');
    const again = await engine.lockAgentWritebackSetting('writeback.enabled');
    const other = await engine.lockAgentWritebackSetting('a setting that was never set');
    expect([named, again, other]).toEqual([undefined, undefined, undefined]);
    return { named, again, other };
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

  parityTest('derivation edges record once, walk to every derived row, and hide each row by its table', {
    methods: ['recordDerivationEdges', 'listDerivedRows', 'expireDerivedFacts', 'deactivateDerivedTakes', 'softDeleteDerivedPages', 'markNeedsRederive',
      'transaction', 'insertFact', 'putPage', 'addTakesBatch', 'listTakes', 'getPage', 'listFactsByEntity'],
  }, async (engine) => {
    const page = await engine.putPage('notes/derived', note('Derived'));
    await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'derived take', kind: 'fact' as const, holder: 'self' }]);
    const take = (await engine.listTakes({ page_id: page.id }))[0]!;
    const facts = await remember(engine, [
      { fact: 'input', entity_slug: 'people/a' }, { fact: 'child', entity_slug: 'people/a' }, { fact: 'grandchild', entity_slug: 'people/a' },
    ]);
    const input = { table: 'facts', id: String(facts.get('input')!) };
    const child = { table: 'facts', id: String(facts.get('child')!) };
    await engine.transaction(async tx => {
      await recordDerivationInputs(tx, { ...child, sourceId: SRC }, [input]);
      await recordDerivationInputs(tx, { ...child, sourceId: SRC }, [input]);
      await recordDerivationInputs(tx, { table: 'takes', id: take.id, sourceId: SRC }, [input]);
      await recordDerivationInputs(tx, { table: 'pages', id: page.id, sourceId: SRC }, [input]);
      await recordDerivationInputs(tx, { table: 'facts', id: facts.get('grandchild')!, sourceId: SRC }, [child]);
    });
    const label = new Map<string, string>([
      [`facts:${facts.get('input')}`, 'input'], [`facts:${facts.get('child')}`, 'child'], [`facts:${facts.get('grandchild')}`, 'grandchild'],
      [`takes:${take.id}`, 'take'], [`pages:${page.id}`, 'page'],
    ]);
    const nameOf = (r: { table: string; id: string }) => label.get(`${r.table}:${r.id}`) ?? `unknown:${r.table}:${r.id}`;
    const walk = await derivedRowsFrom(engine, [input]);
    const walked = walk.rows.map(r => ({ row: nameOf(r), depth: r.depth }));
    const limited = await derivedRowsFrom(engine, [input], { limit: 2 });
    const shallow = await derivedRowsFrom(engine, [input], { maxDepth: 1 });
    const none = await derivedRowsFrom(engine, [{ table: 'facts', id: '999999' }]);
    const hide = await engine.transaction(tx => hideDerivedRows(tx, walk.rows, { sourceId: SRC, requestId: '00000000-0000-4000-8000-000000000001', reason: 'purged' }));
    const again = await engine.transaction(tx => hideDerivedRows(tx, walk.rows, { sourceId: SRC, requestId: null, reason: 'purged again' }));
    const elsewhere = await engine.transaction(tx => hideDerivedRows(tx, walk.rows, { sourceId: 'other', requestId: null, reason: 'wrong source' }));
    const out = {
      walked, truncated: walk.truncated,
      limited: { rows: limited.rows.map(r => nameOf(r)), truncated: limited.truncated },
      shallow: { rows: shallow.rows.map(r => nameOf(r)), truncated: shallow.truncated },
      none, hide, again, elsewhere,
      facts: await factState(engine, 'people/a', namer(facts)),
      page: (await engine.getPage('notes/derived')) === null,
      take: (await engine.listTakes({ page_id: page.id, active: true } as never)).length,
    };
    expect(walked.map(r => r.row).sort()).toEqual(['child', 'grandchild', 'page', 'take']);
    expect(limited.truncated).toBe(true);
    expect(none.rows).toEqual([]);
    return out;
  });

  parityTest('readFactVisibility, readWithdrawalAnchor and readFactActivity read one fact of the source, or null', {
    methods: ['readFactVisibility', 'readWithdrawalAnchor', 'readFactActivity', 'insertFact', 'insertFactWithdrawal', 'expireFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'a world fact', entity_slug: 'people/a', visibility: 'world' },
      { fact: 'a private fact', entity_slug: 'people/a', visibility: 'private' },
      { fact: 'a withdrawn fact', entity_slug: 'people/a', visibility: 'world' },
      { fact: 'a lapsed fact', entity_slug: 'people/a', visibility: 'world', valid_until: at('2020-01-01T00:00:00Z') },
      { fact: 'an expired fact', entity_slug: 'people/a', visibility: 'world' },
    ]);
    await engine.expireFact(ids.get('an expired fact')!);
    expect(await engine.insertFactWithdrawal(SRC, 'world', 'a withdrawn fact', '*', '2026-06-01T00:00:00Z')).toBe(true);
    const id = (n: string) => ids.get(n)!;
    const out = {
      visibility: {
        world: await engine.readFactVisibility(id('a world fact'), SRC),
        private: await engine.readFactVisibility(id('a private fact'), SRC),
        wrongSource: await engine.readFactVisibility(id('a world fact'), 'other'),
        missing: await engine.readFactVisibility(999_999, SRC),
      },
      anchor: {
        plain: await engine.readWithdrawalAnchor(id('a world fact'), SRC),
        withdrawn: await engine.readWithdrawalAnchor(id('a withdrawn fact'), SRC),
        wrongSource: await engine.readWithdrawalAnchor(id('a withdrawn fact'), 'other'),
        missing: await engine.readWithdrawalAnchor(999_999, SRC),
      },
      activity: {
        active: await engine.readFactActivity(id('a world fact'), SRC),
        lapsed: await engine.readFactActivity(id('a lapsed fact'), SRC),
        expired: await engine.readFactActivity(id('an expired fact'), SRC),
        wrongSource: await engine.readFactActivity(id('a world fact'), 'other'),
        missing: await engine.readFactActivity(999_999, SRC),
      },
    };
    expect(out.anchor.withdrawn).toEqual({ withdrawn: true });
    expect(out.anchor.plain).toEqual({ withdrawn: false });
    expect(out.activity.active!.active).toBe(true);
    expect(out.activity.lapsed!.active).toBe(false);
    expect(out.activity.expired!.active).toBe(false);
    expect(out.visibility.private).toEqual({ visibility: 'private' });
    return out;
  });

  parityTest('readReplacementTarget reads the fact a replace names, with the withdrawal ledger and the remote floor applied', {
    methods: ['readReplacementTarget', 'transaction', 'insertFacts', 'putPage', 'insertFactWithdrawal'],
  }, async (engine) => {
    await engine.putPage('memory/members/alice-example', note('Alice', { readable_by: ['alice-example'] }));
    await engine.putPage('notes/hidden', note('Hidden', { visibility: 'private' }));
    // A page derived from a page that names readers (which also sets the store's restriction flag): the full form's
    // origin walk hides it; the short form of a brain with no member-access restrictions does not.
    await engine.putPage('notes/readers', note('Readers', { readable_by: ['alice-example'] }));
    await engine.putPage('notes/lineage', note('Lineage', { derived_from: ['notes/readers'] }));
    const ids = await fenced(engine, [
      { fact: 'open row', entity_slug: 'people/a', source_markdown_slug: 'notes/open' },
      { fact: 'lineage row', entity_slug: 'people/a', source_markdown_slug: 'notes/lineage' },
      { fact: 'hidden row', entity_slug: 'people/a', source_markdown_slug: 'notes/hidden', visibility: 'private' },
      { fact: 'own page row', entity_slug: 'people/a', source_markdown_slug: 'memory/members/alice-example', visibility: 'private' },
      { fact: 'withdrawn row', entity_slug: 'people/a', source_markdown_slug: 'notes/open' },
    ]);
    expect(await engine.insertFactWithdrawal(SRC, 'world', 'withdrawn row', '*', '2026-06-01T00:00:00Z')).toBe(true);
    const view = (row: Awaited<ReturnType<BrainEngine['readReplacementTarget']>>) =>
      row === null ? null : { fact: row.fact, visibility: row.visibility, expired: row.expired_at != null, withdrawn: row.withdrawn, page: row.source_markdown_slug };
    const out: Record<string, unknown> = {};
    for (const name of ['open row', 'hidden row', 'own page row', 'withdrawn row']) {
      const targetId = ids.get(name)!;
      out[name] = {
        local: view(await engine.readReplacementTarget({ targetId, sourceId: SRC, ownPage: null })),
        // A local read has no floor, so the own page it names changes nothing.
        localOwn: view(await engine.readReplacementTarget({ targetId, sourceId: SRC, ownPage: 'memory/members/alice-example' })),
        remote: view(await engine.readReplacementTarget({ targetId, sourceId: SRC, excludePrivate: true, ownPage: null })),
        remoteOwn: view(await engine.readReplacementTarget({ targetId, sourceId: SRC, excludePrivate: true, ownPage: 'memory/members/alice-example' })),
        locked: await engine.transaction(async tx => view(await tx.readReplacementTarget({ targetId, sourceId: SRC, ownPage: null, lock: true }))),
        otherSource: view(await engine.readReplacementTarget({ targetId, sourceId: 'other', ownPage: null })),
      };
    }
    expect(out['withdrawn row']).toMatchObject({ local: { withdrawn: true } });
    expect(out['open row']).toMatchObject({ local: { withdrawn: false }, remote: { fact: 'open row' }, otherSource: null });
    expect((out['hidden row'] as { remote: unknown }).remote).toBeNull();
    expect((out['own page row'] as { remoteOwn: unknown }).remoteOwn).not.toBeNull();
    for (const name of Object.keys(out)) {
      const row = out[name] as { local: unknown; localOwn: unknown };
      expect(row.localOwn).toEqual(row.local);
    }
    expect(await engine.readReplacementTarget({ targetId: 999_999, sourceId: SRC, ownPage: null })).toBeNull();
    return out;
  });

  // A remote caller reads inside a caller record: the floor then has no live pending-coverage test, an owner read drops
  // the owner-only test and `restricted: false` renders the short member-access form. The store models each of these, so
  // the Rust members answer them; PGLite and Postgres read through the same floor text.
  parityTest('readReplacementTarget and readClaimWithdrawal answer the remote floor inside a caller record: a member, the owner and a brain with no member-access restrictions', {
    methods: ['readReplacementTarget', 'readClaimWithdrawal', 'insertFacts', 'putPage', 'insertFactWithdrawal', 'expireFactsByWithdrawal'],
  }, async (engine) => {
    await engine.putPage('notes/hidden', note('Hidden', { visibility: 'private' }));
    // A page derived from a page that names readers (which also sets the store's restriction flag): the full form's
    // origin walk hides it; the short form of a brain with no member-access restrictions does not.
    await engine.putPage('notes/readers', note('Readers', { readable_by: ['alice-example'] }));
    await engine.putPage('notes/lineage', note('Lineage', { derived_from: ['notes/readers'] }));
    const ids = await fenced(engine, [
      { fact: 'open row', entity_slug: 'people/a', source_markdown_slug: 'notes/open' },
      { fact: 'lineage row', entity_slug: 'people/a', source_markdown_slug: 'notes/lineage' },
      { fact: 'hidden row', entity_slug: 'people/a', source_markdown_slug: 'notes/hidden', visibility: 'private' },
      { fact: 'open claim', entity_slug: 'people/a', source_markdown_slug: 'notes/open' },
      { fact: 'hidden claim', entity_slug: 'people/a', source_markdown_slug: 'notes/hidden', visibility: 'private' },
    ]);
    for (const [visibility, fact] of [['world', 'open claim'], ['private', 'hidden claim']] as const) {
      expect(await engine.insertFactWithdrawal(SRC, visibility, fact, '*', '2026-06-01T00:00:00Z')).toBe(true);
      await engine.expireFactsByWithdrawal(SRC, visibility, fact, '*');
    }
    const read = async () => {
      const target = async (name: string) => {
        const row = await engine.readReplacementTarget({ targetId: ids.get(name)!, sourceId: SRC, excludePrivate: true, ownPage: null });
        return row === null ? null : { fact: row.fact, visibility: row.visibility };
      };
      const claim = async (visibility: string, fact: string) => {
        const got = await engine.readClaimWithdrawal({ sourceId: SRC, visibility, fact, entitySlug: 'people/a', ownPage: null, excludePrivate: true });
        return { hidden: got.hidden, subject: got.row?.subject ?? null };
      };
      return { openRow: await target('open row'), lineageRow: await target('lineage row'), hiddenRow: await target('hidden row'), openClaim: await claim('world', 'open claim'), hiddenClaim: await claim('private', 'hidden claim') };
    };
    const records = {
      member: { identity: ['member:alice-example'] },
      owner: { owner: true, identity: ['member:alice-example'] },
      open: { restricted: false, identity: ['member:alice-example'] },
      ownerOpen: { owner: true, restricted: false, identity: ['member:alice-example'] },
    } as const;
    const out: Record<string, unknown> = { none: await read() };
    for (const [name, record] of Object.entries(records)) out[name] = await withCallerAccess({ ...record, identity: [...record.identity] }, read);
    const floor = { openRow: { fact: 'open row', visibility: 'world' }, lineageRow: null, hiddenRow: null, openClaim: { hidden: false, subject: '*' }, hiddenClaim: { hidden: true, subject: null } };
    const short = { ...floor, lineageRow: { fact: 'lineage row', visibility: 'world' } };
    expect(out).toEqual({ none: floor, member: floor, owner: floor, open: short, ownerOpen: short });
    return out;
  });

  // The refusal a save of a forgotten claim meets: the most specific subject, then the newest withdrawal, among the
  // withdrawals whose withdrawn rows the caller sees (or that no row backs); under the remote floor, `hidden` when every
  // withdrawn row of the claim is one the caller cannot see. Each withdrawal has its own time, so no order ties.
  parityTest('readClaimWithdrawal names the withdrawal a save of a forgotten claim meets, under the remote floor and the own page', {
    methods: ['readClaimWithdrawal', 'insertFacts', 'putPage', 'insertFactWithdrawal', 'expireFactsByWithdrawal'],
  }, async (engine) => {
    const own = 'memory/members/alice-example';
    await engine.putPage(own, note('Alice', { readable_by: ['alice-example'] }));
    await engine.putPage('notes/hidden', note('Hidden', { visibility: 'private' }));
    await fenced(engine, [
      { fact: 'open claim', entity_slug: 'people/a', source_markdown_slug: 'notes/open' },
      { fact: 'hidden claim', entity_slug: 'people/a', source_markdown_slug: 'notes/hidden', visibility: 'private' },
      { fact: 'own claim', source_markdown_slug: own, visibility: 'private' },
      { fact: 'mixed claim', entity_slug: 'people/m', source_markdown_slug: 'notes/open' },
      { fact: 'mixed claim', entity_slug: 'people/n', source_markdown_slug: 'notes/hidden' },
    ]);
    const withdrawals: Array<[string, string, string, string]> = [
      ['world', 'open claim', '*', '2026-06-01T00:00:00Z'],
      ['world', 'open claim', 'people/a', '2026-06-02T00:00:00Z'],
      ['private', 'hidden claim', '*', '2026-06-03T00:00:00Z'],
      ['private', 'own claim', own, '2026-06-04T00:00:00Z'],
      ['private', 'own claim', '*', '2026-06-05T00:00:00Z'],
      ['world', 'unbacked claim', 'people/z', '2026-06-06T00:00:00Z'],
      ['world', 'mixed claim', 'people/n', '2026-06-07T00:00:00Z'],
      ['world', 'mixed claim', '*', '2026-06-08T00:00:00Z'],
    ];
    for (const [visibility, fact, subject, when] of withdrawals) {
      expect(await engine.insertFactWithdrawal(SRC, visibility, fact, subject, when)).toBe(true);
      await engine.expireFactsByWithdrawal(SRC, visibility, fact, subject);
    }
    const read = async (visibility: string, fact: string, entitySlug: string | null, ownPage: string | null, excludePrivate?: boolean) => {
      const got = await engine.readClaimWithdrawal({ sourceId: SRC, visibility, fact, entitySlug, ownPage, excludePrivate });
      if (got.row) expect(got.row.withdrawn_at).toMatch(PG_TEXT);
      return { hidden: got.hidden, row: got.row && { subject: got.row.subject, visibility: got.row.visibility, at: iso(got.row.withdrawn_at) } };
    };
    const claims: Array<[string, string, string | null]> = [
      ['world', 'open claim', 'people/a'], ['private', 'hidden claim', 'people/a'], ['private', 'own claim', null],
      ['world', 'unbacked claim', 'people/z'], ['world', 'unbacked claim', null], ['world', 'mixed claim', 'people/n'],
      ['world', 'never forgotten', 'people/a'],
    ];
    const out: Record<string, unknown> = {};
    for (const [visibility, fact, entity] of claims) {
      out[`${fact} / ${entity ?? 'no entity'}`] = {
        local: await read(visibility, fact, entity, null),
        localOwn: await read(visibility, fact, entity, own),
        remote: await read(visibility, fact, entity, null, true),
        remoteOwn: await read(visibility, fact, entity, own, true),
        otherSource: await engine.readClaimWithdrawal({ sourceId: 'other', visibility, fact, entitySlug: entity, ownPage: null }),
      };
    }
    const row = (subject: string, visibility: string, day: string) => ({ hidden: false, row: { subject, visibility, at: `2026-06-${day}T00:00:00.000Z` } });
    expect(out['open claim / people/a']).toMatchObject({ local: row('people/a', 'world', '02'), remote: row('people/a', 'world', '02') });
    expect(out['hidden claim / people/a']).toMatchObject({ local: row('*', 'private', '03'), remote: { hidden: true, row: null } });
    expect(out['own claim / no entity']).toMatchObject({
      local: row('*', 'private', '05'), localOwn: row(own, 'private', '04'), remote: { hidden: true, row: null }, remoteOwn: row(own, 'private', '04'),
    });
    expect(out['unbacked claim / people/z']).toMatchObject({ local: row('people/z', 'world', '06'), remote: row('people/z', 'world', '06') });
    expect(out['unbacked claim / no entity']).toMatchObject({ local: { hidden: false, row: null }, remote: { hidden: false, row: null } });
    expect(out['mixed claim / people/n']).toMatchObject({ local: row('people/n', 'world', '07'), remote: row('*', 'world', '08') });
    expect(out['never forgotten / people/a']).toMatchObject({ local: { hidden: false, row: null }, remote: { hidden: false, row: null } });
    for (const name of Object.keys(out)) expect((out[name] as { otherSource: unknown }).otherSource).toEqual({ hidden: false, row: null });
    return out;
  });

  // A remote save of a forgotten claim meets one plain fact_withdrawn refusal, byte-identical whether the withdrawn rows
  // sit on a page the caller sees, on a page it may not see, or on no page at all; a local caller keeps the detail
  // (factWithdrawnRefusal, facts/single-prepare.ts).
  parityTest('a remote refusal of a forgotten claim is identical whether its withdrawn rows are visible, hidden or absent', {
    methods: ['readClaimWithdrawal', 'insertFacts', 'putPage', 'insertFactWithdrawal', 'expireFactsByWithdrawal'],
  }, async (engine) => {
    await engine.putPage('notes/hidden', note('Hidden', { visibility: 'private' }));
    await fenced(engine, [
      { fact: 'open claim', entity_slug: 'people/a', source_markdown_slug: 'notes/open' },
      { fact: 'hidden claim', entity_slug: 'people/a', source_markdown_slug: 'notes/hidden' },
    ]);
    const days: Record<string, string> = { 'open claim': '01', 'hidden claim': '02', 'unbacked claim': '03' };
    for (const [fact, day] of Object.entries(days)) {
      expect(await engine.insertFactWithdrawal(SRC, 'world', fact, '*', `2026-06-${day}T00:00:00Z`)).toBe(true);
      await engine.expireFactsByWithdrawal(SRC, 'world', fact, '*');
    }
    const refusal = async (fact: string, excludePrivate: boolean) => {
      const err = await factWithdrawnRefusal(engine, SRC, { fact, kind: 'fact', visibility: 'world', entity_slug: 'people/a' }, { excludePrivate });
      return JSON.stringify({ ...err, message: err.message, name: err.name });
    };
    const remote = Object.fromEntries(await Promise.all(Object.keys(days).map(async f => [f, await refusal(f, true)] as const)));
    const local = Object.fromEntries(await Promise.all(Object.keys(days).map(async f => [f, JSON.parse(await refusal(f, false)).withdrawn ?? null] as const)));
    const plain = JSON.parse(remote['open claim']!);
    expect({ code: plain.code, message: plain.message, withdrawn: plain.withdrawn ?? null }).toEqual({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE, withdrawn: null });
    expect(new Set(Object.values(remote)).size).toBe(1);
    expect(local).toEqual(Object.fromEntries(Object.entries(days).map(([f, day]) => [f, { at: `2026-06-${day}T00:00:00.000Z`, subject: 'all_entities', visibility: 'world' }])));
    return { remote: plain, local };
  });

  // An id binds as bigint: PGLite refuses a fraction with the cast error; the Rust member refuses it before the store with
  // its typed refusal. Any other error fails the case.
  parityTest('readReplacementTarget fails an id that is not a whole number with the bigint cast error on every engine', {
    methods: ['readReplacementTarget'],
  }, async (engine) => {
    try {
      await engine.readReplacementTarget({ targetId: 1.5, sourceId: SRC, ownPage: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/invalid input syntax for type bigint: "1\.5"/.test(message)) return 'invalid input syntax for type bigint: "1.5"';
      throw error;
    }
    throw new Error('readReplacementTarget read a fractional id');
  });

  parityTest('readMemberPageWithdrawal finds the withdrawal a save onto a member page meets: its own subject first, another subject only for a row the member reads', {
    methods: ['readMemberPageWithdrawal', 'insertFacts', 'expireFact', 'insertFactWithdrawal', 'putPage'],
  }, async (engine) => {
    const PAGE = 'memory/members/alice-example';
    await engine.putPage(PAGE, note('Alice', { readable_by: ['alice-example'] }));
    await engine.putPage('notes/bob-only', note('Bob only', { readable_by: ['bob-example'] }));
    const ids = await fenced(engine, [
      { fact: 'own subject claim', entity_slug: 'people/a', source_markdown_slug: PAGE, visibility: 'private' },
      { fact: 'wildcard claim', entity_slug: 'people/a', source_markdown_slug: PAGE },
      { fact: 'entity claim on bob page', entity_slug: 'people/a', source_markdown_slug: 'notes/bob-only' },
      { fact: 'entity claim on open page', entity_slug: 'people/a', source_markdown_slug: 'notes/open' },
    ]);
    for (const id of ids.values()) await engine.expireFact(id);
    const T = '2026-06-01T00:00:00Z';
    await engine.insertFactWithdrawal(SRC, 'private', 'own subject claim', PAGE, T);
    await engine.insertFactWithdrawal(SRC, 'world', 'wildcard claim', '*', T);
    await engine.insertFactWithdrawal(SRC, 'world', 'entity claim on bob page', 'people/a', T);
    await engine.insertFactWithdrawal(SRC, 'world', 'entity claim on open page', 'people/a', T);
    const view = (row: Awaited<ReturnType<BrainEngine['readMemberPageWithdrawal']>>) => {
      if (row === null) return null;
      expect(row.withdrawn_at).toMatch(PG_TEXT);
      return { subject: row.subject, visibility: row.visibility };
    };
    const ask = async (fact: string, visibility: string, extra: Record<string, unknown> = {}) => view(await engine.readMemberPageWithdrawal({
      sourceId: SRC, visibility, fact, entitySlug: 'people/a', page: PAGE, owner: false, identity: ['member:alice-example'], satisfied: [], ...extra,
    }));
    const out = {
      ownSubject: await ask('own subject claim', 'private'),
      wildcard: await ask('wildcard claim', 'world'),
      bobPage: await ask('entity claim on bob page', 'world'),
      bobPageAsOwner: await ask('entity claim on bob page', 'world', { owner: true }),
      openPage: await ask('entity claim on open page', 'world'),
      noEntity: await ask('entity claim on open page', 'world', { entitySlug: null }),
      wrongVisibility: await ask('wildcard claim', 'private'),
      unknown: await ask('never withdrawn', 'world'),
      otherSource: await ask('wildcard claim', 'world', { sourceId: 'other' }),
    };
    expect(out.ownSubject).toEqual({ subject: PAGE, visibility: 'private' });
    expect(out.wildcard).toEqual({ subject: '*', visibility: 'world' });
    expect(out.unknown).toBeNull();
    return out;
  });

  parityTest('readMemberPageWithdrawal for the brain owner counts a row of any visibility and judges a derived page by whether its origins name the owner', {
    methods: ['readMemberPageWithdrawal', 'insertFacts', 'expireFact', 'insertFactWithdrawal', 'putPage'],
  }, async (engine) => {
    const PAGE = 'memory/members/alice-example';
    await engine.putPage(PAGE, note('Alice', { readable_by: ['alice-example'] }));
    await engine.putPage('notes/origin-alice', note('Origin for Alice', { readable_by: ['alice-example'] }));
    await engine.putPage('notes/origin-bob', note('Origin for Bob', { readable_by: ['bob-example'] }));
    await engine.putPage('atoms/from-alice', note('From Alice', { source_slug: 'notes/origin-alice', visibility: 'world' }, 'atom'));
    await engine.putPage('atoms/from-bob', note('From Bob', { source_slug: 'notes/origin-bob', visibility: 'world' }, 'atom'));
    await engine.putPage('notes/derived-alice', note('Derived from Alice', { derived_from: ['notes/origin-alice.md'] }));
    const ids = await fenced(engine, [
      { fact: 'claim on alice atom', entity_slug: 'people/a', source_markdown_slug: 'atoms/from-alice' },
      { fact: 'claim on bob atom', entity_slug: 'people/a', source_markdown_slug: 'atoms/from-bob' },
      { fact: 'claim on alice lineage', entity_slug: 'people/a', source_markdown_slug: 'notes/derived-alice' },
      { fact: 'private claim on open page', entity_slug: 'people/a', source_markdown_slug: 'notes/open', visibility: 'private' },
    ]);
    for (const id of ids.values()) await engine.expireFact(id);
    const T = '2026-06-01T00:00:00Z';
    await engine.insertFactWithdrawal(SRC, 'world', 'claim on alice atom', 'people/a', T);
    await engine.insertFactWithdrawal(SRC, 'world', 'claim on bob atom', 'people/a', T);
    await engine.insertFactWithdrawal(SRC, 'world', 'claim on alice lineage', '*', T);
    await engine.insertFactWithdrawal(SRC, 'private', 'private claim on open page', 'people/a', T);
    const ask = async (fact: string, visibility: string, owner: boolean) => {
      const row = await engine.readMemberPageWithdrawal({
        sourceId: SRC, visibility, fact, entitySlug: 'people/a', page: PAGE, owner, identity: ['member:alice-example'], satisfied: [],
      });
      if (row === null) return null;
      expect(row.withdrawn_at).toMatch(PG_TEXT);
      return { subject: row.subject, visibility: row.visibility };
    };
    const out: Record<string, unknown> = {};
    for (const owner of [false, true]) {
      const who = owner ? 'owner' : 'member';
      out[`${who}AliceAtom`] = await ask('claim on alice atom', 'world', owner);
      out[`${who}BobAtom`] = await ask('claim on bob atom', 'world', owner);
      out[`${who}AliceLineage`] = await ask('claim on alice lineage', 'world', owner);
      out[`${who}PrivateOpen`] = await ask('private claim on open page', 'private', owner);
    }
    expect(out).toEqual({
      memberAliceAtom: null, memberBobAtom: null, memberAliceLineage: null, memberPrivateOpen: null,
      ownerAliceAtom: { subject: 'people/a', visibility: 'world' }, ownerBobAtom: null,
      ownerAliceLineage: { subject: '*', visibility: 'world' }, ownerPrivateOpen: { subject: 'people/a', visibility: 'private' },
    });
    return out;
  });

  parityTest('expireSupersededFact and restoreSupersededFact move the old fact of a pair and back, once; readPairFactRow reads it', {
    methods: ['readPairFactRow', 'expireSupersededFact', 'restoreSupersededFact', 'insertFact', 'transaction'],
  }, async (engine) => {
    const ids = await remember(engine, [
      { fact: 'old claim', entity_slug: 'people/a', valid_from: at('2026-01-01T00:00:00Z') },
      { fact: 'new claim', entity_slug: 'people/a', valid_from: at('2026-02-01T00:00:00Z') },
    ]);
    const name = namer(ids);
    const oldId = ids.get('old claim')!, newId = ids.get('new claim')!;
    const row = async (id: number, lock = false) => {
      const r = await engine.readPairFactRow(id, lock);
      return r === null ? null : {
        fact: r.fact, source_id: r.source_id, entity: r.entity_slug, visibility: r.visibility, expired: r.expired_at != null,
        valid_from: iso(r.valid_from), valid_until: iso(r.valid_until), superseded_by: r.superseded_by == null ? null : name(r.superseded_by as number),
        row_num: r.row_num, page: r.source_markdown_slug,
      };
    };
    const before = await row(oldId);
    const locked = await engine.transaction(async tx => {
      const r = await tx.readPairFactRow(oldId, true);
      return r === null ? null : r.fact;
    });
    const wrongSource = await engine.expireSupersededFact({ oldId, sourceId: 'other', newId, until: null });
    const expiredAt = await engine.expireSupersededFact({ oldId, sourceId: SRC, newId, until: '2026-03-01T00:00:00Z' });
    const afterExpire = await row(oldId);
    const secondExpire = await engine.expireSupersededFact({ oldId, sourceId: SRC, newId, until: null });
    const wrongPointer = await engine.restoreSupersededFact({ oldId, sourceId: SRC, expiredAt: null, validUntil: null, supersededBy: null, expectedSupersededBy: 999_999 });
    const restored = await engine.restoreSupersededFact({ oldId, sourceId: SRC, expiredAt: null, validUntil: null, supersededBy: null, expectedSupersededBy: newId });
    const afterRestore = await row(oldId);
    const secondRestore = await engine.restoreSupersededFact({ oldId, sourceId: SRC, expiredAt: null, validUntil: null, supersededBy: null, expectedSupersededBy: newId });
    const nowExpire = await engine.expireSupersededFact({ oldId, sourceId: SRC, newId, until: null });
    const nowIso = iso(new Date());
    const afterNow = await row(oldId);
    const out = {
      before, locked, wrongSource, expiredAt, afterExpire, secondExpire, wrongPointer, restored, afterRestore, secondRestore, nowExpire,
      afterNow: { ...afterNow!, valid_until: afterNow!.valid_until! >= afterNow!.valid_from! && afterNow!.valid_until! <= nowIso! },
      missing: await row(999_999),
    };
    expect(out).toMatchObject({ wrongSource: 0, expiredAt: 1, secondExpire: 0, wrongPointer: 0, restored: 1, secondRestore: 0, nowExpire: 1, missing: null });
    expect(out.afterExpire).toMatchObject({ expired: true, valid_until: '2026-03-01T00:00:00.000Z', superseded_by: 'new claim' });
    expect(out.afterRestore).toMatchObject({ expired: false, valid_until: null, superseded_by: null });
    return out;
  });

  // Postgres reads many timestamptz texts; the store reads only an ISO instant (`YYYY-MM-DDTHH:MM:SS[.ffffff]Z`). For a
  // text that Postgres reads and the store does not, PGLite writes the row and the Rust member stops on its typed refusal.
  const supersedePair = async (engine: BrainEngine) => {
    const ids = await remember(engine, [
      { fact: 'old claim', entity_slug: 'people/a', valid_from: at('2026-01-01T00:00:00Z') },
      { fact: 'new claim', entity_slug: 'people/a', valid_from: at('2026-02-01T00:00:00Z') },
    ]);
    return { oldId: ids.get('old claim')!, newId: ids.get('new claim')! };
  };

  parityTest('expireSupersededFact reads an until in Postgres timestamp text on every engine', {
    methods: ['expireSupersededFact', 'readPairFactRow', 'insertFact'],
  }, async (engine) => {
    const { oldId, newId } = await supersedePair(engine);
    const expired = await engine.expireSupersededFact({ oldId, sourceId: SRC, newId, until: '2026-03-01 00:00:00+00' });
    const row = await engine.readPairFactRow(oldId);
    const out = { expired, valid_until: iso(row!.valid_until) };
    expect(out).toEqual({ expired: 1, valid_until: '2026-03-01T00:00:00.000Z' });
    return out;
  });

  parityTest('restoreSupersededFact reads an expiredAt in Postgres timestamp text on every engine', {
    methods: ['expireSupersededFact', 'restoreSupersededFact', 'readPairFactRow', 'insertFact'],
  }, async (engine) => {
    const { oldId, newId } = await supersedePair(engine);
    expect(await engine.expireSupersededFact({ oldId, sourceId: SRC, newId, until: null })).toBe(1);
    const restored = await engine.restoreSupersededFact({
      oldId, sourceId: SRC, expiredAt: '2026-04-01 00:00:00+00', validUntil: null, supersededBy: null, expectedSupersededBy: newId,
    });
    const row = await engine.readPairFactRow(oldId);
    const out = { restored, expired_at: iso(row!.expired_at), superseded_by: row!.superseded_by };
    expect(out).toEqual({ restored: 1, expired_at: '2026-04-01T00:00:00.000Z', superseded_by: null });
    return out;
  });

  parityTest('readFactForForget, expireFactSuperseded and expireFactAtDate read and end an active fact for a forget, and only an active one', {
    methods: ['readFactForForget', 'expireFactSuperseded', 'expireFactAtDate', 'insertFact', 'insertFacts', 'listFactsByEntity'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'ends explicitly', entity_slug: 'people/a', valid_from: at('2026-01-01T00:00:00Z') },
      { fact: 'ends now', entity_slug: 'people/a', valid_from: at('2026-01-02T00:00:00Z') },
      { fact: 'ends on a date', entity_slug: 'people/a', valid_from: at('2026-01-03T00:00:00Z') },
      { fact: 'already ended', entity_slug: 'people/a', valid_from: at('2026-01-04T00:00:00Z') },
    ]);
    const fenceIds = await fenced(engine, [{ fact: 'on a page', entity_slug: 'people/a', source_markdown_slug: 'notes/open', visibility: 'world' }]);
    const elsewhere = await remember(engine, [{ fact: 'in other source', entity_slug: 'people/z' }], 'other');
    const name = namer(new Map([...ids, ...fenceIds, ...elsewhere]));
    const read = async (id: number) => {
      const r = await engine.readFactForForget(id);
      return r === null ? null : { source_id: r.source_id, entity: r.entity_slug, row_num: r.row_num, page: r.source_markdown_slug, expired: r.expired_at != null, visibility: r.visibility };
    };
    const before = { plain: await read(ids.get('ends now')!), fenced: await read(fenceIds.get('on a page')!), other: await read(elsewhere.get('in other source')!), missing: await read(999_999) };
    await engine.expireFactSuperseded(ids.get('ends explicitly')!, '2026-02-01T00:00:00Z');
    await engine.expireFactSuperseded(ids.get('ends now')!, null);
    await engine.expireFactAtDate(ids.get('ends on a date')!, '2026-03-01');
    await engine.expireFactAtDate(ids.get('already ended')!, '2026-03-01');
    await engine.expireFactAtDate(ids.get('already ended')!, '2026-09-09');
    await engine.expireFactSuperseded(ids.get('ends on a date')!, '2026-09-09');
    const state = (await factState(engine, 'people/a', name)).filter(r => r.fact !== 'on a page');
    const nowIso = iso(new Date())!;
    const out = {
      before,
      state: state.map(r => (r.fact === 'ends now' ? { ...r, valid_until: r.valid_until! >= '2026-01-02T00:00:00.000Z' && r.valid_until! <= nowIso } : r)),
      afterRead: await read(ids.get('ends now')!),
    };
    expect(out.state).toEqual([
      { fact: 'already ended', expired: true, valid_until: '2026-03-01T00:00:00.000Z', superseded_by: null },
      { fact: 'ends explicitly', expired: true, valid_until: '2026-02-01T00:00:00.000Z', superseded_by: null },
      { fact: 'ends now', expired: true, valid_until: true, superseded_by: null },
      { fact: 'ends on a date', expired: true, valid_until: '2026-03-01T00:00:00.000Z', superseded_by: null },
    ]);
    expect(out.afterRead!.expired).toBe(true);
    return out;
  });

  parityTest('readReviewAcceptedMark finds an expired fact whose context carries the mark', {
    methods: ['readReviewAcceptedMark', 'insertFact', 'expireFact'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const ids = await remember(engine, [
      { fact: 'marked and expired', entity_slug: 'people/a', context: 'forgotten: review:7' },
      { fact: 'marked and active', entity_slug: 'people/a', context: 'forgotten: review:7' },
      { fact: 'unmarked and expired', entity_slug: 'people/a', context: 'something else' },
      { fact: 'no context and expired', entity_slug: 'people/a' },
    ]);
    for (const n of ['marked and expired', 'unmarked and expired', 'no context and expired']) await engine.expireFact(ids.get(n)!);
    const name = namer(ids);
    const ask = async (n: string, mark: string, sourceId = SRC) => {
      const r = await engine.readReviewAcceptedMark(ids.get(n)!, sourceId, mark);
      return r === null ? null : name(r.id);
    };
    const out = {
      found: await ask('marked and expired', 'review:7'),
      activeFact: await ask('marked and active', 'review:7'),
      otherMark: await ask('marked and expired', 'review:8'),
      unmarked: await ask('unmarked and expired', 'review:7'),
      noContext: await ask('no context and expired', 'review:7'),
      wrongSource: await ask('marked and expired', 'review:7', 'other'),
    };
    expect(out).toEqual({ found: 'marked and expired', activeFact: null, otherMark: null, unmarked: null, noContext: null, wrongSource: null });
    return out;
  });

  // Named Rust design stop, no divergence row: readFactsFtsIndexState and swapFactsFtsIndex read and rename a Postgres
  // catalog index (pg_index), and the Rust store keeps one keyword index under one STORE_LANGUAGE, so the swap to another
  // language refuses. No production Rust caller exists: only ensureFactsFtsIndex calls the pair, from the PGLite and
  // Postgres ensureFactsKeywordIndex and migration v237; on Rust, reindex-search-vector takes ensureFactsKeywordIndex
  // (link-temporal.ts), and initSchema runs no migrations.
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

  parityTest('listSlotRows keeps the whole pool scope: source scope, visibility, trust floor, flagged rows, quarantine and private pages', {
    methods: ['listSlotRows', 'insertFacts', 'expireFact', 'putPage', 'transaction', 'applyTransactionSettings', 'upsertWriteGateReceipt'],
  }, async (engine, backend) => {
    // GST-3170: slot ends (search/slot-ends.ts) and the slot history read these rows to end a value, so a row the scope
    // hides must never come back here, or it ends (or shows) a value the caller cannot read.
    await createSource(engine, backend, 'other');
    await engine.putPage('people/carol', note('Carol', {}, 'person'));
    await engine.putPage('notes/open', note('Open'));
    await engine.putPage('notes/hidden', note('Hidden', { visibility: 'private' }));
    await engine.putPage('notes/held', note('Held', { quarantine: { reason: 'junk_pattern', detail: 'test', assessed_at: '2026-01-01T00:00:00Z' } }));
    const row = (fact: string, value: string, day: number, extra: Record<string, unknown> = {}) => ({
      fact, entity_slug: 'people/carol', source: CONVERSATION, dimension: 'location', value, source_markdown_slug: 'notes/open', row_num: day,
      valid_from: at(`2026-01-${String(day).padStart(2, '0')}T00:00:00Z`), ...extra });
    // One write per trust tier, so each row's tier comes from its own transaction. The lower tiers write other entities,
    // so this case reads the scope, not the rules between tiers of one slot. Each row has its own row_num: a second
    // write with a row_num already in use inserts nothing.
    const tiered = async (tier: string, rows: Array<Record<string, unknown> & { fact: string }>, sourceId = SRC) => engine.transaction(async tx => {
      await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'], [tier, tier, JSON.stringify({ channel: tier })]);
      return fenced(tx, rows, sourceId);
    });
    const curated = await tiered('operator_curated', [
      row('carol in Lisbon', 'Lisbon', 1),
      row('carol in Paris until last year', 'Paris', 2, { valid_until: at('2025-01-01T00:00:00Z') }),
      row('carol in Rome, forgotten', 'Rome', 3),
      row('carol private fact in Madrid', 'Madrid', 4, { visibility: 'private' }),
      row('carol in Oslo on a private page', 'Oslo', 5, { source_markdown_slug: 'notes/hidden' }),
      row('carol in Bern on a quarantined page', 'Bern', 6, { source_markdown_slug: 'notes/held' }),
      row('carol in Vienna, not a conversation row', 'Vienna', 7, { source: 'fence' }),
      { ...row('carol employer Acme', 'Acme', 8), dimension: 'employer' },
    ]);
    await engine.expireFact(curated.get('carol in Rome, forgotten')!);
    const agent = await tiered('agent_written', [row('dave in Prague, agent written', 'Prague', 9, { entity_slug: 'people/dave' }), row('dave in Riga, flagged', 'Riga', 10, { entity_slug: 'people/dave' })]);
    await engine.upsertWriteGateReceipt({ target_table: 'facts', target_id: String(agent.get('dave in Riga, flagged')), source_id: SRC,
      content_hash: 'h1', tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: ['standing_instruction'],
      reasons: ['standing_instruction found'], detector_error: false, request_id: null } as never);
    const untrusted = await tiered('external_untrusted', [row('erin in Kyiv, untrusted', 'Kyiv', 11, { entity_slug: 'people/erin' })]);
    const other = await tiered('operator_curated', [row('carol in Lima, other source', 'Lima', 12)], 'other');
    const name = namer(new Map([...curated, ...agent, ...untrusted, ...other]));
    const slot = (sourceId: string, dimension = 'location', entity = 'people/carol') => ({ source_id: sourceId, entity_slug: entity, dimension });
    const local = [slot(SRC), slot(SRC, 'location', 'people/dave'), slot(SRC, 'location', 'people/erin')];
    const read = async (scopeArg: unknown, slots = local) =>
      (await engine.listSlotRows(scopeArg as never, slots)).map(r => ({ name: name(r.id), source: r.source_id, dimension: r.dimension, from: iso(r.valid_from) }));
    const out = {
      plain: await read(scope()),
      worldOnly: await read(scope({ worldOnly: true })),
      excludePrivate: await read(scope({ excludePrivate: true })),
      floorAgent: await read(scope({ minTrust: 'agent_written' })),
      floorCurated: await read(scope({ minTrust: 'operator_curated' })),
      suppressFlagged: await read(scope({ suppressFlagged: true })),
      everything: await read(scope({ worldOnly: true, excludePrivate: true, minTrust: 'agent_written', suppressFlagged: true }), [...local, slot(SRC, 'employer')]),
      otherSlotOutOfScope: await read(scope(), [slot('other')]),
      twoSources: await read({ sourceIds: [SRC, 'other'], worldOnly: false, excludePrivate: false }, [...local, slot('other')]),
      twoSourcesOneSlot: await read({ sourceIds: [SRC, 'other'], worldOnly: false, excludePrivate: false }, [slot('other')]),
    };
    const names = (rows: Array<{ name: string }>) => rows.map(r => r.name);
    // Each knob takes out its own row and nothing else, so no read here passes vacuously.
    const base = ['carol in Lisbon', 'carol in Paris until last year', 'carol private fact in Madrid', 'carol in Oslo on a private page',
      'dave in Prague, agent written', 'dave in Riga, flagged', 'erin in Kyiv, untrusted'];
    expect(names(out.plain)).toEqual(base);
    expect(names(out.worldOnly)).toEqual(base.filter(n => n !== 'carol private fact in Madrid'));
    expect(names(out.excludePrivate)).toEqual(base.filter(n => n !== 'carol in Oslo on a private page'));
    expect(names(out.floorAgent)).toEqual(base.filter(n => n !== 'erin in Kyiv, untrusted'));
    expect(names(out.floorCurated)).toEqual(base.filter(n => !/Prague|Riga|Kyiv/.test(n)));
    expect(names(out.suppressFlagged)).toEqual(base.filter(n => n !== 'dave in Riga, flagged'));
    expect(names(out.everything)).toEqual(['carol in Lisbon', 'carol in Paris until last year', 'carol employer Acme', 'dave in Prague, agent written']);
    expect(out.otherSlotOutOfScope).toEqual([]);
    expect(names(out.twoSources)).toEqual([...base, 'carol in Lima, other source']);
    expect(names(out.twoSourcesOneSlot)).toEqual(['carol in Lima, other source']);
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
