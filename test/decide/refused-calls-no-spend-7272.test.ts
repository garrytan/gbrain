/**
 * #7272 — a TypeSafe call the provider refuses with a 4xx (402 billing_error,
 * 401/403 auth, 400/404 model) never ran, so it is not decide spend.
 *
 * Before the fix every failed batch was charged its estimated input tokens, so
 * a provider refusing every call for lack of credits filled the daily budget
 * with calls that never ran: `decide status` and doctor then reported
 * "budget exhausted" and every slot stopped with `budget_exhausted` instead of
 * the provider's `provider_error`. A refused call still leaves a `failed` row
 * (the error rate stays visible) at $0. A 429 and a 5xx or transport failure
 * keep their existing charge.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { runDecide } from '../../src/core/ai/decide/index.ts';
import { dailySpend, flushDecideWrites, __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import type { DecideQuestion, EvidenceItem } from '../../src/core/ai/decide/types.ts';

let engine: PGLiteEngine;

const PROVIDER = 'typesafe:jev-1.13.0';
const cand = (slug: string): EvidenceItem => ({ text: `text of ${slug}`, class: 'candidates', slug, source_id: 'default' });
const q = (id: string): DecideQuestion => ({ id, kind: 'noul', instructions: 'Is `c` evidence?', inputs: { c: cand('notes/world') } });
const CONSENT = {
  'decide.provider': PROVIDER,
  'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow',
  'decide.egress.typesafe.facts': 'allow', 'decide.egress.typesafe.conversation': 'allow',
};
const STATE = { query: { text: 'q', class: 'query' as const } };

function respondWith(status: number, body: unknown) {
  let calls = 0;
  __setDecideTransportForTests(async () => {
    calls++;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return () => calls;
}

async function spendRows() {
  await flushDecideWrites();
  return engine.executeRaw<{ outcome: string; cost_usd: number }>('SELECT outcome, cost_usd FROM decide_spend ORDER BY created_at');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setDecideTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetDecideStoreForTests();
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test' } });
  const r = await importFromContent(engine, 'notes/world', serializeMarkdown({}, 'body of notes/world', '', { type: 'note', title: 'notes/world', tags: [] }), { noEmbed: true, forceRechunk: true });
  expect(r.status).toBe('imported');
});

describe('#7272: a provider-refused decide call is not spend', () => {
  test.each([402, 401, 403, 400, 404])('HTTP %d leaves a $0 failed row and no daily spend', async (status) => {
    respondWith(status, { error: { type: 'billing_error', message: 'no credits' } });
    await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w')] }, { engine, config: readDecideConfig(CONSENT) }))
      .rejects.toMatchObject({ status });
    const rows = await spendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('failed');
    expect(Number(rows[0]!.cost_usd)).toBe(0);
    expect((await dailySpend(engine)).total).toBe(0);
  });

  test('repeated 402 refusals never exhaust the daily budget: the next call still reports the provider error', async () => {
    // One batch here is estimated at about $0.00009, so on the old charge two refusals filled this budget.
    const calls = respondWith(402, { error: { type: 'billing_error', message: 'no credits' } });
    const config = readDecideConfig({ ...CONSENT, 'decide.budget.daily_usd': '0.0002' });
    for (let i = 0; i < 5; i++) {
      await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q(`w${i}`)] }, { engine, config }))
        .rejects.toMatchObject({ reason: 'provider_error', status: 402 });
      await flushDecideWrites();
    }
    expect(calls()).toBe(5);
    expect((await dailySpend(engine)).total).toBe(0);
  });

  test('a 5xx keeps its estimated charge (the provider may have run it)', async () => {
    respondWith(500, { error: 'internal' });
    await expect(runDecide({ slot: 'evidence', callSite: 'search', state: STATE, questions: [q('w')] }, { engine, config: readDecideConfig(CONSENT) }))
      .rejects.toMatchObject({ reason: 'provider_error', status: 500 });
    const rows = await spendRows();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.cost_usd)).toBeGreaterThan(0);
  });
});
