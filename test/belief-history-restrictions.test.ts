/**
 * W3 invariance gate, assertions 5 and 6 (docs/architecture/historical-retrieval.md
 * section 7): restrictions made after T only remove evidence, and the exact
 * remaining evidence is the brute-force ranking at T without the restricted
 * items (the fixture has more eligible pages than the limit, so a lower page
 * moves in); coverage and refusal cells for think, `search {known_as_of}` and
 * `takes_list {known_as_of, page_slug}`.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operationsByName } from '../src/core/operations.ts';
import { runThink } from '../src/core/think/index.ts';
import { replayPurgesInRestore } from '../src/core/belief/purge-mirror.ts';
import { fillCommitMarks } from '../src/core/belief/coverage-report.ts';
import { buildHistoryIndex } from '../src/core/belief/history-index.ts';
import { addSource, removeSource } from '../src/core/sources-ops.ts';
import { withCoordinatedWrite, withTrustPromotion } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';
import { callers, evidenceBlocks, forgetFact, oracleRanking, quiescentInstant, renderWorldPage, retrieverRanking, revisionOf,
  simulatePreMigration, thinkPrompt, withWorld, type Caller, type World, type WorldPage } from './helpers/history-world.ts';

const LIMIT = 8;
const stub = { answer: 'x', citations: [], gaps: [] };
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; reason?: string; message: string; fix?: unknown }) => e);
const search = (ctx: Caller['ctx'], params: Record<string, unknown>) => operationsByName.search!.handler(ctx, params) as Promise<Record<string, any>>;
const firstWord = (p: WorldPage) => p.prose.split(' ')[0]!;
const words = (claim: string) => claim.split(' ').slice(0, 2);

/**
 * One restriction cell: the change runs after T; afterwards each caller's evidence at T is exactly the oracle's top K
 * under the restrictions bounded by now, holds only pages eligible at T before the change, and none of `gone`.
 */
async function cell(b: BeliefBrain, w: World, name: string, query: string, change: () => Promise<unknown>,
  opts: { gone?: string[]; goneSlugs?: string[]; callers?: Caller[]; after?: Caller[] } = {}) {
  const before = opts.callers ?? callers(b);
  const eligible = new Map<string, Set<string>>();
  for (const c of before) eligible.set(c.name, new Set((await oracleRanking(b, c, query, w.T, 1000)).pages.map(p => p[1])));
  await change();
  await quiescentInstant(b);
  for (const c of opts.after ?? before) {
    const after = await retrieverRanking(b, c, query, w.T, LIMIT);
    expect({ name, caller: c.name, after }).toEqual({ name, caller: c.name, after: await oracleRanking(b, c, query, w.T, LIMIT) });
    expect({ name, caller: c.name, outside: after.pages.filter(p => !eligible.get(c.name)!.has(p[1])) }).toEqual({ name, caller: c.name, outside: [] });
    const evidence = evidenceBlocks((await thinkPrompt(b, c, query, w.T)).prompt) + JSON.stringify(await search(c.ctx, { query, known_as_of: w.T, source_id: b.sourceId }));
    for (const g of opts.gone ?? []) expect({ name, caller: c.name, leaked: evidence.includes(g) ? g : null }).toEqual({ name, caller: c.name, leaked: null });
    for (const s of opts.goneSlugs ?? []) expect({ name, caller: c.name, slug: after.pages.some(p => p[0] === s) ? s : null }).toEqual({ name, caller: c.name, slug: null });
  }
}

/** The words some column of the history text index still carries. */
async function indexCarries(b: BeliefBrain, list: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const word of list) {
    const [hit] = await b.engine.executeRaw<{ n: number }>(`SELECT (SELECT count(*) FROM belief_text_chunks WHERE search_vector @@ plainto_tsquery('english', $1))
      + (SELECT count(*) FROM belief_text_revisions WHERE title ILIKE '%' || $1 || '%' OR array_to_string(aliases, ' ') ILIKE '%' || $1 || '%') AS n`, [word]);
    if (Number(hit!.n) > 0) out.push(word);
  }
  return out;
}

