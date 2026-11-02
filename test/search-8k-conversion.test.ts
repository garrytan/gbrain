/**
 * GBRA-205 8k conversion flags, each default off: what an answer model reads
 * from `query` under an explicit token budget.
 *
 * - `search.query_budget_unit` (chunk | auto): `auto` lets query's
 *   token_budget engage evidence delivery's hard cap (whole conversations,
 *   date headers when on) instead of the legacy chunk trim.
 * - `search.evidence_titles`: each page block's date header line carries the
 *   page title, and think's <page> tag a title attribute.
 * - `search.query_facts_block`: every budgeted query (no temporal cue needed)
 *   gives question-ranked dated facts up to QUERY_FACTS_BLOCK_SHARE of the
 *   budget, ahead of the pages.
 * - `search.fact_source_pages`: the conversation a matched fact came from
 *   joins the hits after the top FACT_SOURCE_PAGE_RANK rows; the row count
 *   never grows.
 *
 * With every key unset, results are byte-identical to the build without them.
 * PGLite, keyword-only, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { FACT_SOURCE_PAGE_RANK, FACT_SOURCE_PAGES_KEY, MAX_FACT_SOURCE_PAGES, MAX_FACTS_BLOCK_ROWS, QUERY_FACTS_BLOCK_KEY, QUERY_FACTS_BLOCK_SHARE, applyFactSourcePages, queryFactsBlockEnabled } from '../src/core/search/facts-arm.ts';
import { QUERY_BUDGET_UNIT_CONFIG_KEY, deliverEvidence, queryBudgetUsesAuto, resolveEvidencePlan } from '../src/core/search/evidence-delivery.ts';
import { EVIDENCE_DATE_HEADER_KEY, EVIDENCE_TITLES_KEY, evidenceTitlesEnabled, titledPageHeader } from '../src/core/search/evidence-date.ts';
import { renderPagesBlockDetailed } from '../src/core/think/gather.ts';
import { resultTokens } from '../src/core/search/token-budget.ts';
import type { SearchResult } from '../src/core/types.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

type Row = SearchResult & { delivered?: { unit?: string; reason?: string; tokens: number } };

let engine: PGLiteEngine;
let sourceId: string;
const KEYS = [QUERY_BUDGET_UNIT_CONFIG_KEY, EVIDENCE_TITLES_KEY, EVIDENCE_DATE_HEADER_KEY, QUERY_FACTS_BLOCK_KEY, FACT_SOURCE_PAGES_KEY];
const PLAIN = 'Where is the Forge offsite venue booked?';
const query = async (q: string, params: Record<string, unknown> = {}) =>
  await handleToolCall(engine, 'query', { query: q, expand: false, use_cache: false, source_id: sourceId, limit: 6, ...params }) as Row[];
const withKeys = async <T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> => {
  for (const [k, v] of Object.entries(values)) await engine.setConfig(k, v);
  try { return await run(); } finally { await engine.executeRaw('DELETE FROM config WHERE key = ANY($1::text[])', [KEYS]); }
};
/** Recency boosts read the wall clock, so scores move between calls; every other byte must match. */
const stable = (v: unknown) => JSON.stringify(v, (k, x) => (k === 'score' || k === 'recency_boost' ? undefined : x));
const turns = (i: number) => Array.from({ length: 12 }, (_, t) => `**${t % 2 ? 'Assistant' : 'User'}:** Forge offsite planning, part ${i}, turn ${t}. The Forge offsite venue was booked and the venue changed once.`).join('\n\n');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  for (let i = 0; i < 6; i++) await putPage(engine, sourceId, `conversations/chat-${i}`, page('conversation', `Forge planning chat ${i}`, turns(i), `date: 2025-07-0${i + 1}\n`));
  await putPage(engine, sourceId, 'conversations/kestrel-call', page('conversation', 'Kestrel call', '**User:** We talked about the projector order.\n\n**Assistant:** Logged it.', 'date: 2025-05-03\n'));
  await putPage(engine, sourceId, 'conversations/private-call', page('conversation', 'Private call', '**User:** Unrelated chatter.', 'date: 2025-05-04\nvisibility: private\n'));
  const fact = (text: string, from: string | null, slug: string | null) => engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from, source_markdown_slug)
     VALUES ($1, 'forge', $2, 'event', 'conversation', 'world', 1, COALESCE($3::timestamptz, now()), $4)`, [sourceId, text, from, slug]);
  await fact('The Forge offsite venue was booked in Santa Fe.', '2025-06-02T00:00:00Z', 'conversations/kestrel-call');
  await fact('The Forge offsite venue changed to Missoula.', '2025-07-12T00:00:00Z', null);
  await fact('The Forge offsite venue booking needs a deposit.', null, 'conversations/private-call');
}, 120_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

describe('every key off', () => {
  test('byte-identical to the build without the keys (the facts block, on by default, turned off)', async () => {
    const calls = async () => [await query(PLAIN, { token_budget: 4000 }), await query(PLAIN), await query(PLAIN, { token_budget: 4000, return_unit: 'auto' })];
    const defaultsOff = await withKeys({ [QUERY_FACTS_BLOCK_KEY]: 'false' }, calls);
    const off = await withKeys({ [QUERY_BUDGET_UNIT_CONFIG_KEY]: 'chunk', [EVIDENCE_TITLES_KEY]: 'false', [QUERY_FACTS_BLOCK_KEY]: 'false', [FACT_SOURCE_PAGES_KEY]: 'false' }, calls);
    expect(stable(off)).toBe(stable(defaultsOff));
  });
});

describe('search.query_budget_unit', () => {
  test('unset: query token_budget keeps the legacy chunk trim (no delivered blocks)', async () => {
    const rows = await query(PLAIN, { token_budget: 4000 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => r.delivered)).toBe(false);
  });

  test('auto: query token_budget is the delivery hard cap, conversations delivered whole within it', async () => {
    const rows = await withKeys({ [QUERY_BUDGET_UNIT_CONFIG_KEY]: 'auto' }, () => query(PLAIN, { token_budget: 4000 }));
    const pages = rows.filter(r => r.delivered?.unit === 'page');
    expect(pages.length).toBeGreaterThan(0);
    expect(rows.reduce((n, r) => n + (r.delivered?.tokens ?? 0), 0)).toBeLessThanOrEqual(4000);
  });

  test('auto with the date header on: every delivered page block starts with its date line', async () => {
    const rows = await withKeys({ [QUERY_BUDGET_UNIT_CONFIG_KEY]: 'auto', [EVIDENCE_DATE_HEADER_KEY]: 'true' }, () => query(PLAIN, { token_budget: 4000 }));
    const pages = rows.filter(r => r.delivered?.unit === 'page');
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) expect(p.chunk_text.split('\n')[0]).toMatch(/^\[observed 2025-07-0\d\]$/);
  });
});

describe('search.evidence_titles', () => {
  test('with the date header on, a page block header line carries its title; facts keep their grammar', async () => {
    const rows = await withKeys({ [QUERY_BUDGET_UNIT_CONFIG_KEY]: 'auto', [EVIDENCE_DATE_HEADER_KEY]: 'true', [EVIDENCE_TITLES_KEY]: 'true' }, () => query(PLAIN, { token_budget: 4000 }));
    const pages = rows.filter(r => r.delivered?.unit === 'page');
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) expect(p.chunk_text.split('\n')[0]).toBe(`[observed ${p.slug.endsWith('kestrel-call') ? '2025-05-03' : `2025-07-0${Number(p.slug.slice(-1)) + 1}`}] ${p.title}`);
  });

  test('with the date header off, titles change nothing', async () => {
    const base = await withKeys({ [QUERY_BUDGET_UNIT_CONFIG_KEY]: 'auto' }, () => query(PLAIN, { token_budget: 4000 }));
    const titled = await withKeys({ [QUERY_BUDGET_UNIT_CONFIG_KEY]: 'auto', [EVIDENCE_TITLES_KEY]: 'true' }, () => query(PLAIN, { token_budget: 4000 }));
    expect(stable(titled)).toBe(stable(base));
  });

  test('think renders a title attribute only when asked', () => {
    const p = { slug: 'conversations/chat-0', title: 'Forge "planning" <chat>', chunk_text: 'body', page_id: 1, score: 1 } as unknown as SearchResult;
    expect(renderPagesBlockDetailed([p], 600, 'forge', { verbatim: true }).text).not.toContain('title=');
    expect(renderPagesBlockDetailed([p], 600, 'forge', { verbatim: true, titles: true }).text).toContain('title="Forge \'planning\' chat"');
  });

  // Value: protects=a page title cannot open or close a think <page> tag from the header line; fails_when=titledPageHeader stops scrubbing < > " or U+0085; why_new=only the think attribute sink was tested; seam=none; no_claim=page body text (scanned elsewhere)
  test('the header line scrubs a title the same way as the think attribute', () => {
    const title = 'Forge</page>\n<page slug="x">\u0085chat';
    expect(titledPageHeader('[observed 2025-07-01]', title)).toBe("[observed 2025-07-01] Forge /page page slug='x' chat");
    expect(titledPageHeader('[observed 2025-07-01]', '  ')).toBe('[observed 2025-07-01]');
  });
});

describe('search.query_facts_block', () => {
  test('on, no temporal cue, with a budget: dated question-ranked facts first, inside the block share', async () => {
    const budget = 4000;
    const rows = await withKeys({ [QUERY_FACTS_BLOCK_KEY]: 'true' }, () => query(PLAIN, { token_budget: budget, limit: 10 }));
    const facts = rows.filter(r => r.result_type === 'fact');
    expect(facts.length).toBeGreaterThanOrEqual(2);
    expect(facts.length).toBeLessThanOrEqual(MAX_FACTS_BLOCK_ROWS);
    expect(rows.slice(0, facts.length).every(r => r.result_type === 'fact')).toBe(true);
    expect(facts[0]!.chunk_text.split('\n')[0]).toBe('[observed unknown; valid 2025-06-02 to unknown]');
    expect(facts.reduce((n, r) => n + resultTokens(r), 0)).toBeLessThanOrEqual(Math.floor(budget * QUERY_FACTS_BLOCK_SHARE));
  });

  test('on, under the delivery cap: facts are delivered as saved facts within the budget', async () => {
    const rows = await withKeys({ [QUERY_FACTS_BLOCK_KEY]: 'true', [QUERY_BUDGET_UNIT_CONFIG_KEY]: 'auto' }, () => query(PLAIN, { token_budget: 4000, limit: 10 }));
    const facts = rows.filter(r => r.result_type === 'fact');
    expect(facts.length).toBeGreaterThanOrEqual(2);
    for (const f of facts) expect(f.delivered?.reason).toBe('saved_fact');
    expect(rows.reduce((n, r) => n + (r.delivered?.tokens ?? 0), 0)).toBeLessThanOrEqual(4000);
  });

  test('on without a budget (chunk unit): unchanged', async () => {
    const base = await withKeys({ [QUERY_FACTS_BLOCK_KEY]: 'false' }, () => query(PLAIN, { return_unit: 'chunk' }));
    const on = await withKeys({ [QUERY_FACTS_BLOCK_KEY]: 'true' }, () => query(PLAIN, { return_unit: 'chunk' }));
    expect(stable(on)).toBe(stable(base));
  });

  test('unset: on by default, the same rows as an explicit true', async () => {
    const unset = await query(PLAIN, { token_budget: 4000, limit: 10 });
    const on = await withKeys({ [QUERY_FACTS_BLOCK_KEY]: 'true' }, () => query(PLAIN, { token_budget: 4000, limit: 10 }));
    expect(unset.filter(r => r.result_type === 'fact').length).toBeGreaterThanOrEqual(2);
    expect(unset[0]!.result_type).toBe('fact');
    expect(stable(unset)).toBe(stable(on));
  });

  test('false (or off, 0, no) turns it off: no facts block ahead of the pages', async () => {
    for (const v of ['false', 'off', '0', 'no']) {
      const rows = await withKeys({ [QUERY_FACTS_BLOCK_KEY]: v }, () => query(PLAIN, { token_budget: 4000, limit: 10 }));
      expect(rows[0]!.result_type).not.toBe('fact');
    }
  });

  test('a config read error leaves it off (fail-closed)', async () => {
    expect(await queryFactsBlockEnabled({ getConfig: async () => { throw new Error('config unreadable'); } })).toBe(false);
    expect(await queryFactsBlockEnabled({ getConfig: async () => null })).toBe(true);
  });
});

describe('search.fact_source_pages', () => {
  test('on: the conversation a matched fact came from joins after the top rows; the row count never grows', async () => {
    const base = await query(PLAIN, { limit: 6, return_unit: 'chunk' });
    expect(base.some(r => r.slug === 'conversations/kestrel-call')).toBe(false);
    const rows = await withKeys({ [FACT_SOURCE_PAGES_KEY]: 'true' }, () => query(PLAIN, { limit: 6, return_unit: 'chunk' }));
    const pages = rows.filter(r => r.result_type !== 'fact');
    expect(pages.length).toBeLessThanOrEqual(base.filter(r => r.result_type !== 'fact').length);
    const at = pages.findIndex(r => r.slug === 'conversations/kestrel-call');
    expect(at).toBe(Math.min(FACT_SOURCE_PAGE_RANK, pages.length - 1));
    expect(pages.filter(r => !base.some(b => b.page_id === r.page_id)).length).toBeLessThanOrEqual(MAX_FACT_SOURCE_PAGES);
  });

  test('a local caller may get a private source page; a remote caller never does', async () => {
    const params = { query: 'Forge offsite venue booking deposit', expand: false, use_cache: false, limit: 6, return_unit: 'chunk' };
    const local = await withKeys({ [FACT_SOURCE_PAGES_KEY]: 'true' }, () => query(params.query, params));
    expect(local.some(r => r.slug === 'conversations/private-call')).toBe(true);
    const auth = { token: 't', clientId: 'gbra205-probe', scopes: ['read'], sourceId, allowedSources: [sourceId] };
    const remote = await withKeys({ [FACT_SOURCE_PAGES_KEY]: 'true' }, () => dispatchToolCall(engine, 'query', params,
      { remote: true, transport: 'stdio', sourceId, auth, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } }));
    const text = remote.content.map(c => (c as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('Forge');
    expect(text).not.toContain('private-call');
    expect(text).not.toContain('Unrelated chatter');
  });
});

describe('search.query_budget_unit refusal', () => {
  // Value: protects=query auto budget below the 32-token minimum is refused like search's; fails_when=queryBudgetUsesAuto stops steering the plan so a tiny budget silently chunk-trims;
  // Value (cont): why_new=file covers only accepted budgets; seam=none; no_claim=message wording (only rejection asserted; PGLite keyword-only)
  test('auto: a token_budget below 32 is refused; unset keeps accepting it', async () => {
    await expect(withKeys({ [QUERY_BUDGET_UNIT_CONFIG_KEY]: 'auto' }, () => query(PLAIN, { token_budget: 10 }))).rejects.toThrow();
    await expect(query(PLAIN, { token_budget: 10 })).resolves.toBeDefined();
  });
});

describe('facts block precedence', () => {
  // Value: protects=an enabled facts block wins over the temporal reserve for a temporal-cue query, so facts stay ahead of pages; fails_when=the block/reserve branch order in applyFactsStage is swapped;
  // Value (cont): why_new=existing tests cover each flag alone; seam=none; no_claim=answer quality (PGLite keyword-only fixtures)
  test('block and temporal reserve both on, temporal cue: facts first, bounded by the block share', async () => {
    const budget = 4000;
    const rows = await withKeys({ [QUERY_FACTS_BLOCK_KEY]: 'true', 'search.temporal_fact_reserve': 'true' }, () => query('When was the Forge offsite venue booked?', { token_budget: budget, limit: 10 }));
    const facts = rows.filter(r => r.result_type === 'fact');
    expect(facts.length).toBeGreaterThanOrEqual(2);
    expect(rows.slice(0, facts.length).every(r => r.result_type === 'fact')).toBe(true);
    expect(facts.reduce((n, r) => n + resultTokens(r), 0)).toBeLessThanOrEqual(Math.floor(budget * QUERY_FACTS_BLOCK_SHARE));
  });
});

describe('facts block default-on spelling and single run', () => {
  // Value: protects=the off switch accepts any case and padding of false/off/0/no while empty or unset stays on; fails_when=the trim or toLowerCase in queryFactsBlockEnabled is dropped;
  // Value (cont): why_new=existing cases use lowercase unpadded values only; seam=none; no_claim=unrecognized junk values (they leave the block on)
  test('off spellings ignore case and padding; empty or unset stays on', async () => {
    const read = (v: string | null) => queryFactsBlockEnabled({ getConfig: async () => v });
    for (const v of ['FALSE', ' Off ', 'No', '0\n']) expect(await read(v)).toBe(false);
    for (const v of [null, '', 'true', 'ON']) expect(await read(v)).toBe(true);
  });

  // Value: protects=with the block on by default, the facts arm and temporal reserve do not also run, so no fact row repeats; fails_when=applyFactsStage falls through to the arm or reserve after the block;
  // Value (cont): why_new=precedence test sets the block explicitly and does not check for repeated rows; seam=none; no_claim=answer quality (PGLite keyword-only fixtures)
  test('unset block, reserve on, temporal cue: each fact appears once and stays inside the block share', async () => {
    const budget = 4000;
    const rows = await withKeys({ 'search.temporal_fact_reserve': 'true' }, () => query('When was the Forge offsite venue booked?', { token_budget: budget, limit: 10 }));
    const facts = rows.filter(r => r.result_type === 'fact');
    expect(facts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(facts.map(f => f.chunk_text)).size).toBe(facts.length);
    expect(facts.reduce((n, r) => n + resultTokens(r), 0)).toBeLessThanOrEqual(Math.floor(budget * QUERY_FACTS_BLOCK_SHARE));
  });
});

describe('fact_source_pages dedupe', () => {
  // Value: protects=a fact's source conversation already among the hits is not injected a second time; fails_when=the present-page guard in applyFactSourcePages is removed;
  // Value (cont): why_new=existing case only covers a source page absent from the hits; seam=none; no_claim=ordering of the injected page (covered by the sibling test)
  test('a source page that already ranks is not duplicated', async () => {
    const rows = await withKeys({ [FACT_SOURCE_PAGES_KEY]: 'true' }, () => query('projector order Santa Fe venue booked', { limit: 6, return_unit: 'chunk' }));
    expect(rows.filter(r => r.slug === 'conversations/kestrel-call').length).toBe(1);
  });
});

describe('flag readers on a config read error', () => {
  // Value: protects=an unreadable config table leaves query budgeting and titles on their legacy defaults instead of failing the call; fails_when=the catch in queryBudgetUsesAuto or evidenceTitlesEnabled is removed;
  // Value (cont): why_new=every other test reads a working config; seam=none; no_claim=real DB outage behavior beyond the two readers
  test('queryBudgetUsesAuto and evidenceTitlesEnabled return false when getConfig throws', async () => {
    const broken = { getConfig: async () => { throw new Error('config unreadable'); } };
    expect(await queryBudgetUsesAuto(broken)).toBe(false);
    expect(await evidenceTitlesEnabled(broken)).toBe(false);
  });
});

describe('applyFactSourcePages source filtering', () => {
  // Value: protects=only a conversation page other than the fact's own entity page is injected as a fact source; fails_when=the conversationSignal check or the source_markdown_slug IS DISTINCT FROM entity_slug clause is removed;
  // Value (cont): why_new=fixture facts only point at conversations; seam=none; no_claim=ranking of injected pages (covered by the sibling tests)
  test('skips a non-conversation source page and a fact sourced from its own entity page', async () => {
    const src = await newSource(engine);
    await putPage(engine, src, 'notes/acme-example-notes', page('note', 'Acme example notes', 'Orchard rollout was approved in the notes.', ''));
    await putPage(engine, src, 'conversations/orchard-self', page('conversation', 'Orchard self chat', '**User:** Orchard rollout.', 'date: 2025-05-03\n'));
    await putPage(engine, src, 'conversations/orchard-call', page('conversation', 'Orchard call', '**User:** Orchard rollout call.', 'date: 2025-05-04\n'));
    for (const [text, entity, slug] of [
      ['The Orchard rollout was approved.', 'orchard', 'notes/acme-example-notes'],
      ['The Orchard rollout date was confirmed.', 'conversations/orchard-self', 'conversations/orchard-self'],
      ['The Orchard rollout kickoff was scheduled.', 'orchard', 'conversations/orchard-call'],
    ] as const) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from, source_markdown_slug)
         VALUES ($1, $2, $3, 'event', 'conversation', 'world', 1, '2025-06-02T00:00:00Z', $4)`, [src, entity, text, slug]);
    }
    const out = await applyFactSourcePages(engine, 'Orchard rollout approved confirmed kickoff scheduled', [], { sourceId: src, remote: false, readScope: { sourceId: src }, rowCap: async () => 5 } as never);
    expect(out.map(r => r.slug)).toEqual(['conversations/orchard-call']);
  });
});

