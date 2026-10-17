/**
 * W3 invariance gate, assertion 4 (docs/architecture/historical-retrieval.md
 * section 7): each forced probe must make the gate fail on at least one seed.
 * Code mutants run through the retriever's test seam; index mutants rewrite
 * the history text index the way the broken maintenance or build would have
 * left it. (f) is caught by the oracle (assertion 3) and (k) by the
 * restriction cell (assertion 5): neither changes evidence under the
 * unrestricted later history, which is what assertions 1 and 2 compare.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { testBackends } from './helpers/test-backends.ts';
import { beliefEngineCase, type BeliefBrain } from './helpers/belief-ledger.ts';
import { __setHistoricalMutantForTests, type HistoricalMutant } from '../src/core/belief/historical-search.ts';
import { buildHistoryIndex } from '../src/core/belief/history-index.ts';
import { applyLaterHistory, callers, captureEvidence, evidenceBlocks, lifetimeOf, oracleRanking, quiescentInstant, retrieverRanking, simulatePreMigration,
  renderWorldPage, thinkPrompt, withWorld, type World } from './helpers/history-world.ts';

afterEach(() => __setHistoricalMutantForTests(null));

const SEEDS = [1, 2, 3];
const LIMIT = 10;
const errorOf = (e: unknown) => `error:${String((e as { code?: string }).code ?? (e as Error).message)}`;

/** Assertions 1 to 3 on one world; returns the labels of the assertions that failed instead of throwing. */
async function gateFailures(b: BeliefBrain, w: World, hooks: { prepare?: (b: BeliefBrain, w: World) => Promise<void>; between?: (b: BeliefBrain, w: World) => Promise<void> } = {}) {
  const failed = new Set<string>();
  await hooks.prepare?.(b, w);
  const capture = (c: ReturnType<typeof callers>[number], q: World['questions'][number]) => captureEvidence(b, c, q, w.T).catch(errorOf);
  const oracleAgrees = async (c: ReturnType<typeof callers>[number], text: string) =>
    JSON.stringify(await retrieverRanking(b, c, text, w.T, LIMIT).catch(errorOf)) === JSON.stringify(await oracleRanking(b, c, text, w.T, LIMIT));
  const before = new Map<string, string>();
  for (const c of callers(b)) for (const q of w.questions) {
    before.set(`${c.name}|${q.id}`, await capture(c, q));
    if (!await oracleAgrees(c, q.text)) failed.add('3');
  }
  await hooks.between?.(b, w);
  await applyLaterHistory(b, w);
  for (const c of callers(b)) for (const q of w.questions) {
    if (await capture(c, q) !== before.get(`${c.name}|${q.id}`)) failed.add('1');
    if (!await oracleAgrees(c, q.text)) failed.add('3');
    if (!q.removed) continue;
    const found = evidenceBlocks((await thinkPrompt(b, c, q.text, w.T).catch(() => ({ prompt: '' }))).prompt).includes(q.removed.phrase);
    const today = evidenceBlocks((await thinkPrompt(b, c, q.text)).prompt).includes(q.removed.phrase);
    if (!found || today) failed.add('2');
  }
  return failed;
}

