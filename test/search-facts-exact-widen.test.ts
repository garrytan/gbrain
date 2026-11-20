/**
 * A plain question about a person finds their saved facts, and a thin or degraded result is widened with the
 * literal scan (#7743, partly): the facts arm's keyword pool is cut by term coverage before ts_rank_cd
 * (search/fact-relevance.ts), a fact that holds every query term may take the place of the lowest page rows
 * (`search.facts_arm_displace`), `search` runs the facts arm too (`search.search_facts_arm`), and a result
 * that is degraded, or whose rows never hold every query term, also runs search_exact's scan for the
 * terms as a phrase (`search.exact_widen`). PGLite, keyword-only, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { collectFactCandidates } from '../src/core/search/fact-relevance.ts';
import { FACTS_ARM_DISPLACE_KEY, MAX_FACT_ROWS, QUERY_FACTS_ARM_KEY, SEARCH_FACTS_ARM_KEY } from '../src/core/search/facts-arm.ts';
import { EXACT_WIDEN_KEY, holdsEveryTerm, mergeExactHits, widenPhrase, widenReason } from '../src/core/search/exact-widen.ts';
import type { SearchResult } from '../src/core/types.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

let engine: PGLiteEngine;
/** No saved fact names an entity (the shape a live-ingestion harness saves). */
let loose: string;
/** The facts name people/alice-example, whose page exists. */
let anchored: string;

const PHONE = "Alice Example's phone is an Orbix P9";
const CAR = 'Alice Example drives an Orbix Volt';
const PRIVATE = "Alice Example's phone is a private number 0000";

const search = async (sourceId: string, q: string, params: Record<string, unknown> = {}) =>
  await handleToolCall(engine, 'search', { query: q, source_id: sourceId, limit: 10, ...params }) as SearchResult[];
const query = async (sourceId: string, q: string, params: Record<string, unknown> = {}) =>
  await handleToolCall(engine, 'query', { query: q, expand: false, use_cache: false, source_id: sourceId, limit: 10, ...params }) as SearchResult[];
const factRows = (rows: SearchResult[]) => rows.filter(r => r.result_type === 'fact');
const hasFact = (rows: SearchResult[], text: string) => factRows(rows).some(r => r.chunk_text.includes(text));
const logger = { info() {}, warn() {}, error() {} };

