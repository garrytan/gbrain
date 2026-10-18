/**
 * Temporal fact reserve for `query` (`search.temporal_fact_reserve`, default
 * off; gates in docs/eval/decisions/temporal-fact-reserve/): a query with a
 * temporal cue and a token budget gives question-ranked, dated-first facts up
 * to 15% of the budget, rendered with their date header and ordered oldest
 * first after the pages; the row count never grows. The budget is the
 * caller's token_budget or the one evidence delivery resolves (return_unit,
 * including the default auto). With the key off, without a cue or with no
 * budget at all (chunk unit, no token_budget), the result is byte-identical to
 * the build without the reserve. With #6020's defaults (date grounding on), a
 * fact whose valid_from the extractor grounded is ranked and rendered with that
 * date. PGLite, keyword-only, stub chat transport, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { MAX_RESERVE_ROWS, TEMPORAL_FACT_RESERVE_KEY, TEMPORAL_RESERVE_ROW_SHARE, TEMPORAL_RESERVE_SHARE, hasTemporalCue } from '../src/core/search/facts-arm.ts';
import { resultTokens } from '../src/core/search/token-budget.ts';
import type { SearchResult } from '../src/core/types.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { extractFactsFromTurnWithOutcome, getExtractorVariant } from '../src/core/facts/extract.ts';

let engine: PGLiteEngine;
let sourceId: string;
const TEMPORAL = 'When was the Forge offsite booked, and what happened after the venue changed?';
const PLAIN = 'Where is the Forge offsite booked?';
const query = async (q: string, params: Record<string, unknown> = {}) =>
  await handleToolCall(engine, 'query', { query: q, expand: false, use_cache: false, source_id: sourceId, limit: 6, ...params }) as SearchResult[];
const withKey = async <T>(value: string | null, run: () => Promise<T>): Promise<T> => {
  if (value === null) await engine.executeRaw('DELETE FROM config WHERE key = $1', [TEMPORAL_FACT_RESERVE_KEY]);
  else await engine.setConfig(TEMPORAL_FACT_RESERVE_KEY, value);
  try { return await run(); } finally { await engine.executeRaw('DELETE FROM config WHERE key = $1', [TEMPORAL_FACT_RESERVE_KEY]); }
};

/** Recency boosts read the wall clock, so scores move between calls; every other byte must match. */
const stable = (v: unknown) => JSON.stringify(v, (k, x) => (k === 'score' || k === 'recency_boost' ? undefined : x));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  for (let i = 0; i < 6; i++) {
    await putPage(engine, sourceId, `conversations/chat-${i}`, page('conversation', `chat ${i}`, `**User:** Notes on the Forge offsite part ${i}. The Forge offsite venue was booked and the venue changed once.\n\n**Assistant:** Noted.`, `date: 2025-07-0${i + 1}\n`));
  }
  await engine.insertFact({ fact: 'The Forge offsite venue was booked in Santa Fe.', kind: 'event', entity_slug: 'forge', source: 'conversation', visibility: 'world', valid_from: new Date('2025-06-02T00:00:00Z') }, { source_id: sourceId });
  await engine.insertFact({ fact: 'The Forge offsite venue changed to Missoula.', kind: 'event', entity_slug: 'forge', source: 'conversation', visibility: 'world', valid_from: new Date('2025-07-12T00:00:00Z') }, { source_id: sourceId });
  await engine.insertFact({ fact: 'The Forge offsite venue booking needs a deposit.', kind: 'fact', entity_slug: 'forge', source: 'conversation', visibility: 'world' }, { source_id: sourceId });
}, 120_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