/** True when the gate fails one of `expected` on at least one seed. */
async function caught(databaseUrl: string | undefined, expected: string[], hooks: Parameters<typeof gateFailures>[2] = {}, mutant: HistoricalMutant | null = null) {
  const seen: string[] = [];
  for (const seed of SEEDS) {
    let failed = new Set<string>();
    await withWorld(seed, databaseUrl, async (b, w) => {
      __setHistoricalMutantForTests(mutant);
      try { failed = await gateFailures(b, w, hooks); } finally { __setHistoricalMutantForTests(null); }
    });
    seen.push(`seed ${seed}: [${[...failed].sort().join(',')}]`);
    if (expected.some(a => failed.has(a))) return { caught: true, seen };
  }
  return { caught: false, seen };
}

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`W3 forced probes (${engineCase.name})`, () => {
    const codeMutants: Array<[string, HistoricalMutant, string[]]> = [
      ['(a) current text instead of the T body', 'current_text', ['1', '2']],
      ['(b) current candidates filtered by T', 'current_candidates', ['1', '2']],
      ['(c) current alias resolution', 'current_aliases', ['1']],
      ['(d) the backlink boost kept on', 'backlink_boost', ['1']],
      ['(e) the semantic cache read', 'semantic_cache', ['1']],
      ['(f) truncation before the exact check', 'truncate_before_exact', ['3']],
    ];
    for (const [name, mutant, expected] of codeMutants) {
      test(`${name} fails assertion ${expected.join(' or ')}`, async () => {
        expect(await caught(engineCase.databaseUrl, expected, {}, mutant)).toMatchObject({ caught: true });
      }, 1_800_000);
    }

    test('(g) index rows keyed by revision instead of by interval fail assertion 2 (the forget rewrote the body at the same revision before T)', async () => {
      const prepare = async (b: BeliefBrain) => {
        await b.engine.executeRaw(`DELETE FROM belief_text_revisions r USING belief_text_revisions e WHERE r.source_id = $1 AND e.source_id = r.source_id
          AND e.page_lifetime = r.page_lifetime AND e.revision = r.revision AND e.known_from < r.known_from`, [b.sourceId]);
      };
      expect(await caught(engineCase.databaseUrl, ['2'], { prepare })).toMatchObject({ caught: true });
    }, 1_800_000);

    test('(h) an index cut set before the build\'s first pass completes fails assertion 1 or 2', async () => {
      const prepare = async (b: BeliefBrain, w: World) => {
        await simulatePreMigration(b, [w.special.premigration]);
        await b.engine.executeRaw(`UPDATE belief_text_index_state SET index_cut = (SELECT min(recorded_at) FROM belief_events WHERE source_id = $1) WHERE source_id = $1`, [b.sourceId]);
      };
      const between = async (b: BeliefBrain) => { await buildHistoryIndex(b.engine, b.sourceId, { apply: true }); };
      expect(await caught(engineCase.databaseUrl, ['1', '2'], { prepare, between })).toMatchObject({ caught: true });
    }, 1_800_000);

    test('(i) no index row on restore fails assertion 2', async () => {
      const prepare = async (b: BeliefBrain, w: World) => {
        const lifetime = await lifetimeOf(b, w.special.restored);
        const [restore] = await b.engine.executeRaw<{ id: number; known_from: string }>(`SELECT r.id, r.known_from FROM belief_text_revisions r JOIN belief_events e ON e.id = r.opening_event
          WHERE r.page_lifetime = $1::uuid AND e.event_type = 'page.restored' ORDER BY r.id DESC LIMIT 1`, [lifetime]);
        await b.engine.executeRaw('DELETE FROM belief_text_revisions WHERE id = $1', [restore!.id]);
        await b.engine.executeRaw('UPDATE belief_text_revisions SET known_until = NULL, closing_event = NULL WHERE page_lifetime = $1::uuid AND known_until = $2::timestamptz',
          [lifetime, restore!.known_from]);
      };
      expect(await caught(engineCase.databaseUrl, ['2'], { prepare })).toMatchObject({ caught: true });
    }, 1_800_000);

    test('(j) take rows not indexed fail assertion 2 (a take-only phrase finds nothing)', async () => {
      const prepare = async (b: BeliefBrain) => {
        await b.engine.executeRaw(`DELETE FROM belief_text_revision_chunks WHERE kind = 'take' AND revision_row IN (SELECT id FROM belief_text_revisions WHERE source_id = $1)`, [b.sourceId]);
      };
      expect(await caught(engineCase.databaseUrl, ['2'], { prepare })).toMatchObject({ caught: true });
    }, 1_800_000);

    test('(k) a remote body without W4\'s later-private restriction fails assertion 5 (a fact made private after T)', () => withWorld(1, engineCase.databaseUrl, async (b, w) => {
      const remote = callers(b).find(c => c.name === 'remote')!;
      const q = w.questions.find(x => x.id === 'topic-0')!;
      const ranked = await oracleRanking(b, remote, q.text, w.T, LIMIT);
      const target = w.pages.find(p => ranked.pages.some(r => r[0] === p.slug) && p.facts.some(f => typeof f === 'string' && q.text.split(' ').some(t => f.includes(t))))!;
      expect(target).toBeDefined();
      const claim = target.facts.find(f => typeof f === 'string' && q.text.split(' ').some(t => f.includes(t))) as string;
      target.facts = target.facts.map(f => f === claim ? { claim, visibility: 'private' } : f);
      target.prose += ' Later.';
      await b.put(target.slug, renderWorldPage(target));
      await quiescentInstant(b);
      const restricted = async () => ({
        ranking: await retrieverRanking(b, remote, q.text, w.T, LIMIT),
        leaked: evidenceBlocks((await thinkPrompt(b, remote, q.text, w.T)).prompt).includes(claim),
      });
      const expected = { ranking: await oracleRanking(b, remote, q.text, w.T, LIMIT), leaked: false };
      expect(await restricted()).toEqual(expected);
      __setHistoricalMutantForTests('no_later_private_restriction');
      expect(await restricted()).not.toEqual(expected);
    }), 600_000);
  });
}
