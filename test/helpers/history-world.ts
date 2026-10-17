/**
 * The W3 invariance gate's synthetic world (docs/architecture/historical-retrieval.md
 * section 7): a seeded brain with the ledger on before its first write, a fixed
 * history up to a quiescent instant T, and a seeded later history that edits,
 * renames, deletes, re-aliases, re-links and re-caches everything after T.
 * Placeholder names only. Captures run through think (the user message a stub
 * client receives, so no model runs), `search {known_as_of}` and the
 * brute-force oracle, for a local caller and a remote caller scoped to world
 * holders.
 */
import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { runThink, type ThinkLLMClient } from '../../src/core/think/index.ts';
import { fillCommitMarks } from '../../src/core/belief/coverage-report.ts';
import { readPageAtTime, remoteMayRead } from '../../src/core/belief/page-at-time.ts';
import { renamePageOntoSlug } from '../../src/commands/sync/rename-collision.ts';
import { buildHistoryIndex } from '../../src/core/belief/history-index.ts';
import { historicalBody, historicalScore, historyBodyChunks, historyTakeRows, readHistoricalCandidates } from '../../src/core/belief/historical-search.ts';
import { cacheRowId } from '../../src/core/search/query-cache.ts';
import { waitForValue } from './wait-for.ts';
import { withCoordinatedWrite, withTrustPromotion } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './write-attribution.ts';
import { beliefBrain, beliefPage, type BeliefBrain } from './belief-ledger.ts';

export function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ['kal', 'vor', 'ben', 'tri', 'mox', 'zun', 'pel', 'dra', 'qui', 'lor', 'fen', 'lat', 'rog', 'wim', 'yul', 'nep', 'hax', 'cor', 'tib', 'gel'];

export interface WorldPage {
  slug: string; title: string; type: string; prose: string; facts: Array<string | { claim: string; visibility?: string }>;
  takes: Array<{ claim: string; who?: string; weight?: string }>; links: string[]; aliases: string[]; private?: boolean;
}
export interface Question { id: string; text: string; removed?: { phrase: string; slug: string; take?: boolean } }
export interface WorldPlan {
  seed: number; pages: WorldPage[]; questions: Question[]; topics: string[]; removed: string[]; forgotten: string; alias: string;
  special: { baseline: string; forget: string; restored: string; take: string; premigration: string; deletedAtT: string; private: string; alias: string; synthesis: string[] };
  word(): string; pick<T>(xs: readonly T[]): T; chance(p: number): boolean;
}
export interface World extends WorldPlan { T: string; lifetimes: Map<string, string> }