/** Ordinary world pages: not a removed-phrase page, private, deleted at T or a synthesis page. */
const pageOf = (w: World, pred: (p: WorldPage) => boolean) => {
  const removed = new Set(w.questions.filter(q => q.removed).map(q => q.removed!.slug));
  return w.pages.filter(p => !removed.has(p.slug) && !p.private && p.slug !== w.special.deletedAtT && p.slug !== w.special.alias
    && !w.special.synthesis.includes(p.slug)).filter(pred);
};

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`W3 restrictions and refusals (${engineCase.name})`, () => {
    test('restrictions for every caller: a later forget, purge_fact, page purge and version pruning each remove exactly their items; a later un-withdrawal adds nothing', () => withWorld(4, engineCase.databaseUrl, async (b, w) => {
      const [forgotten, purgedFact, purgedPage, pruned] = pageOf(w, p => typeof p.facts[0] === 'string');
      const topic = w.topics[0]!;
      const claim = (p: WorldPage) => p.facts[0] as string;
      await cell(b, w, 'later forget', `${firstWord(forgotten!)} ${words(claim(forgotten!))[1]} ${topic}`,
        () => forgetFact(b, forgotten!.slug, words(claim(forgotten!)).join(' ')), { gone: [claim(forgotten!)] });
      await cell(b, w, 'purge_fact', `${firstWord(purgedFact!)} ${words(claim(purgedFact!))[1]} ${topic}`, async () => {
        const [fact] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL ORDER BY id LIMIT 1', [b.sourceId, claim(purgedFact!)]);
        const dry = await operationsByName.purge_fact!.handler(b.ctx, { id: Number(fact!.id), dry_run: true }) as Record<string, any>;
        await operationsByName.purge_fact!.handler(b.ctx, { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
      }, { gone: [claim(purgedFact!)] });
      expect(await indexCarries(b, words(claim(purgedFact!)))).toEqual([]);
      await cell(b, w, 'page purge', `${firstWord(purgedPage!)} ${topic}`,
        async () => b.op('delete_page', { slug: purgedPage!.slug, purge: true, expected_revision: await revisionOf(b, purgedPage!.slug) }),
        { gone: [firstWord(purgedPage!)], goneSlugs: [purgedPage!.slug] });
      expect(await indexCarries(b, [firstWord(purgedPage!), purgedPage!.title])).toEqual([]);
      const [orphans] = await b.engine.executeRaw<{ n: number }>('SELECT count(*) AS n FROM belief_text_chunks c WHERE NOT EXISTS (SELECT 1 FROM belief_text_revision_chunks m WHERE m.text_hash = c.text_hash)');
      expect(Number(orphans!.n)).toBe(0);
      const prunedQuery = `${firstWord(pruned!)} ${topic}`;
      await cell(b, w, 'version pruning', prunedQuery, async () => {
        pruned!.prose += ' Edited after T.';
        await b.put(pruned!.slug, renderWorldPage(pruned!));
        await b.engine.executeRaw('DELETE FROM page_versions WHERE page_id = (SELECT id FROM pages WHERE source_id = $1 AND slug = $2)', [b.sourceId, pruned!.slug]);
      }, { goneSlugs: [pruned!.slug] });
      const disclosed = await search(b.ctx, { query: prunedQuery, known_as_of: w.T, source_id: b.sourceId });
      expect(Object.values(disclosed.known_as_of.bodies_unavailable as Record<string, number>).reduce((n, v) => n + v, 0)).toBeGreaterThanOrEqual(1);
      // Un-withdrawal: the fact forgotten before T is asserted again later; the evidence at T still lacks it.
      const fq = w.questions.find(q => q.id === 'forgotten')!;
      const beforeReassert = new Map<string, string>();
      for (const c of callers(b)) beforeReassert.set(c.name, (await thinkPrompt(b, c, fq.text, w.T)).prompt);
      const page = w.pages.find(p => p.slug === w.special.forget)!;
      page.facts = [...page.facts, `${w.forgotten[0]!.toUpperCase()}${w.forgotten.slice(1)} ${w.topics[1]}`];
      await b.put(page.slug, renderWorldPage(page));
      await quiescentInstant(b);
      for (const c of callers(b)) {
        const prompt = (await thinkPrompt(b, c, fq.text, w.T)).prompt;
        expect({ caller: c.name, same: prompt === beforeReassert.get(c.name), leaked: evidenceBlocks(prompt).toLowerCase().includes(w.forgotten) })
          .toEqual({ caller: c.name, same: true, leaked: false });
      }
    }), 900_000);

    test('restrictions bounded by now for a remote caller: page made private, fact made private, holder narrowed, trust demoted, source removed', () => withWorld(5, engineCase.databaseUrl, async (b, w) => {
      const [local, remote] = callers(b);
      const [madePrivate, factPrivate, demoted] = pageOf(w, p => typeof p.facts[0] === 'string');
      const topic = w.topics[1]!;
      const privQuery = `${firstWord(madePrivate!)} ${topic}`;
      const localBefore = (await thinkPrompt(b, local!, privQuery, w.T)).prompt;
      await cell(b, w, 'page made private', privQuery, async () => {
        madePrivate!.private = true;
        await b.put(madePrivate!.slug, renderWorldPage(madePrivate!));
      }, { callers: [remote!], goneSlugs: [madePrivate!.slug], gone: [firstWord(madePrivate!)] });
      expect((await thinkPrompt(b, local!, privQuery, w.T)).prompt).toBe(localBefore);
      const claim = factPrivate!.facts[0] as string;
      await cell(b, w, 'fact made private', `${firstWord(factPrivate!)} ${words(claim)[1]} ${topic}`, async () => {
        factPrivate!.facts = [{ claim, visibility: 'private' }, ...factPrivate!.facts.slice(1)];
        await b.put(factPrivate!.slug, renderWorldPage(factPrivate!));
      }, { callers: [remote!], gone: [claim] });
      const wide: Caller = { name: 'remote', ctx: { ...b.ctx, remote: true, transport: 'stdio', takesHoldersAllowList: ['world', 'garry'] } as Caller['ctx'],
        think: { remote: true, sourceId: b.sourceId, takesHoldersAllowList: ['world', 'garry'] } };
      const garryTake = w.pages.filter(p => !p.private && p.slug !== w.special.deletedAtT).flatMap(p => p.takes.filter(t => t.who === 'garry'))[0]!;
      await cell(b, w, 'holder narrowed', garryTake.claim, async () => {}, { callers: [wide], after: [remote!], gone: [garryTake.claim] });
      const trustQuery = `${firstWord(demoted!)} ${topic}`;
      await cell(b, w, 'trust demoted', trustQuery, () => b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () =>
        withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw(`UPDATE pages SET trust_tier = 'unknown' WHERE source_id = $1 AND slug = $2`, [b.sourceId, demoted!.slug])),
      TEST_WRITE_ATTRIBUTION)));
      for (const c of [local!, remote!]) {
        const tag = (await thinkPrompt(b, c, trustQuery, w.T)).prompt.match(new RegExp(`<page slug="${demoted!.slug}"[^>]*>`))?.[0] ?? '';
        expect({ caller: c.name, demoted: tag.includes('trust="unknown"') }).toEqual({ caller: c.name, demoted: true });
      }
      await removeSource(b.engine, { id: b.sourceId, confirmDestructive: true, yes: true } as never);
      for (const c of [local!, remote!]) {
        const out = await search(c.ctx, { query: topic, known_as_of: w.T, source_id: b.sourceId }).catch((e: { code?: string }) => ({ refused: e.code }));
        expect(JSON.stringify(out)).not.toContain(demoted!.slug);
      }
    }), 900_000);

    test('coverage refusals: before the watermark, before the index cut (then answered after the build), inside a restore gap, a bare date, an uncovered source in scope', () => beliefBrain(async b => {
      const slug = 'companies/acme-example';
      await b.put(slug, beliefPage({ prose: 'Zentrovar widgets.' }));
      const unrecorded = await quiescentInstant(b);
      await b.enable();
      await b.put(slug, beliefPage({ prose: 'Zentrovar gadgets.' }));
      const covered = await quiescentInstant(b);
      const q = { query: 'zentrovar', source_id: b.sourceId };
      const thinkAt = (knownAsOf: string) => runThink(b.engine, { question: 'zentrovar', knownAsOf, remote: false, sourceId: b.sourceId, stubResponse: stub });
      expect(await refusal(search(b.ctx, { ...q, known_as_of: unrecorded }))).toMatchObject({ code: 'coverage_from', reason: 'not_recorded' });
      expect(await refusal(thinkAt(unrecorded))).toMatchObject({ code: 'coverage_from', reason: 'not_recorded' });
      expect((await search(b.ctx, { ...q, known_as_of: covered })).results.map((r: any) => r.slug)).toEqual([slug]);
      await simulatePreMigration(b, [slug]);
      const incomplete = await refusal(search(b.ctx, { ...q, known_as_of: covered }));
      expect(incomplete).toMatchObject({ code: 'coverage_from', reason: 'history_index_incomplete' });
      expect(JSON.stringify(incomplete!.fix)).toContain('history-index');
      expect(await refusal(thinkAt(covered))).toMatchObject({ code: 'coverage_from', reason: 'history_index_incomplete' });
      expect(await buildHistoryIndex(b.engine, b.sourceId, {})).toMatchObject({ applied: false, intervals: 2 });
      expect(await refusal(search(b.ctx, { ...q, known_as_of: covered }))).toMatchObject({ reason: 'history_index_incomplete' });
      await buildHistoryIndex(b.engine, b.sourceId, { apply: true });
      expect((await search(b.ctx, { ...q, known_as_of: covered })).results.map((r: any) => r.slug)).toEqual([slug]);
      expect(await refusal(search(b.ctx, { ...q, known_as_of: covered.slice(0, 10) }))).toMatchObject({ code: 'clock_mismatch' });
      const archivedAt = await quiescentInstant(b);
      const inGap = await quiescentInstant(b);
      await b.engine.transaction(tx => replayPurgesInRestore(tx, { lines: [], archivedAt, restoreId: randomUUID() }));
      await fillCommitMarks(b.engine, b.sourceId);
      expect(await refusal(search(b.ctx, { ...q, known_as_of: inGap }))).toMatchObject({ code: 'coverage_gap', reason: 'restore' });
      expect(await refusal(thinkAt(inGap))).toMatchObject({ code: 'coverage_gap' });
      const other = `${b.sourceId}-uncovered`;
      await addSource(b.engine, { id: other, name: other } as never);
      const both = await refusal(runThink(b.engine, { question: 'zentrovar', knownAsOf: await quiescentInstant(b), remote: false, allowedSources: [b.sourceId, other], stubResponse: stub }));
      expect(both).toMatchObject({ code: 'coverage_from' });
      expect(both!.message).toContain(other);
    }, { managed: true, enable: false, databaseUrl: engineCase.databaseUrl }), 300_000);

    test('proof refusals and disclosures: a straddling anchor refuses, another straddling page is dropped and counted; an unmanaged source is disclosed uncertified', () => withWorld(6, engineCase.databaseUrl, async (b, w) => {
      const [anchor, other] = pageOf(w, () => true);
      for (const p of [anchor!, other!]) { p.prose += ` ${w.topics[2]} straddle.`; await b.put(p.slug, renderWorldPage(p)); }
      const unmark = async (slug: string) => {
        const [e] = await b.engine.executeRaw<{ publication_id: string; recorded_at: string }>(`SELECT publication_id::text AS publication_id, recorded_at FROM belief_events
          WHERE source_id = $1 AND slug = $2 AND subject_kind = 'page' ORDER BY id DESC LIMIT 1`, [b.sourceId, slug]);
        await b.engine.executeRaw('DELETE FROM belief_commit_marks WHERE publication_id = $1::uuid', [e!.publication_id]);
        return new Date(e!.recorded_at).getTime();
      };
      const t = new Date(Math.max(await unmark(anchor!.slug), await unmark(other!.slug)) + 1).toISOString();
      await new Promise(r => setTimeout(r, 20));
      const anchored = await refusal(runThink(b.engine, { question: w.topics[2]!, anchor: anchor!.slug, knownAsOf: t, remote: false, sourceId: b.sourceId, stubResponse: stub }));
      expect(anchored).toMatchObject({ code: 'known_as_of_unproven' });
      const out = await search(b.ctx, { query: w.topics[2]!, known_as_of: t, source_id: b.sourceId });
      expect(out.results.map((r: any) => r.slug)).not.toContain(anchor!.slug);
      expect(out.results.map((r: any) => r.slug)).not.toContain(other!.slug);
      expect(out.known_as_of).toMatchObject({ unproven_pages: 2, certified: false, uncertified_reason: 'unmanaged', retrieval: 'lexical' });
      const thought = await runThink(b.engine, { question: w.topics[2]!, knownAsOf: t, remote: false, sourceId: b.sourceId, stubResponse: stub }) as any;
      expect(thought.known_as_of).toMatchObject({ unproven_pages: 2, certified: false, retrieval: 'lexical' });
      expect(thought.known_as_of.disabled_branches).toEqual(expect.arrayContaining(['vector', 'reranker', 'boosts', 'graph', 'trajectory', 'semantic_cache', 'calibration']));
    }), 600_000);

    test('a managed source answers certified', () => beliefBrain(async b => {
      await b.put('companies/acme-example', beliefPage({ prose: 'Zentrovar widgets.' }));
      const t = await quiescentInstant(b);
      expect((await search(b.ctx, { query: 'zentrovar', known_as_of: t, source_id: b.sourceId })).known_as_of).toMatchObject({ certified: true, uncertified_reason: null });
    }, { managed: true, databaseUrl: engineCase.databaseUrl }), 300_000);

    test('surface: save, take and with_calibration refuse; takes_list needs page_slug and lists the takes of the body at T; every new parameter is full-surface only', () => withWorld(7, engineCase.databaseUrl, async (b, w) => {
      const think = operationsByName.think!;
      for (const extra of [{ save: true }, { take: true, anchor: w.special.take }, { with_calibration: true }]) {
        expect(await refusal(think.handler(b.ctx, { question: 'x', known_as_of: w.T, ...extra }))).toMatchObject({ code: 'invalid_params' });
      }
      expect(await refusal(runThink(b.engine, { question: 'x', knownAsOf: w.T, save: true, remote: false, stubResponse: stub }))).toMatchObject({ code: 'invalid_params' });
      const takes = operationsByName.takes_list!;
      expect(await refusal(takes.handler(b.ctx, { known_as_of: w.T }))).toMatchObject({ code: 'invalid_params' });
      const takePage = w.pages.find(p => p.slug === w.special.take)!;
      const atT = takePage.takes.map(t => t.claim);
      takePage.takes = [{ claim: `Later take ${w.word()}`, who: 'world' }, { claim: `Later garry take ${w.word()}`, who: 'garry' }];
      await b.put(takePage.slug, renderWorldPage(takePage));
      await quiescentInstant(b);
      const listed = await takes.handler(b.ctx, { page_slug: takePage.slug, known_as_of: w.T }) as Array<Record<string, any>>;
      expect(listed.map(r => r.claim)).toEqual(atT);
      const garryPage = w.pages.find(p => p.takes.some(t => t.who === 'garry') && !p.private && p.slug !== w.special.deletedAtT && p.slug !== takePage.slug)!;
      const [, remote] = callers(b);
      const remoteRows = await takes.handler(remote!.ctx, { page_slug: garryPage.slug, known_as_of: w.T }) as Array<Record<string, any>>;
      expect(remoteRows.every(r => r.holder === 'world')).toBe(true);
      const localRows = await takes.handler(b.ctx, { page_slug: garryPage.slug, known_as_of: w.T }) as Array<Record<string, any>>;
      expect(localRows.some(r => r.holder === 'garry')).toBe(true);
      for (const op of ['search', 'think', 'takes_list']) expect({ op, full: operationsByName[op]!.params.known_as_of?.fullSurfaceOnly }).toEqual({ op, full: true });
    }), 600_000);
  });
}

