/**
 * GBRA-156: a warm search's post-rerank reads that do not depend on each
 * other run at once. Each serial read costs one database round trip of wall
 * time on a pooled Postgres (66 ms through a remote PgBouncer).
 *
 * 1. Protects: the generated-page read overlaps the post-fusion boosts, the
 *    alias hop's table read overlaps the reranker and feedback stage, the
 *    alias fan-out's entity reads overlap the hybrid search, the page-trust
 *    read overlaps evidence delivery, and the saved-fact match is one
 *    statement (its existence probe gates the scan inside it).
 * 2. Fails when: any of those reads is awaited after the stage it overlaps
 *    again, or the saved-fact probe becomes its own statement again.
 * 3. Existing coverage: test/search-provenance-demotion.test.ts,
 *    test/search-alias-fanout.test.ts, test/search-other-names.test.ts and
 *    test/search-response-meta-concurrency.test.ts pin what those reads find,
 *    not when they are issued.
 * 4. Seam: none. Statement start and finish are observed on the PGLite handle
 *    the engine uses (one connection, so a read issued before another one
 *    answered was issued concurrently).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { basisEmbedding } from '../src/eval/deterministic-embed.ts';
import { installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;
const events: Array<{ at: 'start' | 'end'; sql: string; params: unknown[] }> = [];

async function seed(slug: string, type: string, text: string, title: string, frontmatter: Record<string, unknown> = {}) {
  await engine.putPage(slug, { type, title, compiled_truth: text, timeline: '', frontmatter } as never);
  const snap = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
  await installPageProjection(engine, snap, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', embedding: basisEmbedding(7, 1536), token_count: 10 }] as never, { seal: true });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seed('companies/widget-co', 'company', 'Widget Co makes widgets. Widget renewal terms are net 30.', 'Widget Co');
  await seed('notes/widget-renewal', 'note', 'Widget renewal terms were agreed in March.', 'Widget renewal');
  await seed('notes/gadget-digest', 'note', 'Digest: gadget orders shipped on time.', 'Gadget digest', { dream_generated: true });
  await engine.setConfig('feedback.enabled', 'true');
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES
    ('default', 'widget-co', 'Widget-co renewal terms moved to net 45.', 'fact', 'world', 'user update')`);
  const db = engine.db as unknown as { query: (sql: string, ...rest: unknown[]) => Promise<unknown> };
  const query = db.query.bind(db);
  db.query = (sql: string, ...rest: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    const params = Array.isArray(rest[0]) ? rest[0] as unknown[] : [];
    events.push({ at: 'start', sql: text, params });
    return query(sql, ...rest).finally(() => events.push({ at: 'end', sql: text, params }));
  };
}, 120_000);

afterAll(async () => {
  await engine?.disconnect();
});

const first = (at: 'start' | 'end', match: (e: { sql: string; params: unknown[] }) => boolean) => events.findIndex(e => e.at === at && match(e));
const has = (needle: string) => (e: { sql: string }) => e.sql.includes(needle);

describe('hybrid search (fused path)', () => {
  const noRerank = { enabled: false, topNIn: 0, topNOut: null } as never;

  test('the generated-page read is issued before the post-fusion backlink read answers', async () => {
    events.length = 0;
    const rows = await hybridSearch(engine, 'gadget orders', { queryEmbedFn: () => basisEmbedding(7, 1536), reranker: noRerank });
    expect(rows.find(r => r.slug === 'notes/gadget-digest')?.provenance).toBe('generated');
    const generatedStart = first('start', has("frontmatter->>'dream_generated' = 'true'"));
    const backlinkEnd = first('end', has('COUNT(DISTINCT l.from_page_id)::int AS cnt'));
    expect(generatedStart).toBeGreaterThan(-1);
    expect(backlinkEnd).toBeGreaterThan(-1);
    expect(generatedStart).toBeLessThan(backlinkEnd);
  }, 60_000);

  test("the alias hop's table read is issued before the feedback stage's read answers", async () => {
    events.length = 0;
    const rows = await hybridSearch(engine, 'Widget Co renewal terms', { queryEmbedFn: () => basisEmbedding(7, 1536), reranker: noRerank });
    expect(rows.map(r => r.slug)).toContain('companies/widget-co');
    const aliasHop = (e: { sql: string; params: unknown[] }) => e.sql.startsWith('WITH a AS MATERIALIZED')
      && JSON.stringify(e.params[0]) === JSON.stringify(['widget co renewal terms']);
    const aliasHopStart = first('start', aliasHop);
    const feedbackEnd = first('end', has('p.content_hash, CASE WHEN w.weight IS NULL'));
    expect(aliasHopStart).toBeGreaterThan(-1);
    expect(feedbackEnd).toBeGreaterThan(-1);
    expect(aliasHopStart).toBeLessThan(feedbackEnd);
  }, 60_000);
});

describe('search op (remote)', () => {
  const search = (args: Record<string, unknown>) => dispatchToolCall(engine, 'search', args, { remote: true, transport: 'http', sourceId: 'default' });
  const text = (r: Awaited<ReturnType<typeof search>>) => r.content.map(c => c.text ?? '').join('\n');

  test('without an embedding provider the generated-page read is issued before the post-fusion backlink read answers', async () => {
    events.length = 0;
    const r = await search({ query: 'gadget orders' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('notes/gadget-digest');
    const generatedStart = first('start', has("frontmatter->>'dream_generated' = 'true'"));
    const backlinkEnd = first('end', has('COUNT(DISTINCT l.from_page_id)::int AS cnt'));
    expect(generatedStart).toBeGreaterThan(-1);
    expect(backlinkEnd).toBeGreaterThan(-1);
    expect(generatedStart).toBeLessThan(backlinkEnd);
  }, 60_000);

  test("the alias fan-out's entity reads are issued before the hybrid search's content-flag read", async () => {
    events.length = 0;
    const r = await search({ query: 'Widget Co renewal terms' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('companies/widget-co');
    const titleReadStart = first('start', has('lower(title) AS t FROM pages'));
    const contentFlagStart = first('start', has("frontmatter->'content_flag'->>'reason'"));
    expect(titleReadStart).toBeGreaterThan(-1);
    expect(contentFlagStart).toBeGreaterThan(-1);
    expect(titleReadStart).toBeLessThan(contentFlagStart);
  }, 60_000);

  test('the page-trust read is issued before the evidence read answers', async () => {
    events.length = 0;
    const r = await search({ query: 'widget renewal terms', return_unit: 'page' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('"trust_tier"');
    const trustStart = first('start', has('trust_tier, write_origin'));
    const evidenceEnd = first('end', e => e.sql.startsWith('WITH req AS'));
    expect(trustStart).toBeGreaterThan(-1);
    expect(evidenceEnd).toBeGreaterThan(-1);
    expect(trustStart).toBeLessThan(evidenceEnd);
  }, 60_000);

  test('the saved-fact match is one statement and still finds the fact', async () => {
    events.length = 0;
    const r = await search({ query: 'widget renewal terms' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('Widget-co renewal terms moved to net 45.');
    const factReads = events.filter(e => e.at === 'start' && /\bFROM facts f WHERE f\.source_id = ANY\(\$1::text\[\]\)/.test(e.sql));
    expect(factReads).toHaveLength(1);
  }, 60_000);

  test('a query no saved fact matches still costs one statement and reports none', async () => {
    events.length = 0;
    const r = await search({ query: 'gadget orders shipped' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).not.toContain('Saved facts');
    const factReads = events.filter(e => e.at === 'start' && /\bFROM facts f WHERE f\.source_id = ANY\(\$1::text\[\]\)/.test(e.sql));
    expect(factReads).toHaveLength(1);
  }, 60_000);
});
