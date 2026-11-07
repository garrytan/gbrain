/**
 * GST-1304 (HARN-31): with embeddings off, recall's question ranking scored facts on the question's first 12 distinct
 * content words. A provider question that opens with a long instruction preamble filled those 12 slots with preamble
 * words no fact holds, so no fact cleared the term-share floor and the agent got 0 facts. A question over 12 content
 * terms now ranks on the ones the readable facts hold, rarest first; and a 0 because candidates fell under the floor is
 * stamped (facts_below_floor), apart from a store with nothing to match.
 *
 * 1. Protects: a preamble-led long question finds the fact its tail asks about; a short question is unchanged; the
 *    below-floor stamp appears only when candidates were found and none was admitted.
 * 2. Fails when: term selection goes back to the first 12 words, or the stamp disappears or fires on an empty match.
 * 3. Existing coverage: test/fact-relevance.test.ts (scoring), test/recall-question.test.ts (short questions).
 * 4. Real seams: PGLite, MCP dispatch as a remote caller, keyless gateway; no providers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { queryTerms } from '../src/core/search/fact-relevance.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

const TARGET = 'The team offsite is in Lisbon; alice-example booked the venue.';
const NOISE = 'The user prefers concise answers.';
const PREAMBLE = 'You are a memory assistant embedded in a chat product. Read the conversation excerpt below carefully and '
  + 'return only the saved notes that help answer the latest message. Ignore greetings, small talk, signatures and '
  + 'formatting instructions. Never invent information, never summarise the excerpt itself, and keep answers concise for '
  + 'the user. Prioritise durable preferences, plans, decisions, commitments and relationships. Conversation excerpt '
  + 'follows, oldest turn first, newest turn last, separated by blank lines. ';
const ASK = 'Latest message: where is the team offsite, and who booked the Lisbon venue?';

describe('recall question with a preamble (pglite, keyless)', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    configureGateway({ env: {} });
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    for (const fact of [TARGET, NOISE, 'Dark roast coffee every morning.', 'The quarterly review moved to Thursday.']) {
      await engine.insertFact({ fact, kind: 'event', entity_slug: null, source: 'test', visibility: 'world' } as never, { source_id: 'default' });
    }
  }, 120_000);
  afterAll(async () => { resetGateway(); await engine.disconnect(); });

  const recall = async (question: string) => {
    const auth = { token: 't', clientId: 'c', scopes: ['read'], sourceId: 'default' } as unknown as AuthInfo;
    const out = await dispatchToolCall(engine, 'recall', { question, caller: 'provider' }, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
    let json: Record<string, any> = {};
    try { json = JSON.parse(out.content[0]?.text ?? ''); } catch { /* not JSON */ }
    return { isError: out.isError === true, json };
  };
  const facts = (json: Record<string, any>) => (json.facts ?? []).map((f: { fact: string }) => [TARGET, NOISE].find(t => f.fact.includes(t)) ?? f.fact);

  test('a preamble-led question finds the fact its last message asks about', async () => {
    const question = PREAMBLE + ASK;
    expect(queryTerms(question).some(t => TARGET.toLowerCase().includes(t))).toBe(false);
    const { isError, json } = await recall(question);
    expect(isError).toBe(false);
    expect(facts(json)[0]).toBe(TARGET);
    expect(json.facts_below_floor).toBeUndefined();
  });

  test('the same ask without the preamble still finds it', async () => {
    expect(facts((await recall(ASK)).json)[0]).toBe(TARGET);
  });

  test('candidates under the floor are stamped; a question nothing matches is not', async () => {
    const under = await recall('lisbon weather forecast tomorrow morning'); // the Lisbon fact and the morning coffee fact, each 1 of 4 terms
    expect(facts(under.json)).toEqual([]);
    expect(under.json.facts_below_floor).toBe(2);
    const none = await recall('kayak paddle rental');
    expect(facts(none.json)).toEqual([]);
    expect(none.json.facts_below_floor).toBeUndefined();
  });
});
