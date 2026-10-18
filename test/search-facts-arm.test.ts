/**
 * Facts arm for `query` (`search.query_facts_arm`, search/facts-arm.ts): with
 * the key on, an active fact that matches the question comes back as a row of
 * its own in spare capacity only (free slots under the row count, what the
 * pages leave of the token budget), never displacing a page; a remote caller never sees a
 * private fact; page-unit delivery passes the fact row through as written;
 * a page whose typed claim a newer fact covers is stamped superseded_claim;
 * the key is on when unset, and with it off the rows are unchanged; a fact
 * whose source page is quarantined never comes back; a fact row carries its
 * own trust tier, and the read floor and purge's rederive hold apply inside
 * the arm. PGLite, keyword-only, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { QUERY_FACTS_ARM_KEY, matchQueryFacts, queryTerms } from '../src/core/search/facts-arm.ts';
import { resultTokens } from '../src/core/search/token-budget.ts';
import type { SearchResult } from '../src/core/types.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';
import { withTrustPromotion } from '../src/core/persistence/context.ts';
import type { TrustTier } from '../src/core/trust/tier.ts';

let engine: PGLiteEngine;
let sourceId: string;
const Q = 'Where is the Forge offsite booked?';
const query = async (params: Record<string, unknown> = {}) => await handleToolCall(engine, 'query', { query: Q, expand: false, use_cache: false, source_id: sourceId, limit: 6, ...params }) as SearchResult[];
const remote = async (params: Record<string, unknown>) => {
  const auth = { token: 't', clientId: 'facts-probe', scopes: ['read'], sourceId, allowedSources: [sourceId] };
  const r = await dispatchToolCall(engine, 'query', { query: Q, expand: false, limit: 6, ...params }, { remote: true, transport: 'stdio', sourceId, auth, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
  return r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  for (let i = 0; i < 6; i++) {
    await putPage(engine, sourceId, `conversations/chat-${i}`, page('conversation', `chat ${i}`, `**User:** Notes on Forge part ${i}. By the way, the Forge offsite is booked in Santa Fe.\n\n**Assistant:** Noted.`, `date: 2025-07-0${i + 1}\n`));
  }
  await engine.insertFact({ fact: 'The Forge offsite is booked in Missoula.', kind: 'fact', entity_slug: 'forge', source: 'user correction, 2025-07-12', visibility: 'world', valid_from: new Date('2025-07-12T00:00:00Z') }, { source_id: sourceId });
  await engine.insertFact({ fact: 'The Forge offsite budget is a secret.', kind: 'fact', entity_slug: 'forge', source: 'private note', visibility: 'private', valid_from: new Date('2025-07-13T00:00:00Z') }, { source_id: sourceId });
}, 120_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

describe('facts arm', () => {
  test('query terms drop stopwords and short words', () => {
    expect(queryTerms(Q)).toEqual(['forge', 'offsite', 'booked']);
  });

  test('unset is on; false turns it off and leaves the page rows unchanged', async () => {
    await engine.executeRaw(`DELETE FROM config WHERE key = $1`, [QUERY_FACTS_ARM_KEY]);
    const unset = await query({ limit: 10 });
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false');
    const off = await query({ limit: 10 });
    expect(unset.some(r => r.result_type === 'fact')).toBe(true);
    expect(off.some(r => r.result_type === 'fact')).toBe(false);
    expect(JSON.stringify(unset.filter(r => r.result_type !== 'fact').map(r => [r.slug, r.chunk_text]))).toBe(JSON.stringify(off.map(r => [r.slug, r.chunk_text])));
  });

  test('on: the matching fact is a row of its own, newest first, in free slots after every page row', async () => {
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false');
    const off = await query({ limit: 10 });
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true');
    try {
      const on = await query({ limit: 10 });
      expect(on.length).toBeLessThanOrEqual(10);
      expect(on.slice(0, off.length).map(r => [r.slug, r.chunk_id])).toEqual(off.map(r => [r.slug, r.chunk_id]));
      const facts = on.filter(r => r.result_type === 'fact');
      expect(facts.map(r => r.chunk_text.match(/valid from (\S+?);/)![1])).toEqual(['2025-07-13', '2025-07-12']);
      expect(facts[1]!.chunk_text).toContain('Missoula');
      expect(facts[1]!.chunk_text).toContain('valid from 2025-07-12');
      expect(facts[0]!.chunk_text).toContain('secret');
    } finally { await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false'); }
  });

  test('on, no spare capacity: a full row count or a spent token budget returns the page rows unchanged', async () => {
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false');
    const full = await query();
    const budget = resultTokens(full[0]!);
    const spent = await query({ limit: 10, token_budget: budget });
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true');
    try {
      expect(full).toHaveLength(6);
      expect(JSON.stringify(await query())).toBe(JSON.stringify(full));
      expect(JSON.stringify(await query({ limit: 10, token_budget: budget }))).toBe(JSON.stringify(spent));
    } finally { await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false'); }
  });

  test('on, remote: a private fact never comes back; the world fact does', async () => {
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true');
    try {
      const text = await remote({});
      expect(text).toContain('Missoula');
      expect(text).not.toContain('secret');
      expect(await matchQueryFacts(engine, Q, { sourceIds: [sourceId], remote: true })).toHaveLength(1);
    } finally { await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false'); }
  });

  test('on, return_unit page: the fact row passes through as written and counts in the budget', async () => {
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true');
    try {
      const rows = await query({ return_unit: 'page', token_budget: 2000, limit: 10 }) as Array<SearchResult & { delivered?: { reason?: string } }>;
      const fact = rows.find(r => r.result_type === 'fact' && r.chunk_text.includes('Missoula'))!;
      expect(fact.delivered?.reason).toBe('saved_fact');
      expect(fact.chunk_text.startsWith('Saved fact')).toBe(true);
    } finally { await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false'); }
  });

  test('on, remote: a fact row is never page-shaped and never points at get_page; the entity page is named only when it exists', async () => {
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true');
    try {
      const factRows = async () => {
        const r = await dispatchToolCall(engine, 'query', { query: Q, expand: false, limit: 10, snippet_chars: 20 }, { remote: true, transport: 'stdio', sourceId,
          auth: { token: 't', clientId: 'facts-probe', scopes: ['read'], sourceId, allowedSources: [sourceId] }, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
        const text = r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
        return { text, rows: (JSON.parse((r.content[0] as { text: string }).text) as Array<Record<string, unknown>>).filter(row => row.result_type === 'fact') };
      };
      const before = await factRows();
      expect(before.rows.length).toBeGreaterThan(0);
      for (const row of before.rows) {
        expect(row).toMatchObject({ result_type: 'fact', fact_id: expect.stringMatching(/^\d+$/), follow_up: { op: 'recall', args: { entity: 'forge', source_id: sourceId } } });
        for (const key of ['slug', 'id', 'type', 'chunk_id', 'page_slug', 'fact_row']) expect(row).not.toHaveProperty(key);
        expect(String(row.chunk_text)).toContain(`recall {"entity":"forge","source_id":"${sourceId}"}`);
      }
      expect(before.text).not.toContain('get_page forge');
      expect(before.text).not.toContain('get_page facts/');
      await putPage(engine, sourceId, 'forge', page('company', 'Forge', 'Forge runs an annual offsite.'));
      const after = await factRows();
      for (const row of after.rows) expect(row.page_slug).toBe('forge');
    } finally { await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false'); }
  });

  test('on: a page whose typed claim a newer fact covers is stamped superseded_claim; untyped pages are not', async () => {
    const old = await engine.insertFact({ fact: 'Forge offsite city is Santa Fe', kind: 'fact', entity_slug: 'forge', source: 'extracted', visibility: 'world', valid_from: new Date('2025-07-01T00:00:00Z') }, { source_id: sourceId });
    await engine.executeRaw(`UPDATE facts SET source_markdown_slug = 'conversations/chat-0', claim_metric = 'offsite_city', expired_at = now() WHERE id = $1`, [old.id]);
    const newer = await engine.insertFact({ fact: 'The Forge offsite city is now Missoula, booked last week', kind: 'fact', entity_slug: 'forge', source: 'user correction', visibility: 'world', valid_from: new Date('2025-07-14T00:00:00Z') }, { source_id: sourceId });
    await engine.executeRaw(`UPDATE facts SET claim_metric = 'offsite_city' WHERE id = $1`, [newer.id]);
    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true');
    try {
      const rows = await query({ limit: 10 });
      const stamped = rows.filter(r => r.superseded_claim);
      expect(stamped.map(r => r.slug)).toEqual(['conversations/chat-0']);
      expect(stamped[0]!.superseded_claim!.fact_id).toBe(newer.id);
    } finally { await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false'); }
  });

  test('a fact whose source page is quarantined is never a facts-arm row, local or remote (#6284)', async () => {
    const lq = 'Where is the Lantern retreat held?';
    await putPage(engine, sourceId, 'notes/lantern-scrape', page('note', 'Lantern scrape', 'Scraped listing about the Lantern retreat venue and its rooms.'));
    const scraped = await engine.insertFact({ fact: 'The Lantern retreat is held in Boise.', kind: 'fact', entity_slug: 'lantern', source: 'extracted', visibility: 'world', valid_from: new Date('2025-08-01T00:00:00Z') }, { source_id: sourceId });
    await engine.executeRaw(`UPDATE facts SET source_markdown_slug = 'notes/lantern-scrape' WHERE id = $1`, [scraped.id]);
    const ids = async (remote: boolean) => (await matchQueryFacts(engine, lq, { sourceId, remote })).map(f => Number(f.id));
    expect(await ids(false)).toContain(Number(scraped.id));
    expect(await ids(true)).toContain(Number(scraped.id));
    await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"quarantine": {"reason": "junk_pattern", "detail": "test"}}'::jsonb
      WHERE source_id = $1 AND slug = 'notes/lantern-scrape'`, [sourceId]);
    expect(await ids(false)).not.toContain(Number(scraped.id));
    expect(await ids(true)).not.toContain(Number(scraped.id));
  });

  test('trust (#5575): a fact row carries its own tier; the floor and the rederive hold apply inside the arm', async () => {
    const tq = 'Where is the Quarry summit held?';
    const setTier = (id: number, tier: TrustTier) => engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed',
      () => tx.executeRaw('UPDATE facts SET trust_tier = $1 WHERE id = $2', [tier, id])));
    const curated = Number((await engine.insertFact({ fact: 'The Quarry summit is held in Tulsa.', kind: 'fact', entity_slug: 'quarry', source: 'owner note', visibility: 'world', valid_from: new Date('2025-09-01T00:00:00Z') }, { source_id: sourceId })).id);
    const external = Number((await engine.insertFact({ fact: 'The Quarry summit is held in Reno.', kind: 'fact', entity_slug: 'quarry', source: 'web page', visibility: 'world', valid_from: new Date('2025-09-02T00:00:00Z') }, { source_id: sourceId })).id);
    await setTier(curated, 'operator_curated');
    await setTier(external, 'external_untrusted');
    const ids = async (minTrust?: TrustTier) => (await matchQueryFacts(engine, tq, { sourceId, remote: false, minTrust })).map(f => Number(f.id));
    expect(await ids()).toEqual([external, curated]);
    expect(await ids('unknown')).toEqual([curated]);

    await engine.setConfig(QUERY_FACTS_ARM_KEY, 'true');
    try {
      const tiers = (rows: SearchResult[]) => Object.fromEntries(rows.filter(r => r.result_type === 'fact').map(r => [Number(r.fact_id), (r as { trust_tier?: string }).trust_tier]));
      expect(tiers(await query({ query: tq, limit: 10 }))).toEqual({ [curated]: 'operator_curated', [external]: 'external_untrusted' });
      expect(tiers(await query({ query: tq, limit: 10, min_trust: 'unknown' }))).toEqual({ [curated]: 'operator_curated' });

      await engine.executeRaw(`INSERT INTO needs_rederive (derived_table, derived_id, source_id, reason) VALUES ('facts', $1, $2, 'test')`, [String(curated), sourceId]);
      expect(await ids()).toEqual([external]);
      expect(tiers(await query({ query: tq, limit: 10 }))).toEqual({ [external]: 'external_untrusted' });
    } finally {
      await engine.setConfig(QUERY_FACTS_ARM_KEY, 'false');
      await engine.executeRaw(`DELETE FROM needs_rederive WHERE derived_table = 'facts' AND derived_id = $1`, [String(curated)]);
    }
  });
});
