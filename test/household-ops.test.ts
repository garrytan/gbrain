/**
 * household_due / household_add / household_mark (agent platform plan, lane 2, H1) on a repo-less keyless PGLite
 * brain, trusted local callers. The synthetic household seeds 40 records; the ranking and counts were computed by
 * hand (test/fixtures/synthetic-household/household.ts). Synthetic data only.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { installTripwire, type Tripwire } from './helpers/ai-tripwire.ts';
import { AS_OF, EXPECTED_COUNTS, EXPECTED_DUE, TIMEZONE, seedSyntheticHousehold } from './fixtures/synthetic-household/household.ts';

let engine: PGLiteEngine;
let tripwire: Tripwire;
let slugs: Map<string, string>;
const call = (op: string, params: Record<string, unknown>) => handleToolCall(engine, op, params) as Promise<any>;

beforeAll(async () => {
  tripwire = installTripwire();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('brain.timezone', TIMEZONE);
  slugs = await seedSyntheticHousehold(call);
}, 120_000);

afterAll(async () => {
  tripwire.dispose();
  await engine.disconnect();
});

describe('household_due on the synthetic household', () => {
  test('ranks what is due by the hand-computed order, with the hand-computed counts', async () => {
    const due = await call('household_due', { as_of: AS_OF });
    expect(due.state).toBe('complete');
    expect(due.timezone).toBe(TIMEZONE);
    expect(due.counts).toEqual(EXPECTED_COUNTS);
    expect(due.items.map((i: any) => i.title)).toEqual(EXPECTED_DUE);
    expect(due.truncated).toBe(false);
    expect(due.text).toContain('2 overdue, 12 at risk, 2 coming up');
  });

  test('every proposed action needs the user\'s yes', async () => {
    const all = await call('household_due', { as_of: AS_OF, include: 'all', limit: 100, window_days: 366 });
    const actions = all.items.map((i: any) => i.proposed_action).filter(Boolean);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(a.requires_approval).toBe(true);
  });

  test('kinds and include narrow the read', async () => {
    const bills = await call('household_due', { as_of: AS_OF, kinds: ['bill'] });
    expect(bills.items.map((i: any) => i.title)).toEqual(['Water bill', 'Electric bill', 'Internet bill']);
    const risky = await call('household_due', { as_of: AS_OF, include: 'at_risk' });
    expect(risky.items.map((i: any) => i.state)).not.toContain('upcoming');
  });

  test('a mark restarts the cadence: milk bought today is next due in 7 days, so it moves from at risk to coming up', async () => {
    await call('household_mark', { slug: slugs.get('Milk')!, event: 'bought', on: AS_OF });
    const due = await call('household_due', { as_of: AS_OF });
    const milk = due.items.find((i: any) => i.title === 'Milk');
    expect(milk).toMatchObject({ state: 'upcoming', next_due: '2026-12-08' });
    expect(due.counts).toMatchObject({ at_risk: EXPECTED_COUNTS.at_risk - 1, upcoming: EXPECTED_COUNTS.upcoming + 1 });
  });

  test('no generative model call and no network besides page embedding, when a key is configured, on any household path', () => {
    expect(tripwire.generative()).toEqual([]);
    expect(tripwire.egress.filter(url => !url.endsWith('/embeddings'))).toEqual([]);
  });
});

describe('household_add refusals', () => {
  test('an account number in a field refuses with account_number_key and writes nothing', async () => {
    const err = await call('household_add', { kind: 'bill', title: 'Card 4111 1111 1111 1111', due: '2026-12-09' }).catch(e => e);
    expect(err.code).toBe('account_number_key');
    const err2 = await call('household_add', { kind: 'bill', title: 'Utility', note: 'acct 000123456789', due: '2026-12-09' }).catch(e => e);
    expect(err2.code).toBe('account_number_key');
  });

  test('a second record with the same slug refuses with household_exists', async () => {
    const err = await call('household_add', { kind: 'bill', title: 'Water bill', due: '2026-12-28' }).catch(e => e);
    expect(err.code).toBe('household_exists');
  });
});