async function seed(sourceId: string, entity: string | null): Promise<void> {
  // Twelve pages that hold the person's name and "phone", so the page rows fill a limit of 10.
  for (let i = 0; i < 12; i++) {
    await putPage(engine, sourceId, `notes/standup-${i}`, page('note', `Standup ${i}`, `Alice Example's phone tree reminder number ${i}: Alice Example keeps the standup ${i} short.`));
  }
  if (entity) await putPage(engine, sourceId, entity, page('person', 'Alice Example', 'Alice Example works on the platform team.'));
  const base = { kind: 'fact', source: 'test', visibility: 'world' } as const;
  // The facts that answer: older than every filler.
  await engine.insertFact({ ...base, fact: PHONE, entity_slug: entity, valid_from: new Date('2025-07-01T00:00:00Z') }, { source_id: sourceId });
  await engine.insertFact({ ...base, fact: CAR, entity_slug: entity, valid_from: new Date('2025-07-02T00:00:00Z') }, { source_id: sourceId });
  // Sixty-odd newer facts that repeat the name and hold neither "phone" nor "car".
  for (let i = 0; i < 64; i++) {
    await engine.insertFact({ ...base, fact: `Alice Example asked Alice Example's team about item ${i} for Alice Example's roadmap`, entity_slug: null,
      valid_from: new Date(Date.UTC(2025, 7, 1, i)) }, { source_id: sourceId });
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  loose = await newSource(engine);
  anchored = await newSource(engine);
  await seed(loose, null);
  await seed(anchored, 'people/alice-example');
}, 180_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

const reset = async () => { for (const k of [FACTS_ARM_DISPLACE_KEY, SEARCH_FACTS_ARM_KEY, QUERY_FACTS_ARM_KEY, EXACT_WIDEN_KEY, 'search.query_facts_block']) await engine.executeRaw('DELETE FROM config WHERE key = $1', [k]); };

describe('facts pool: term coverage first', () => {
  test('the fact that holds every query term ranks in the first three of a pool a repeated name floods', async () => {
    const pool = await collectFactCandidates(engine, "Alice Example's phone", { sourceId: loose, worldOnly: false, excludePrivate: false }, null, { depth: { keyword: 50, cosine: 10, entity: 3 } });
    const at = pool.candidates.findIndex(c => c.fact === PHONE);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(3);
  });

  test('a term only some facts hold still orders by coverage: "car" finds the facts that hold it ahead of name-only facts', async () => {
    await engine.insertFact({ kind: 'fact', source: 'test', visibility: 'world', fact: 'Bob Example has a car', entity_slug: null, valid_from: new Date('2025-06-01T00:00:00Z') }, { source_id: loose });
    try {
      const pool = await collectFactCandidates(engine, 'Bob Example car', { sourceId: loose, worldOnly: false, excludePrivate: false }, null, { depth: { keyword: 50, cosine: 10, entity: 3 } });
      expect(pool.candidates[0]!.fact).toBe('Bob Example has a car');
    } finally { await engine.executeRaw(`DELETE FROM facts WHERE fact = 'Bob Example has a car'`); }
  });
});

describe('facts arm for query and search', () => {
  test('query "what phone does Alice Example have" returns the phone fact although pages fill the row count', async () => {
    await reset();
    const rows = await query(loose, 'what phone does Alice Example have');
    expect(rows.filter(r => r.result_type !== 'fact').length).toBeGreaterThan(5);
    expect(hasFact(rows, 'Orbix P9')).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(factRows(rows).length).toBeLessThanOrEqual(MAX_FACT_ROWS);
  });

  test('search "Alice Example\'s phone" returns the phone fact although pages fill the row count', async () => {
    await reset();
    const rows = await search(loose, "Alice Example's phone");
    expect(rows.filter(r => r.result_type !== 'fact').length).toBeGreaterThan(5);
    expect(hasFact(rows, 'Orbix P9')).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(factRows(rows)[0]).toMatchObject({ result_type: 'fact', follow_up: { op: 'recall' } });
    expect(factRows(rows)[0]).not.toHaveProperty('slug');
  });

  test('with the person page in the brain, the same questions find the fact too', async () => {
    await reset();
    expect(hasFact(await query(anchored, 'what phone does Alice Example have'), 'Orbix P9')).toBe(true);
    expect(hasFact(await search(anchored, "Alice Example's phone"), 'Orbix P9')).toBe(true);
  });

  test('"what car does Alice Example have" returns the Volt fact from the person\'s own facts', async () => {
    await reset();
    const rows = await query(anchored, 'what car does Alice Example have', { limit: 25 });
    expect(hasFact(rows, 'Orbix Volt')).toBe(true);
  });

  test('a weaker match never displaces a page: the Volt fact (no "car" in it) takes only free rows', async () => {
    await reset();
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false');
    const without = (await query(anchored, 'what car does Alice Example have', { limit: 10 })).filter(r => r.result_type !== 'fact');
    await reset();
    const withArm = await query(anchored, 'what car does Alice Example have', { limit: 10 });
    expect(without.length).toBeGreaterThan(5);
    expect(withArm.filter(r => r.result_type !== 'fact').map(r => r.slug)).toEqual(without.map(r => r.slug));
    expect(withArm.length).toBeLessThanOrEqual(10);
  });

  test('facts_arm_displace off: a full page list drops every fact again, in query and in search', async () => {
    await reset();
    await engine.setConfig(FACTS_ARM_DISPLACE_KEY, 'false');
    try {
      const q = await query(loose, 'what phone does Alice Example have');
      const s = await search(loose, "Alice Example's phone");
      expect(factRows(q)).toHaveLength(0);
      expect(factRows(s)).toHaveLength(0);
      expect(q).toHaveLength(10);
      expect(s).toHaveLength(10);
    } finally { await reset(); }
  });

  test('facts_arm_displace off still fills free rows', async () => {
    await reset();
    await engine.setConfig(FACTS_ARM_DISPLACE_KEY, 'off');
    try {
      expect(hasFact(await query(loose, 'what phone does Alice Example have', { limit: 25 }), 'Orbix P9')).toBe(true);
    } finally { await reset(); }
  });

  test('search_facts_arm off: search returns no fact row, query still does', async () => {
    await reset();
    await engine.setConfig(SEARCH_FACTS_ARM_KEY, 'false');
    try {
      expect(factRows(await search(loose, "Alice Example's phone", { limit: 25 }))).toHaveLength(0);
      expect(factRows(await search(loose, "Alice Example's phone"))).toHaveLength(0);
      expect(hasFact(await query(loose, 'what phone does Alice Example have'), 'Orbix P9')).toBe(true);
    } finally { await reset(); }
  });

  test('search skips the arm under paging and filters, as query does', async () => {
    await reset();
    expect(factRows(await search(loose, "Alice Example's phone", { offset: 1 }))).toHaveLength(0);
    expect(factRows(await search(loose, "Alice Example's phone", { types: ['note'] }))).toHaveLength(0);
    expect(factRows(await search(loose, "Alice Example's phone", { match: 'keyword' }))).toHaveLength(0);
  });

  test('keyword-only search (search.mcp_keyword_only) runs the arm as well', async () => {
    await reset();
    await engine.setConfig('search.mcp_keyword_only', 'true');
    try {
      expect(hasFact(await search(loose, "Alice Example's phone"), 'Orbix P9')).toBe(true);
    } finally { await engine.executeRaw(`DELETE FROM config WHERE key = 'search.mcp_keyword_only'`); }
  });

  test('a remote caller gets the world fact and never a private one, in search', async () => {
    await reset();
    const src = await newSource(engine);
    await seed(src, null);
    await engine.insertFact({ kind: 'fact', source: 'test', visibility: 'private', fact: PRIVATE, entity_slug: null, valid_from: new Date('2025-07-03T00:00:00Z') }, { source_id: src });
    const auth = { token: 't', clientId: 'widen-probe', scopes: ['read'], sourceId: src, allowedSources: [src] };
    const remote = async (q: string) => (await dispatchToolCall(engine, 'search', { query: q, limit: 10 }, { remote: true, transport: 'stdio', sourceId: src, auth, config: { engine: engine.kind } as never, logger }))
      .content.map(c => (c as { text?: string }).text ?? '').join('\n');
    const text = await remote("Alice Example's phone");
    expect(text).toContain('Orbix P9');
    expect(text).not.toContain('private number');
    // The local owner reads the private fact.
    expect(hasFact(await search(src, "Alice Example's phone"), 'private number')).toBe(true);
  });
});

describe('exact widening', () => {
  const PHRASE = 'zephyr quartz lantern';
  let widenSource: string;
  const filler = (tag: string) => Array.from({ length: 140 }, (_, i) => `${tag} paragraph ${i}: the rollout notes cover scheduling, staffing and the usual budget review items.`).join('\n\n');

  beforeAll(async () => {
    widenSource = await newSource(engine);
    // One long page whose only mention of the phrase sits in a middle chunk, and whose search vector for that chunk is missing.
    const body = `${filler('Opening')}\n\nThe vendor code name is ${PHRASE} and nothing else says so.\n\n${filler('Closing')}`;
    await putPage(engine, widenSource, 'notes/long-plan', page('note', 'Long plan', body));
    await putPage(engine, widenSource, 'notes/short-plan', page('note', 'Short plan', 'A short plan about the rollout.'));
    const chunks = await engine.executeRaw<{ id: number; chunk_index: number; chunk_text: string }>(
      `SELECT cc.id, cc.chunk_index, cc.chunk_text FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.source_id = $1 AND p.slug = 'notes/long-plan' ORDER BY cc.chunk_index`, [widenSource]);
    const hit = chunks.filter(c => c.chunk_text.includes(PHRASE));
    expect(chunks.length).toBeGreaterThan(2);
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0]!.chunk_index).toBeGreaterThan(0);
    expect(hit[0]!.chunk_index).toBeLessThan(chunks.length - 1);
    await engine.executeRaw('UPDATE content_chunks SET search_vector = NULL WHERE id = ANY($1::int[])', [hit.map(c => Number(c.id))]);
  }, 120_000);

  const ctxOf = (meta: Record<string, unknown>): OperationContext => ({ engine, config: { engine: engine.kind, embedding_disabled: true } as never, remote: false, sourceId: widenSource, dryRun: false, logger,
    emitResponseMeta: (k: string, v: unknown) => { meta[k] = v; }, emitNotice() {} }) as unknown as OperationContext;
  const run = async (name: 'search' | 'query', q: string, params: Record<string, unknown> = {}) => {
    const meta: Record<string, unknown> = {};
    const rows = await operations.find(o => o.name === name)!.handler(ctxOf(meta), { query: q, limit: 10, ...(name === 'query' ? { expand: false, use_cache: false } : {}), ...params }) as SearchResult[];
    return { rows, meta: (meta.retrieval ?? {}) as Record<string, unknown> };
  };

  test('off: the unindexed chunk is not found by ranked search (the premise)', async () => {
    await reset();
    await engine.setConfig(EXACT_WIDEN_KEY, 'false');
    try {
      for (const name of ['search', 'query'] as const) {
        const { rows, meta } = await run(name, PHRASE);
        expect(rows.some(r => r.slug === 'notes/long-plan')).toBe(false);
        expect(meta.exact_widened).toBeUndefined();
      }
    } finally { await reset(); }
  });

  test('on: a thin search and a thin query return the page, mark it and set exact_widened', async () => {
    await reset();
    for (const name of ['search', 'query'] as const) {
      const { rows, meta } = await run(name, PHRASE);
      const hit = rows.find(r => r.slug === 'notes/long-plan');
      expect(hit, `${name} returns the long page`).toBeDefined();
      expect(hit!.widened).toBe('exact');
      expect(hit!.chunk_text).toContain(PHRASE);
      expect(hit!.chunk_id).toBeGreaterThan(0);
      expect(meta.exact_widened).toBe(true);
      expect(rows.filter(r => r.widened).length).toBeLessThanOrEqual(3);
    }
  });

  test('a result that already holds every query term does not run the scan', async () => {
    await reset();
    const { rows, meta } = await run('search', 'short plan rollout');
    expect(rows.some(r => r.slug === 'notes/short-plan')).toBe(true);
    expect(rows.some(r => r.widened)).toBe(false);
    expect(meta.exact_widened).toBeUndefined();
  });

  test('paging and filters never widen', async () => {
    await reset();
    expect((await run('search', PHRASE, { offset: 1 })).meta.exact_widened).toBeUndefined();
    expect((await run('search', PHRASE, { types: ['note'] })).meta.exact_widened).toBeUndefined();
  });

  test('the rules: a long query has no phrase, thin means no row holds every term, degraded means a stage that affects recall', () => {
    expect(widenPhrase(PHRASE)).toEqual({ phrase: PHRASE, terms: ['zephyr', 'quartz', 'lantern'] });
    expect(widenPhrase('what is the status of the long running rollout plan that nobody owns and everyone keeps asking about')).toBeNull();
    expect(holdsEveryTerm("Alice Example’s phone", ['alice', "example's", 'phone'])).toBe(true);
    const row = (text: string) => ({ chunk_text: text });
    expect(widenReason([row('zephyr only')], ['zephyr', 'quartz'], undefined)).toBe('thin');
    expect(widenReason([row('zephyr quartz')], ['zephyr', 'quartz'], undefined)).toBeNull();
    expect(widenReason([row('zephyr quartz')], ['zephyr', 'quartz'], [{ stage: 'reranker_skipped' }])).toBeNull();
    expect(widenReason([row('zephyr quartz')], ['zephyr', 'quartz'], [{ stage: 'embed_unavailable', reason: 'embed_timeout' }])).toBe('degraded');
    expect(widenReason([row('zephyr quartz')], ['zephyr', 'quartz'], [{ stage: 'embed_unavailable', reason: 'embedding_disabled' }])).toBeNull();
    expect(widenReason([row('zephyr only')], ['zephyr', 'quartz'], [{ stage: 'embed_unavailable', reason: 'embedding_disabled' }])).toBe('thin');
  });

  test('merging: free rows first, then the lowest page rows for a thin result only, never a fact row or an identity hit', () => {
    const mk = (slug: string, score: number, extra: Partial<SearchResult> = {}) => ({ slug, source_id: 'default', score, chunk_text: slug, page_id: 1, ...extra }) as SearchResult;
    const hit = (slug: string) => mk(slug, 0, { widened: 'exact' });
    const rows = [mk('a', 0.9, { exact_lookup: 'slug' }), mk('b', 0.5), mk('c', 0.3), mk('fact', 0.1, { result_type: 'fact' })];
    const thin = mergeExactHits(rows, [hit('x'), hit('y'), hit('b')], 4, true);
    expect(thin.added.map(r => r.slug)).toEqual(['x', 'y']);
    expect(thin.rows.map(r => r.slug)).toEqual(['a', 'fact', 'x', 'y']);
    const degraded = mergeExactHits(rows, [hit('x')], 4, false);
    expect(degraded.added).toEqual([]);
    expect(degraded.rows).toBe(rows);
    const room = mergeExactHits(rows, [hit('x')], 5, false);
    expect(room.rows.map(r => r.slug)).toEqual([...rows.map(r => r.slug), 'x']);
    expect(room.rows.at(-1)!.score).toBeLessThan(0.1);
  });
});