export function planWorld(seed: number): WorldPlan {
  const r = rng(seed);
  const used = new Set<string>();
  const word = () => {
    for (;;) {
      const w = Array.from({ length: 3 }, () => SYLLABLES[Math.floor(r() * SYLLABLES.length)]).join('');
      if (!used.has(w)) { used.add(w); return w; }
    }
  };
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const chance = (p: number) => r() < p;
  const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);
  const topics = Array.from({ length: 4 }, word);
  const removed = Array.from({ length: 5 }, word);
  const forgotten = word() + ' ' + word();
  const alias = cap(word()) + ' ' + cap(word());
  const pages: WorldPage[] = [];
  const page = (prefix: string, type: string, extra: Partial<WorldPage> = {}): WorldPage => {
    const name = word();
    const p: WorldPage = { slug: prefix + '/' + name + '-example', title: cap(name) + ' Example', type,
      prose: [cap(word()), pick(topics), word(), chance(0.6) ? pick(topics) : word(), word()].join(' ') + '.',
      facts: [cap(word()) + ' ' + word() + ' ' + pick(topics)], takes: chance(0.5) ? [{ claim: cap(word()) + ' ' + pick(topics) + ' ' + word(), who: chance(0.5) ? 'world' : 'garry' }] : [],
      links: [], aliases: [], ...extra };
    pages.push(p);
    return p;
  };
  const baseline = page('companies', 'company');
  baseline.prose += ' ' + cap(removed[0]!) + ' ' + topics[0] + '.';
  const forget = page('companies', 'company', { facts: [cap(word()) + ' ' + word() + ' ' + topics[1], cap(forgotten) + ' ' + topics[1]] });
  forget.prose += ' ' + cap(removed[1]!) + ' ' + topics[1] + '.';
  const restored = page('people', 'person');
  restored.prose += ' ' + cap(removed[2]!) + ' ' + topics[2] + '.';
  const take = page('people', 'person', { takes: [{ claim: cap(removed[3]!) + ' ' + topics[3] + ' ' + word(), who: 'world', weight: '0.7' }] });
  const premigration = page('companies', 'company');
  premigration.prose += ' ' + cap(removed[4]!) + ' ' + topics[0] + '.';
  const deletedAtT = page('notes', 'note');
  deletedAtT.prose += ' ' + topics.join(' ') + ' ' + topics.join(' ') + '.';
  const priv = page('notes', 'note', { private: true });
  const aliasPage = page('companies', 'company', { aliases: [alias] });
  const synthesis = [page('synthesis', 'synthesis'), page('synthesis', 'synthesis')];
  for (let i = 0; i < 15; i++) page('companies', 'company');
  for (let i = 0; i < 15; i++) page('people', 'person');
  for (const p of pages) p.links = Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(pages).slug).filter(s => s !== p.slug);
  for (const s of synthesis) s.prose += ' ' + topics.join(' ') + '.';
  const questions: Question[] = [
    ...removed.map((phrase, i) => ({ id: 'removed-' + i, text: 'What was noted about ' + cap(phrase) + ' and ' + topics[[0, 1, 2, 3, 0][i]!] + '?',
      removed: { phrase: cap(phrase), slug: [baseline, forget, restored, take, premigration][i]!.slug, take: i === 3 } })),
    { id: 'alias', text: alias },
    { id: 'forgotten', text: 'What about ' + forgotten + '?' },
    ...Array.from({ length: 5 }, (_, i) => ({ id: 'topic-' + i, text: topics[i % 4] + ' ' + topics[(i + 1) % 4] + ' ' + pick(pages).prose.split(' ')[2] })),
  ];
  return { seed, pages, questions, topics, removed, forgotten, alias, word, pick, chance,
    special: { baseline: baseline.slug, forget: forget.slug, restored: restored.slug, take: take.slug, premigration: premigration.slug,
      deletedAtT: deletedAtT.slug, private: priv.slug, alias: aliasPage.slug, synthesis: synthesis.map(s => s.slug) } };
}

export function renderWorldPage(p: WorldPage): string {
  const frontmatter: Record<string, string> = {};
  if (p.aliases.length) frontmatter.aliases = '[' + p.aliases.join(', ') + ']';
  if (p.private) frontmatter.visibility = 'private';
  return beliefPage({ title: p.title, type: p.type, prose: p.prose, facts: p.facts, takes: p.takes, links: p.links, frontmatter });
}

export const dbNow = async (b: BeliefBrain) =>
  new Date((await b.engine.executeRaw<{ t: string }>("SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS t"))[0]!.t).toISOString();
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
/** A quiescent instant: every transaction recorded before it committed and carries its commit mark. */
export async function quiescentInstant(b: BeliefBrain): Promise<string> {
  await fillCommitMarks(b.engine, b.sourceId);
  await pause();
  const t = await dbNow(b);
  await pause();
  return t;
}

export const revisionOf = async (b: BeliefBrain, slug: string) =>
  (await b.engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, slug]))[0]!.r;
export const lifetimeOf = async (b: BeliefBrain, slug: string) =>
  (await b.engine.executeRaw<{ l: string }>(`SELECT page_lifetime::text AS l FROM belief_events WHERE source_id = $1 AND slug = $2 AND subject_kind = 'page'
    AND page_lifetime IS NOT NULL ORDER BY id DESC LIMIT 1`, [b.sourceId, slug]))[0]!.l;

