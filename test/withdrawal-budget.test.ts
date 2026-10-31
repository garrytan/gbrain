/** A slow complete scan must fit both discovery and the enclosing native admission.
 * No target, byte, malformed-fence, receipt or visibility check is bypassed.
 * Synthetic fixture homes are retained for operator review (no cleanup deletion).
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submitForgetMutation } from '../src/core/persistence/memory-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { renderFactsTable, FACTS_FENCE_END } from '../src/core/facts-fence.ts';
import { withEnv } from './helpers/with-env.ts';
import { parseWithdrawalBudgetMs, WITHDRAWAL_BUDGET_KEY } from '../src/core/facts/withdrawal-budget.ts';

const home = mkdtempSync(join(tmpdir(), 'withdrawal-budget-retained-'));
const engine = new PGLiteEngine();
beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  await engine.connect({}); await engine.initSchema();
  await registerLocalWriter(engine, 'cli');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}), 120_000);
afterAll(() => engine.disconnect());

test('missing, malformed, fractional, zero and unbounded settings keep the ten-second default', () => {
  for (const raw of [undefined, null, '', '0', '-1', '100.5', '999', '120001', 'Infinity', 'no']) {
    expect(parseWithdrawalBudgetMs(raw)).toBe(10_000);
  }
  expect(parseWithdrawalBudgetMs(' 60000 ')).toBe(60_000);
  expect(parseWithdrawalBudgetMs('120000')).toBe(120_000);
});

async function attempt(configured: boolean, malformed = false, exhausted = false) {
  const sourceId = 'budget-' + randomUUID().slice(0, 8);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await engine.setConfig(WITHDRAWAL_BUDGET_KEY, configured ? '60000' : '10000');
  const claim = 'Synthetic complete discovery sentinel ' + sourceId;
  const fact = await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    if (malformed) await tx.putPage('notes/malformed', { type: 'note', title: 'Synthetic',
      compiled_truth: renderFactsTable([{ rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true }]).replace(FACTS_FENCE_END, '') }, { sourceId });
    return tx.insertFact({ fact: claim, source: 'synthetic', visibility: 'world' }, { source_id: sourceId });
  }, TEST_WRITE_ATTRIBUTION));
  let offset = 0, slow = false, timeout = '';
  const nativeNow = performance.now.bind(performance);
  const clock = spyOn(performance, 'now').mockImplementation(() => nativeNow() + offset);
  function wrap(target: BrainEngine): BrainEngine {
    return new Proxy(target, { get(t, key) {
      if (key === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => t.transaction(tx => fn(wrap(tx)));
      if (key === 'executeRaw') return async (sql: string, args?: unknown[]) => {
        if (sql.includes("set_config('statement_timeout'")) timeout = String(args?.[1] ?? '');
        const rows = await t.executeRaw(sql, args);
        if (!slow && sql.startsWith('SELECT p.id,p.slug,p.compiled_truth')) {
          slow = true; offset += exhausted ? 61_000 : 11_000;
        }
        return rows;
      };
      const value = Reflect.get(t, key); return typeof value === 'function' ? value.bind(t) : value;
    } });
  }
  const requestId = randomUUID();
  const ctx: OperationContext = { engine: wrap(engine), sourceId, remote: false, dryRun: false,
    config: { engine: 'pglite', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} } };
  let result: Record<string, unknown> | undefined, code: string | undefined;
  try { result = await withEnv({ GBRAIN_HOME: home }, () => submitForgetMutation(ctx, 'forget_fact', { id: fact.id, request_id: requestId, semantic_review: false })); }
  catch (error) { code = (error as { code?: string }).code; if (!code) throw error; }
  finally { clock.mockRestore(); }
  const rows = await engine.executeRaw<{ active: boolean; withdrawn: boolean; receipts: number }>(`SELECT expired_at IS NULL AS active,
    EXISTS(SELECT 1 FROM fact_withdrawals WHERE source_id=$2) AS withdrawn,
    (SELECT count(*)::int FROM persistence_requests WHERE source_id=$2 AND operation='forget_fact') AS receipts FROM facts WHERE id=$1`, [fact.id, sourceId]);
  return { result, code, state: rows[0], timeout: Number.parseInt(timeout), slow };
}

test('default budget refuses a slow complete scan with no receipt, expiry or withdrawal', async () => {
  const r = await attempt(false);
  expect(r.slow).toBe(true); expect(r.code).toBe('withdrawal_capacity');
  expect(r.state).toEqual({ active: true, withdrawn: false, receipts: 0 });
});

test('configured budget reaches native committed withdrawal and allocates its enclosing SQL window', async () => {
  const r = await attempt(true);
  expect(r.code).toBeUndefined(); expect(r.result).toMatchObject({ state: 'committed', expired: true });
  expect(r.state).toEqual({ active: false, withdrawn: true, receipts: 1 });
  expect(r.timeout).toBeGreaterThanOrEqual(64_000);
});

test('configured budget still refuses an over-budget scan before any mutation', async () => {
  const r = await attempt(true, false, true);
  expect(r.code).toBe('withdrawal_capacity'); expect(r.state).toEqual({ active: true, withdrawn: false, receipts: 0 });
});

test('configured budget still refuses a matching malformed fence before any mutation', async () => {
  const r = await attempt(true, true);
  expect(r.code).toBe('withdrawal_provenance'); expect(r.state).toEqual({ active: true, withdrawn: false, receipts: 0 });
});
