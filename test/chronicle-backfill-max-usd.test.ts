/**
 * #6199 — `chronicle-backfill --max-usd`: a hard spend bound fixed at queue time.
 *
 * Protects: pages queue only while queued × (per-attempt cap + one call's
 * ceiling) × maximum attempts fits under max_usd; queued rows carry the
 * campaign stamp and every executor obeys it, not current settings;
 * attempts are consumed at claim, so a crash cannot add an attempt; a stale
 * completion after its lease expired is fenced and spend is summed per
 * attempt without double counting; overlapping invocations never share a
 * page; an unpriced model under a user cap refuses with no_pricing and the
 * register-price fix, and without a cap it still warns and runs.
 * Fails when: a retry, crash, restart, settings change or second
 * invocation lets a campaign spend past its bound.
 * Seams: injected judge (`runPhaseChronicle({ judge })`) recording spend on
 * the ambient BudgetTracker; PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runChronicleBackfill } from '../src/core/chronicle/backfill.ts';
import { claimChronicleRow } from '../src/core/chronicle/execute.ts';
import type { ChronicleJudge, ChronicleJudgeResult } from '../src/core/chronicle/extract-events.ts';
import type { ChronicleLedgerRow } from '../src/core/chronicle/contract.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';
import { configureGateway, getCurrentBudgetTracker, resetGateway } from '../src/core/ai/gateway.ts';
import { recordOnTracker } from '../src/core/ai/budget-record.ts';
import { _resetBudgetTrackerWarningsForTest } from '../src/core/budget/budget-tracker.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const MODEL = 'anthropic:claude-sonnet-4-6';
const UNPRICED = 'openai:gpt-unpriced-example';
const LONG = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta release. '.repeat(2);
/** One recorded judge call: 1000 input + 100 output tokens at the sonnet rate. */
const CALL = { inputTokens: 1000, outputTokens: 100 };

type Result = Record<string, unknown> & { queued: number; worst_case_usd: number | 'unpriced'; per_page_worst_case_usd: number | null;
  fits_under_cap: number | null; cap_reached: boolean; campaign_id: string | null; next_command: string; ask_user: boolean; message: string };