export async function deletePage(b: BeliefBrain, slug: string): Promise<void> {
  await b.op('delete_page', { slug, expected_revision: await revisionOf(b, slug) });
}

/** Forgets one fact and waits for the withdrawal's materialization (a body rewrite at the same revision). */
export async function forgetFact(b: BeliefBrain, slug: string, claimPrefix: string): Promise<void> {
  const [fact] = await b.engine.executeRaw<{ id: number }>(`SELECT f.id FROM facts f WHERE f.source_id = $1 AND f.fact LIKE $2 AND f.expired_at IS NULL ORDER BY f.id LIMIT 1`,
    [b.sourceId, claimPrefix + '%']);
  if (!fact) throw new Error('forgetFact: no fact starting ' + claimPrefix + ' on ' + slug);
  const mark = await b.lastId();
  await operationsByName.forget!.handler(b.ctx, { id: String(fact.id), request_id: randomUUID() });
  await waitForValue(async () => (await b.events(mark)).find(e => e.cause.op === 'withdrawal_materialize'), { timeoutMs: 30_000, label: 'withdrawal materialization' });
}

/** Makes one page look created before the history index existed: its rows are gone and the source's index cut is unset, as the migration leaves a ledger source. */
export async function simulatePreMigration(b: BeliefBrain, slugs: string[]): Promise<void> {
  for (const slug of slugs) {
    await b.engine.executeRaw('DELETE FROM belief_text_revisions WHERE source_id = $1 AND page_lifetime = $2::uuid', [b.sourceId, await lifetimeOf(b, slug)]);
  }
  await b.engine.executeRaw('UPDATE belief_text_index_state SET index_cut = NULL, build_pass = 0 WHERE source_id = $1', [b.sourceId]);
}

/** Pages created before the ledger is enabled (the baseline-only page). */
export async function seedBaseline(b: BeliefBrain, plan: WorldPlan): Promise<void> {
  const p = plan.pages.find(x => x.slug === plan.special.baseline)!;
  await b.put(p.slug, renderWorldPage(p));
}

/** The fixed history up to T, with each interval shape a careless index misses. */
export async function buildBeforeT(b: BeliefBrain, plan: WorldPlan): Promise<World> {
  const byslug = new Map(plan.pages.map(p => [p.slug, p]));
  for (const p of plan.pages) if (p.slug !== plan.special.baseline) await b.put(p.slug, renderWorldPage(p));
  for (const p of plan.pages) {
    if ([plan.special.baseline, plan.special.premigration].includes(p.slug) || !plan.chance(0.3)) continue;
    p.prose += ' ' + plan.word() + ' ' + plan.pick(plan.topics) + '.';
    await b.put(p.slug, renderWorldPage(p));
  }
  await forgetFact(b, plan.special.forget, plan.forgotten[0]!.toUpperCase() + plan.forgotten.slice(1));
  byslug.get(plan.special.forget)!.facts = byslug.get(plan.special.forget)!.facts.slice(0, 1);
  await deletePage(b, plan.special.restored);
  await b.put(plan.special.restored, renderWorldPage(byslug.get(plan.special.restored)!));
  await deletePage(b, plan.special.deletedAtT);
  await simulatePreMigration(b, [plan.special.premigration]);
  await buildHistoryIndex(b.engine, b.sourceId, { apply: true });
  const T = await quiescentInstant(b);
  const lifetimes = new Map<string, string>();
  for (const p of plan.pages) lifetimes.set(p.slug, await lifetimeOf(b, p.slug));
  return { ...plan, T, lifetimes };
}