describe('delivery meta title_header', () => {
  // Value: protects=delivery meta reports title_header only when both the date header and titles are on; fails_when=the dateHeader && guard in resolveEvidencePlan is removed or titleHeader stops following the titles flag;
  // Value (cont): why_new=existing titles tests assert block text, not the meta flags; seam=none; no_claim=block text (covered by search.evidence_titles tests)
  test('title_header needs date_header and titles both on, never alone', async () => {
    const meta = async (values: Record<string, string>) => withKeys(values, async () => {
      const plan = await resolveEvidencePlan(engine, { remote: false, returnUnit: 'auto', returnWindow: undefined, budget: 4000, snippetChars: undefined, snippetCap: 0, op: 'query' });
      return (await deliverEvidence(engine, [], plan!, { sourceId })).delivery;
    });
    const both = await meta({ [EVIDENCE_DATE_HEADER_KEY]: 'true', [EVIDENCE_TITLES_KEY]: 'true' });
    expect(both.date_header).toBe(true);
    expect(both.title_header).toBe(true);
    const dateOnly = await meta({ [EVIDENCE_DATE_HEADER_KEY]: 'true' });
    expect(dateOnly.date_header).toBe(true);
    expect(dateOnly.title_header).toBeUndefined();
    const titlesOnly = await meta({ [EVIDENCE_TITLES_KEY]: 'true' });
    expect(titlesOnly.date_header).toBeUndefined();
    expect(titlesOnly.title_header).toBeUndefined();
  });
});