describe('temporal fact reserve', () => {
  test('temporal cues are deterministic words, phrases, ISO dates and month names', () => {
    for (const q of [TEMPORAL, 'how long did the trip take', 'What did I do on 2025-03-04?', 'the first time we met', 'plans for March']) expect(hasTemporalCue(q)).toBe(true);
    for (const q of [PLAIN, 'Who leads the platform team?', 'list every vendor']) expect(hasTemporalCue(q)).toBe(false);
  });

  test('off (unset or false), a query without a cue, or a chunk-unit call without token_budget (no budget at all): byte-identical to the build without the reserve', async () => {
    const chunkNoBudget = { return_unit: 'chunk' };
    const unset = await withKey(null, async () => [await query(TEMPORAL, { token_budget: 4000 }), await query(PLAIN, { token_budget: 4000 }), await query(TEMPORAL, chunkNoBudget)]);
    const off = await withKey('false', async () => [await query(TEMPORAL, { token_budget: 4000 }), await query(PLAIN, { token_budget: 4000 }), await query(TEMPORAL, chunkNoBudget)]);
    const onNoCueNoBudget = await withKey('true', async () => [await query(PLAIN, { token_budget: 4000 }), await query(TEMPORAL, chunkNoBudget)]);
    expect(stable(off)).toBe(stable(unset));
    expect(stable(onNoCueNoBudget)).toBe(stable([unset[1], unset[2]]));
  });

  test('on, temporal cue and token budget: dated facts first, date headers, oldest first, inside 15% of the budget and 30% of the rows', async () => {
    const budget = 4000;
    const off = await withKey(null, () => query(TEMPORAL, { token_budget: budget, limit: 10 }));
    const on = await withKey('true', () => query(TEMPORAL, { token_budget: budget, limit: 10 }));
    const facts = on.filter(r => r.result_type === 'fact');
    expect(facts.length).toBeGreaterThanOrEqual(2);
    expect(facts.length).toBeLessThanOrEqual(Math.min(MAX_RESERVE_ROWS, Math.floor(10 * TEMPORAL_RESERVE_ROW_SHARE)));
    expect(on.length).toBeLessThanOrEqual(Math.max(off.length, 10));
    expect(facts.slice(0, 2).map(r => r.chunk_text.split('\n')[0])).toEqual(['[observed unknown; valid 2025-06-02 to unknown]', '[observed unknown; valid 2025-07-12 to unknown]']);
    expect(facts.reduce((n, r) => n + resultTokens(r), 0)).toBeLessThanOrEqual(Math.floor(budget * TEMPORAL_RESERVE_SHARE));
    expect(on.findIndex(r => r.result_type === 'fact')).toBe(on.length - facts.length);
  });

  test('on, return_unit page: reserved facts are delivered first in the budget with one date header each', async () => {
    await engine.setConfig('search.evidence_date_header', 'true');
    try {
      const rows = await withKey('true', () => query(TEMPORAL, { token_budget: 4000, return_unit: 'page', limit: 10 })) as Array<SearchResult & { delivered?: { reason?: string } }>;
      const facts = rows.filter(r => r.result_type === 'fact');
      expect(facts.length).toBeGreaterThanOrEqual(2);
      for (const f of facts) {
        expect(f.delivered?.reason).toBe('saved_fact');
        expect(f.chunk_text.match(/\[observed /g)?.length).toBe(1);
      }
    } finally { await engine.executeRaw(`DELETE FROM config WHERE key = 'search.evidence_date_header'`); }
  });

  test('with #6020 defaults, date grounding is on and a grounded valid_from is what the reserve ranks and renders', async () => {
    expect((await getExtractorVariant(engine)).dateGrounding).toBe(true);
    resetGateway();
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    const reply = JSON.stringify({ facts: [
      { fact: 'The Kestrel launch review was moved to the Denver office', kind: 'event', notability: 'high', entity: 'kestrel', valid_from: '2025-04-22' },
      { fact: 'The Kestrel launch review needs a projector', kind: 'fact', notability: 'high', entity: 'kestrel' },
    ] });
    __setChatTransportForTests(async () => ({ text: reply, blocks: [{ type: 'text', text: reply }], stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }) as ChatResult);
    try {
      const outcome = await extractFactsFromTurnWithOutcome({ turnText: 'User (2025-04-23): we moved the Kestrel launch review to Denver yesterday; it needs a projector.',
        source: 'conversation', variant: await getExtractorVariant(engine), observationDate: { date: '2025-04-23', source: 'filename' }, embedding: null });
      expect(outcome.ok).toBe(true);
      const facts = outcome.ok ? outcome.facts : [];
      expect(facts[0]!.valid_from?.toISOString()).toBe('2025-04-22T00:00:00.000Z');
      for (const f of facts) await engine.insertFact({ fact: f.fact, kind: f.kind, entity_slug: 'kestrel', source: 'conversation', visibility: 'world', ...(f.valid_from ? { valid_from: f.valid_from } : {}) }, { source_id: sourceId });
    } finally {
      __setChatTransportForTests(null);
      resetGateway();
    }
    const rows = await withKey('true', () => query('When was the Kestrel launch review moved?', { token_budget: 4000, limit: 10 }));
    const kestrel = rows.filter(r => r.result_type === 'fact' && r.chunk_text.includes('Kestrel'));
    expect(kestrel[0]!.chunk_text.split('\n')[0]).toBe('[observed unknown; valid 2025-04-22 to unknown]');
    expect(kestrel[0]!.chunk_text).toContain('moved to the Denver office');
  });
});
