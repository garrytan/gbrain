/**
 * LIVE (opt-in, keyed): the TypeSafe System One wire the unit tests pin with
 * fixture transports. Runs the key-only probe shape and one packed request
 * carrying all three question types, and checks the resolved model.
 *
 * Skips unless GBRAIN_LIVE_TYPESAFE=1 and TYPESAFE_API_KEY (or
 * JEV_TYPESAFE_API_KEY) are set, so the default `bun test` never calls the
 * provider (the unit preload also strips provider keys unless
 * GBRAIN_TEST_KEEP_PROVIDER_KEYS=1). Cost: well under $0.001 per run.
 *   GBRAIN_TEST_KEEP_PROVIDER_KEYS=1 GBRAIN_LIVE_TYPESAFE=1 TYPESAFE_API_KEY=... bun test test/live/decide-typesafe.live.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway, rerank } from '../../src/core/ai/gateway.ts';
import { readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { runDecide } from '../../src/core/ai/decide/index.ts';
import type { DecideQuestion } from '../../src/core/ai/decide/types.ts';

const KEY = process.env.TYPESAFE_API_KEY || process.env.JEV_TYPESAFE_API_KEY;
const live = process.env.GBRAIN_LIVE_TYPESAFE === '1' && !!KEY;

beforeAll(() => { if (live) configureGateway({ env: { TYPESAFE_API_KEY: KEY } }); });
afterAll(() => { if (live) resetGateway(); });

describe.skipIf(!live)('TypeSafe System One (live)', () => {
  test('one packed request answers noul, choice and score from the pinned model', async () => {
    const questions: DecideQuestion[] = [
      { id: 'n', kind: 'noul', rank: 0, instructions: 'Does `candidate` contain evidence that helps answer `query`?', inputs: { candidate: { text: 'The launch moved to May 3.', class: 'candidates', slug: 'live/a', source_id: 'default' } } },
      { id: 'c', kind: 'choice', rank: 1, instructions: 'What does `query` ask about?', options: { time: 'a date or time', person: 'a person', other: 'anything else' } },
      { id: 's', kind: 'score', rank: 2, instructions: 'Score `candidate` as evidence answering `query`.', levels: ['none', 'topic only', 'partial', 'direct'], inputs: { candidate: { text: 'We had lunch.', class: 'candidates', slug: 'live/b', source_id: 'default' } } },
    ];
    const cfg = readDecideConfig({ 'decide.provider': 'typesafe:jev-1.13.0', 'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow', 'decide.egress.private': 'allow' });
    const r = await runDecide({ slot: 'evidence', callSite: 'live', state: { query: { text: 'When is the launch?', class: 'query' } }, questions, deadlineMs: 15_000, lane: 'background' }, { engine: null, config: cfg });
    expect(r.model_resolved).toBe('jev-1.13.0');
    expect(r.answers.n).toMatchObject({ kind: 'noul' });
    expect((r.answers.n as { p: number }).p).toBeGreaterThan(0.5);
    expect(r.answers.c).toMatchObject({ kind: 'choice', choice: 'time' });
    expect(r.answers.s).toMatchObject({ kind: 'score' });
    expect(r.usage.input_tokens).toBeGreaterThan(0);
    expect(r.cost_usd).toBeLessThan(0.001);
  }, 30_000);

  test('the System One reranker returns normalized scores and the resolved model', async () => {
    let resolved = '';
    const out = await rerank({ model: 'typesafe:jev-1.13.0', query: 'When is the launch?', documents: ['We had lunch.', 'The launch moved to May 3.'], onMeta: (m) => { resolved = m.model_resolved; } });
    expect(resolved).toBe('jev-1.13.0');
    expect(out[0]!.index).toBe(1);
    expect(out.every((r) => r.relevanceScore >= 0 && r.relevanceScore <= 1)).toBe(true);
  }, 30_000);
});