function spendingJudge(answer: (n: number) => ChronicleJudgeResult | Promise<ChronicleJudgeResult>) {
  const judge = Object.assign((async () => {
    const tracker = getCurrentBudgetTracker();
    judge.caps.push(tracker?.cap);
    recordOnTracker(tracker, { modelId: MODEL, ...CALL, label: 'chronicle', kind: 'chat' });
    return answer(++judge.calls);
  }) as ChronicleJudge, { calls: 0, caps: [] as Array<number | undefined> });
  return judge;
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`${backend}: chronicle-backfill --max-usd (#6199)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const ctx = (): OperationContext => ({ engine, remote: false } as unknown as OperationContext);
    const backfill = async (p: Record<string, unknown>) => await operationsByName.chronicle_backfill.handler(ctx(), p) as Result;
    const ledger = () => engine.executeRaw<ChronicleLedgerRow>('SELECT * FROM chronicle_page_state ORDER BY slug');
    const pages = async (n: number) => {
      for (let i = 1; i <= n; i++) await engine.putPage(`meetings/m${i}`, { type: 'meeting', title: `m${i}`, compiled_truth: LONG });
    };
    const perPage = async () => (await backfill({ dry_run: true, max_usd: 1000 })).per_page_worst_case_usd!;
    const expire = () => engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at = now() - interval '1 second'");

    beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl)); });
    afterAll(async () => { await close(); });
    beforeEach(async () => {
      configureGateway({ chat_model: MODEL, env: {} });
      await engine.executeRaw('DELETE FROM chronicle_page_state');
      await engine.executeRaw("DELETE FROM pages WHERE slug LIKE 'meetings/%' OR slug LIKE 'life/%'");
      await engine.setConfig('auto_chronicle', 'false');
      await engine.unsetConfig('chronicle.job_budget_usd');
    });
    afterEach(() => { resetGateway(); _resetBudgetTrackerWarningsForTest(); });

    test('a dry run reports the worst case and how many pages fit; nothing is queued', async () => {
      await pages(3);
      const unit = await perPage();
      expect(unit).toBeGreaterThan(0.25 * 5);
      const r = await backfill({ dry_run: true, max_usd: unit * 2.5 });
      expect(r).toMatchObject({ queued: 2, fits_under_cap: 2, cap_reached: true, max_usd: unit * 2.5, ask_user: true });
      expect(r.worst_case_usd).toBeCloseTo(unit * 2, 3);
      expect(r.next_command).toContain(`--max-usd ${unit * 2.5} --yes`);
      expect(await ledger()).toEqual([]);
    });

    test('max_usd that fits 2 of 3 pages queues exactly 2, stamped with the campaign and its policy', async () => {
      await pages(3);
      const unit = await perPage();
      const r = await backfill({ yes: true, max_usd: unit * 2.5 });
      expect(r).toMatchObject({ queued: 2, fits_under_cap: 2, cap_reached: true, spent_usd: 0 });
      expect(r.message).toContain('did not fit under --max-usd');
      const rows = await ledger();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({ state: 'pending', trigger: 'backfill', campaign_id: r.campaign_id, max_attempts: 5, pricing_policy: 'enforced' });
        expect(Number(row.attempt_cap_usd)).toBe(0.25);
        expect(Number(row.campaign_max_usd)).toBeCloseTo(unit * 2.5, 6);
      }
    });

    test('max_usd below one page queues nothing and asks for a larger bound', async () => {
      await pages(2);
      const r = await backfill({ yes: true, max_usd: 0.5 });
      expect(r).toMatchObject({ queued: 0, fits_under_cap: 0, cap_reached: true, ask_user: true });
      expect(r.next_command).toContain('--max-usd 0.5 --dry-run');
      expect(await ledger()).toEqual([]);
    });

    test('an unpriced model under a user cap refuses with no_pricing and the register-price fix; nothing is queued', async () => {
      configureGateway({ chat_model: UNPRICED, env: {} });
      await pages(2);
      const err = await backfill({ yes: true, max_usd: 50 }).catch((e) => e);
      expect(err?.code ?? err?.error).toBe('no_pricing');
      expect(err.fix.argv.slice(0, 3)).toEqual(['gbrain', 'pricing', 'set']);
      expect(await ledger()).toEqual([]);
    });

    test('without max_usd an unpriced model warns and runs, pointing at --max-usd and price registration', async () => {
      await pages(2);
      const r = await runChronicleBackfill(engine, { yes: true, model: UNPRICED }) as unknown as Result;
      expect(r).toMatchObject({ queued: 2, worst_case_usd: 'unpriced', fits_under_cap: null, campaign_id: null });
      expect(r.message).toContain('--max-usd');
      expect(r.message).toContain('gbrain pricing set');
      expect((await ledger()).every((row) => row.campaign_id === null)).toBe(true);
    });

    test('max_usd must be a positive number', async () => {
      const err = await backfill({ dry_run: true, max_usd: -1 }).catch((e) => e);
      expect(err?.code ?? err?.error).toBe('invalid_params');
    });

    test('the executor runs a campaign row under its stamped cap after the setting changes', async () => {
      await pages(1);
      await backfill({ yes: true, max_usd: 100 });
      await engine.setConfig('chronicle.job_budget_usd', '0.05');
      const judge = spendingJudge(() => ({ events: [] }));
      await runPhaseChronicle(engine, { judge });
      expect(judge.caps).toEqual([0.25]);
      expect((await ledger())[0]).toMatchObject({ state: 'extracted', attempts: 1 });
    });

    test('a page that fails once then succeeds stays inside the bound, with spend summed per attempt', async () => {
      await pages(1);
      const unit = await perPage();
      await backfill({ yes: true, max_usd: unit + 0.01 });
      const judge = spendingJudge((n) => n === 1 ? { events: [], failure: 'chat_error' } : { events: [] });
      await runPhaseChronicle(engine, { judge });
      expect((await ledger())[0]).toMatchObject({ state: 'failed', reason: 'judge_chat_error', attempts: 1 });
      await expire();
      await runPhaseChronicle(engine, { judge });
      const [row] = await ledger();
      expect(row).toMatchObject({ state: 'extracted', attempts: 2 });
      expect(row.cost_attempts).toEqual([1, 2]);
      expect(Number(row.cost_usd)).toBeCloseTo(2 * (1000 * 3 + 100 * 15) / 1_000_000, 8);
      expect(Number(row.cost_usd)).toBeLessThanOrEqual(unit);
    });

    test('a crash after the claim consumes the attempt; an exhausted row fails without another call', async () => {
      await pages(1);
      await backfill({ yes: true, max_usd: 100 });
      for (let i = 1; i <= 5; i++) {
        const [row] = await ledger();
        const claimed = await claimChronicleRow(engine, row);
        expect(claimed?.attempts).toBe(i);
        await expire();
      }
      const [spent] = await ledger();
      expect(spent).toMatchObject({ state: 'pending', attempts: 5 });
      expect(await claimChronicleRow(engine, spent)).toBeNull();
      const judge = spendingJudge(() => ({ events: [] }));
      await runPhaseChronicle(engine, { judge });
      expect(judge.calls).toBe(0);
      expect((await ledger())[0]).toMatchObject({ state: 'failed', reason: 'campaign_exhausted', attempts: 5 });
    });

    test('a stale completion after its lease expired is fenced; its spend is recorded once', async () => {
      await pages(1);
      await backfill({ yes: true, max_usd: 100 });
      const judge = spendingJudge(async () => {
        await expire();
        const [row] = await ledger();
        expect((await claimChronicleRow(engine, row))?.attempts).toBe(2);
        return { events: [] };
      });
      await runPhaseChronicle(engine, { judge });
      const [row] = await ledger();
      expect(row).toMatchObject({ state: 'pending', attempts: 2, cost_attempts: [1] });
    });

    test('a restart mid-campaign queues only the rest, each campaign within its own bound', async () => {
      await pages(4);
      const unit = await perPage();
      const first = await backfill({ yes: true, max_usd: unit * 2 + 0.01 });
      const second = await backfill({ yes: true, max_usd: unit * 2 + 0.01 });
      expect(first.queued).toBe(2);
      expect(second.queued).toBe(2);
      expect(first.campaign_id).not.toBe(second.campaign_id);
      const rows = await ledger();
      expect(rows.filter((r) => r.campaign_id === first.campaign_id)).toHaveLength(2);
      expect(rows.filter((r) => r.campaign_id === second.campaign_id)).toHaveLength(2);
      expect((await backfill({ yes: true, max_usd: unit * 2 + 0.01 })).queued).toBe(0);
    });

    test('two overlapping invocations never share a page and neither exceeds its cap', async () => {
      await pages(6);
      const unit = await perPage();
      const [a, b] = await Promise.all([backfill({ yes: true, max_usd: unit * 4 + 0.01 }), backfill({ yes: true, max_usd: unit * 3 + 0.01 })]);
      const rows = await ledger();
      expect(rows).toHaveLength(a.queued + b.queued);
      expect(a.queued * unit).toBeLessThanOrEqual(unit * 4 + 1e-9);
      expect(b.queued * unit).toBeLessThanOrEqual(unit * 3 + 1e-9);
      expect(rows.filter((r) => r.campaign_id === a.campaign_id)).toHaveLength(a.queued);
      expect(rows.filter((r) => r.campaign_id === b.campaign_id)).toHaveLength(b.queued);
    });
  });
}