/** The later history (section 7): 30 to 60 seeded changes after T that a T-bounded read must not see. */
export async function applyLaterHistory(b: BeliefBrain, w: World): Promise<number> {
  let changes = 0;
  const live = w.pages.filter(p => p.slug !== w.special.deletedAtT);
  const removedPages = new Set(w.questions.filter(q => q.removed).map(q => q.removed!.slug));
  for (const q of w.questions.filter(x => x.removed)) {
    const decoys = live.filter(p => !removedPages.has(p.slug)).slice(0, 5);
    for (const d of decoys) d.prose += ' ' + q.text.replace(/[?]/g, '').split(' ').filter(t => t.toLowerCase() !== q.removed!.phrase.toLowerCase()).slice(-1)[0] + ' noted.';
  }
  for (const p of live) {
    for (const phrase of w.removed) p.prose = p.prose.split(phrase[0]!.toUpperCase() + phrase.slice(1)).join(w.word());
    p.takes = p.takes.filter(t => !w.removed.some(r => t.claim.toLowerCase().includes(r)));
    if (w.chance(0.5)) p.takes.push({ claim: w.word() + ' ' + w.pick(w.topics), who: w.chance(0.5) ? 'world' : 'garry', weight: '0.9' });
    else if (p.takes[0]) p.takes[0].weight = '0.1';
    p.links = w.chance(0.5) ? [...p.links, w.pick(live).slug].filter(s => s !== p.slug) : p.links.slice(1);
    p.prose = w.pick(w.topics) + ' ' + p.prose + ' ' + w.questions.map(q => q.text.split(' ').at(-1)!.replace('?', '')).slice(5, 8).join(' ') + '.';
    if (p.slug === w.special.alias) p.aliases = [];
    if (w.special.synthesis.includes(p.slug)) p.prose = 'Rewritten ' + w.topics.join(' ') + ' ' + w.questions.filter(q => !q.removed).map(q => q.text.replace('?', '')).join(' ') + '.';
    await b.put(p.slug, renderWorldPage(p));
    changes++;
  }
  const other = live.find(p => p.slug !== w.special.alias && !removedPages.has(p.slug))!;
  other.aliases = [w.alias];
  await b.put(other.slug, renderWorldPage(other));
  changes++;
  for (let i = 0; i < 3; i++) {
    const fresh: WorldPage = { slug: 'notes/' + w.word() + '-example', title: w.alias + ' ' + i, type: 'note', prose: w.questions.filter(q => !q.removed).map(q => q.text).join(' '),
      facts: [], takes: [{ claim: w.topics.join(' '), who: 'world' }], links: [w.special.alias], aliases: [] };
    await b.put(fresh.slug, renderWorldPage(fresh));
    changes++;
  }
  for (const slug of [w.special.baseline, w.special.forget]) {
    const to = slug.replace('-example', '-renamed-example');
    const [{ tier }] = await b.engine.executeRaw<{ tier: string }>('SELECT trust_tier AS tier FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, slug]);
    await renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: slug, newSlug: to, to: to + '.md' });
    // A sync rename retiers the moved page; restoring its tier keeps the later history free of restrictions (the trust cell tests a demotion).
    await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () => withTrustPromotion(tx, 'user_confirmed', () =>
      tx.executeRaw('UPDATE pages SET trust_tier = $3 WHERE source_id = $1 AND slug = $2', [b.sourceId, to, tier])), TEST_WRITE_ATTRIBUTION));
    changes++;
  }
  for (const p of live.filter(x => !removedPages.has(x.slug) && !x.private).slice(5, 7)) {
    await deletePage(b, p.slug);
    await b.put(p.slug, renderWorldPage(p));
    changes += 2;
  }
  await b.engine.executeRaw('UPDATE pages SET emotional_weight = 0.9 WHERE source_id = $1', [b.sourceId]);
  await b.engine.executeRaw(`INSERT INTO config (key, value) VALUES ('embedding_model', 'probe:later-model') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  for (const q of w.questions) {
    const results = live.slice(0, 3).map((p, i) => ({ slug: p.slug, page_id: 0, title: p.title, type: p.type, chunk_text: 'cached ' + q.text, chunk_source: 'compiled_truth',
      chunk_id: 0, chunk_index: 0, score: 1 - i / 10, stale: false, source_id: b.sourceId }));
    await b.engine.executeRaw(`INSERT INTO query_cache (id, query_text, source_id, results) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO UPDATE SET results = EXCLUDED.results`,
      [cacheRowId(q.text, b.sourceId), q.text, b.sourceId, JSON.stringify(results)]);
  }
  changes += 3;
  await fillCommitMarks(b.engine, b.sourceId);
  return changes;
}

export interface Caller { name: 'local' | 'remote'; ctx: OperationContext; think: { remote: boolean; sourceId: string; takesHoldersAllowList?: string[] } }
export function callers(b: BeliefBrain): Caller[] {
  return [
    { name: 'local', ctx: b.ctx, think: { remote: false, sourceId: b.sourceId } },
    { name: 'remote', ctx: { ...b.ctx, remote: true, transport: 'stdio', takesHoldersAllowList: ['world'] } as OperationContext,
      think: { remote: true, sourceId: b.sourceId, takesHoldersAllowList: ['world'] } },
  ];
}

/** Runs think with a stub client and returns the user message it built; the stub cites the first two pages it was shown. */
export async function thinkPrompt(b: BeliefBrain, caller: Caller, question: string, knownAsOf?: string) {
  const capture = { user: '' };
  const client: ThinkLLMClient = {
    create: async params => {
      const content = params.messages[0]?.content;
      capture.user = typeof content === 'string' ? content : JSON.stringify(content);
      const slugs = [...capture.user.matchAll(/<page slug="([^"]+)"/g)].map(m => m[1]!).slice(0, 2);
      const text = JSON.stringify({ answer: slugs.length ? 'See ' + slugs.map(s => '[[' + s + ']]').join(' and ') + '.' : 'Nothing recorded.',
        citations: slugs.map((s, i) => ({ page_slug: s, row_num: null, citation_index: i + 1 })), gaps: [] });
      return { id: 'msg_history', type: 'message', role: 'assistant', model: 'stub', stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
        content: [{ type: 'text', text }] } as never;
    },
  };
  const result = await runThink(b.engine, { question, client, ...caller.think, ...(knownAsOf ? { knownAsOf } : {}) });
  return { prompt: capture.user, result };
}

/** The page and take blocks of a think user message: the evidence, without the question it repeats. */
export const evidenceBlocks = (prompt: string) => [...prompt.matchAll(/<(page|take) [^>]*>[\s\S]*?<\/\1>/g)].map(m => m[0]).join('\n');

/** Everything the invariance assertion compares for one question: the user message, the known_as_of block, each citation's (slug, revision), and search {known_as_of}. */
export async function captureEvidence(b: BeliefBrain, caller: Caller, q: Question, T: string): Promise<string> {
  const { prompt, result } = await thinkPrompt(b, caller, q.text, T);
  const search = await operationsByName.search!.handler(caller.ctx, { query: q.text, known_as_of: T, source_id: b.sourceId });
  return JSON.stringify({ prompt, known_as_of: (result as { known_as_of?: unknown }).known_as_of ?? null,
    citations: result.citations.map(c => [c.page_slug, (c as { revision?: string }).revision ?? null]), search }, null, 1);
}

export interface Ranked { pages: Array<[string, string, string | null, string]>; takes: Array<[string, string, string]> }
const score6 = (n: number) => n.toFixed(6);

/** The indexed retriever's ranking, in the oracle's shape. */
export async function retrieverRanking(b: BeliefBrain, caller: Caller, query: string, T: string, limit: number): Promise<Ranked> {
  const out = await readHistoricalCandidates(b.engine, { query, at: new Date(T), sources: [b.sourceId], remote: caller.think.remote,
    holders: caller.think.takesHoldersAllowList, limit });
  return { pages: out.pages.map(p => [p.slug, p.lifetime, p.revision, score6(p.score)]), takes: out.takes.map(t => [t.page_slug, t.take_key, score6(t.score)]) };
}

/**
 * The brute-force reference (assertion 3): every page live at T read with
 * readPageAtTime, its T body under the restrictions bounded by now (the
 * withdrawal union, and for a remote caller the sanitized body without rows
 * made private later or hidden by a purge), chunked and scored with the
 * retriever's scorer, ranked on (score, source, lifetime).
 */
export async function oracleRanking(b: BeliefBrain, caller: Caller, query: string, T: string, limit: number): Promise<Ranked> {
  const at = new Date(T);
  const slugs = (await b.engine.executeRaw<{ slug: string }>(`SELECT DISTINCT slug FROM belief_events WHERE source_id = $1 AND subject_kind = 'page' AND origin <> 'backfill' ORDER BY slug`,
    [b.sourceId])).map(r => r.slug);
  const docs: Array<{ key: string; slug: string; lifetime: string; revision: string | null; title: string | null; chunks: string[] }> = [];
  const takes: Array<{ key: string; slug: string; take_key: string; chunks: string[] }> = [];
  const seen = new Set<string>();
  for (const slug of slugs) {
    const read = await readPageAtTime(b.engine, { sourceId: b.sourceId, slug, at }).catch(() => null);
    const i = read?.current;
    if (!read || !i || i.deleted || i.slug !== slug || !i.page || (i.body !== 'live' && i.body !== 'version') || seen.has(i.lifetime)) continue;
    if (caller.think.remote && !await remoteMayRead(b.engine, read.page_id, i)) continue;
    seen.add(i.lifetime);
    const scope = { sourceId: b.sourceId, interval: i, at, remote: caller.think.remote, holders: caller.think.takesHoldersAllowList ?? ['world'] };
    const body = await historicalBody(b.engine, scope);
    docs.push({ key: i.lifetime, slug, lifetime: i.lifetime, revision: i.revision, title: i.page.title, chunks: historyBodyChunks(body.compiled_truth, body.timeline) });
    for (const t of await historyTakeRows(b.engine, { ...scope, body })) {
      takes.push({ key: i.lifetime + '\u0000' + t.take_key, slug, take_key: t.take_key, chunks: [t.claim] });
    }
  }
  const pageScores = await historicalScore(b.engine, query, docs.map(d => ({ key: d.key, title: d.title, chunks: d.chunks })));
  const takeScores = await historicalScore(b.engine, query, takes.map(t => ({ key: t.key, title: null, chunks: t.chunks })));
  const pages = docs.filter(d => pageScores.get(d.key) != null)
    .sort((a, c) => pageScores.get(c.key)! - pageScores.get(a.key)! || a.lifetime.localeCompare(c.lifetime)).slice(0, limit)
    .map(d => [d.slug, d.lifetime, d.revision, score6(pageScores.get(d.key)!)] as [string, string, string | null, string]);
  const rankedTakes = takes.filter(t => takeScores.get(t.key) != null)
    .sort((a, c) => takeScores.get(c.key)! - takeScores.get(a.key)! || a.key.localeCompare(c.key)).slice(0, limit)
    .map(t => [t.slug, t.take_key, score6(takeScores.get(t.key)!)] as [string, string, string]);
  return { pages, takes: rankedTakes };
}

/** One seeded world on one engine: the baseline page before enable, the history up to T, then `run`. */
export function withWorld(seed: number, databaseUrl: string | undefined, run: (b: BeliefBrain, w: World) => Promise<void>): Promise<void> {
  const plan = planWorld(seed);
  return beliefBrain(async b => run(b, await buildBeforeT(b, plan)), { managed: false, databaseUrl, setup: b => seedBaseline(b, plan) });
}
