/**
 * GBRA-574 A3: one rule ends a superseded fact's validity, whichever writer supersedes it (facts/supersede-interval.ts):
 * at the replacement's valid_from when that falls inside the retired window, else at the retired fact's own earlier end
 * or now. Future writes only: rows already stored keep their valid_until, and a withdrawn or forgotten fact's state is
 * untouched. PGLite, no network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { supersededValidUntil } from '../src/core/facts/supersede-interval.ts';
import { insertProposal } from '../src/core/ai/decide/proposals-store.ts';
import { applyProposalAction, planAcceptFence, type PairFact } from '../src/core/facts/proposal-supersede.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;
const NOW = new Date('2026-06-01T00:00:00Z');
const at = (d: string) => new Date(`${d}T00:00:00Z`);
const day = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString().slice(0, 10));
const add = async (fact: string, validFrom: string, opts: { supersedeId?: number; validUntil?: string } = {}) =>
  (await engine.insertFact({ fact, entity_slug: 'people/alice-example', source: 'test', visibility: 'world', valid_from: at(validFrom), // gbrain-allow-direct-insert: GBRA-574 A3 probe of the engine supersede rule
    ...(opts.validUntil ? { valid_until: at(opts.validUntil) } : {}) }, { source_id: 'default', ...(opts.supersedeId ? { supersedeId: opts.supersedeId } : {}) })).id;
const row = async (id: number) => (await engine.executeRaw<{ valid_until: Date | string | null; expired_at: Date | string | null; superseded_by: number | null }>(
  'SELECT valid_until, expired_at, superseded_by FROM facts WHERE id = $1', [id]))[0]!;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);
beforeEach(async () => { await resetPgliteState(engine); });

describe('the rule', () => {
  const retired = { valid_from: at('2025-01-10'), valid_until: null };
  test('a replacement dated inside the retired window ends it there', () => {
    expect(supersededValidUntil(retired, at('2025-02-15'), NOW)).toEqual(at('2025-02-15'));
  });
  test('a backdated replacement ends it now, never leaves it open', () => {
    expect(supersededValidUntil(retired, at('2025-01-01'), NOW)).toEqual(NOW);
  });
  test('a replacement dated after now ends it now', () => {
    expect(supersededValidUntil(retired, at('2026-09-01'), NOW)).toEqual(NOW);
  });
  test('a retired fact that already ended earlier keeps its end', () => {
    expect(supersededValidUntil({ valid_from: at('2025-01-10'), valid_until: at('2025-01-20') }, at('2025-02-15'), NOW)).toEqual(at('2025-01-20'));
    expect(supersededValidUntil({ valid_from: at('2025-01-10'), valid_until: at('2025-03-01') }, at('2025-02-15'), NOW)).toEqual(at('2025-02-15'));
  });
  test('no replacement date: its own earlier end or now', () => {
    expect(supersededValidUntil(retired, null, NOW)).toEqual(NOW);
  });
  test('a retired fact dated after now never ends before it began', () => {
    const future = { valid_from: at('2026-09-01'), valid_until: null };
    expect(supersededValidUntil(future, at('2026-10-01'), NOW)).toEqual(at('2026-09-01'));
    expect(supersededValidUntil(future, at('2025-01-01'), NOW)).toEqual(at('2026-09-01'));
    expect(supersededValidUntil(future, null, NOW)).toEqual(at('2026-09-01'));
  });
});

describe('engine insertFact with supersedeId', () => {
  test('ends the retired fact at the replacement date inside its window, else now', async () => {
    const old = await add('Bob Example works at Beta Corp.', '2025-01-10');
    await add('Bob Example works at Gamma Labs.', '2025-02-15', { supersedeId: old });
    expect(day((await row(old)).valid_until)).toBe('2025-02-15');
    const later = await add('Carol Example lives in Porto.', '2025-03-01');
    const before = Date.now();
    await add('Carol Example lives in Lisbon.', '2025-01-01', { supersedeId: later });
    const until = (await row(later)).valid_until;
    expect(until).not.toBeNull();
    expect(new Date(until!).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('a retired fact whose valid_from is in the future', () => {
  test('insertFact and expireFact end it no earlier than its own valid_from', async () => {
    const begins = (id: number) => engine.executeRaw<{ valid_from: Date | string }>('SELECT valid_from FROM facts WHERE id = $1', [id]).then(r => new Date(r[0]!.valid_from).getTime());
    const a = await add('Dana Example starts at Beta Corp.', '2099-01-01');
    await add('Dana Example starts at Gamma Labs.', '2025-01-01', { supersedeId: a });
    expect(new Date((await row(a)).valid_until!).getTime()).toBeGreaterThanOrEqual(await begins(a));
    const b = await add('Dana Example moves to Porto.', '2099-01-01');
    expect(await engine.expireFact(b, { successorFrom: at('2025-01-01') })).toBe(true);
    expect(new Date((await row(b)).valid_until!).getTime()).toBeGreaterThanOrEqual(await begins(b));
  });
});

describe('engine expireFact', () => {
  test('with the successor date it ends the row by the rule; a plain expiry keeps valid_until as stored', async () => {
    const a = await add('Bob Example works at Beta Corp.', '2025-01-10');
    expect(await engine.expireFact(a, { successorFrom: at('2025-02-15') })).toBe(true);
    expect(day((await row(a)).valid_until)).toBe('2025-02-15');
    const b = await add('Bob Example works at Delta Inc.', '2025-01-10');
    expect(await engine.expireFact(b)).toBe(true);
    expect((await row(b)).valid_until).toBeNull();
  });
});

describe('proposal accept', () => {
  test('ends the old fact at the newer fact\'s valid_from, in the row and in the struck fence row', async () => {
    const old = await add('Bob Example works at Beta Corp.', '2025-01-10');
    const fresh = await add('Bob Example works at Gamma Labs.', '2025-02-15');
    const id = (await insertProposal(engine, { source_id: 'default', sweep_id: 's', pair_index: 0, new_fact_id: fresh, old_fact_id: old,
      direction: 'new_supersedes_old', p_supersede: 0.8, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'jev-test' }))!;
    expect((await applyProposalAction(engine, id, 'accept')).status).toBe('accepted');
    expect(await row(old)).toMatchObject({ superseded_by: fresh });
    expect(day((await row(old)).valid_until)).toBe('2025-02-15');
    const pair = (f: Partial<PairFact>): PairFact => ({ id: 1, source_id: 'default', entity_slug: 'people/alice-example', visibility: 'world', fact: 'x', expired_at: null,
      valid_until: null, superseded_by: null, row_num: 1, source_markdown_slug: 'people/alice-example', ...f });
    const body = '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | Bob Example works at Beta Corp. | fact | 1.0 | world | medium | 2025-01-10 |  | test |  |\n<!--- gbrain:facts:end -->\n';
    const plan = planAcceptFence(body, pair({ valid_from: '2025-01-10T00:00:00.000Z' }), pair({ id: 2, row_num: null, valid_from: '2025-02-15T00:00:00.000Z' }), '2026-06-01');
    expect(parseFactsFence(plan!.body).facts[0]).toMatchObject({ active: false, validUntil: '2025-02-15' });
  });
});

describe('future writes only; withdrawals untouched', () => {
  test('a row superseded before this change keeps its stored valid_until', async () => {
    const old = await add('Bob Example works at Beta Corp.', '2025-01-10');
    const fresh = await add('Bob Example works at Gamma Labs.', '2025-02-15');
    await engine.executeRaw('UPDATE facts SET expired_at = now(), superseded_by = $2, valid_until = NULL WHERE id = $1', [old, fresh]);
    await add('Bob Example works at Delta Inc.', '2025-03-01', { supersedeId: fresh });
    expect((await row(old)).valid_until).toBeNull();
  });
  test('a forgotten fact is withdrawn as before: expired, no successor, ended at the withdrawal', async () => {
    const id = await add('Bob Example works at Beta Corp.', '2025-01-10', { validUntil: '2030-01-01' });
    const before = Date.now();
    await forgetFactInFence(engine, id);
    const r = await row(id);
    expect(r.expired_at).not.toBeNull();
    expect(r.superseded_by).toBeNull();
    expect(new Date(r.valid_until!).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(r.valid_until!).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await engine.executeRaw('SELECT 1 FROM fact_withdrawals')).length).toBe(1);
  });
});
