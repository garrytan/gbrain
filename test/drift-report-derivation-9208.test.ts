/**
 * #9208: the drift phase's report (reports/drift-<date>) is derived from the
 * pages whose takes were judged; the judge's evidence is those same pages'
 * timeline entries. The report must carry that derivation (channel
 * derive:drift, the least trusted judged page, capped at agent_written) on
 * both publish paths, as the dream summary does, instead of landing with
 * trust_tier 'unknown' and no write_origin.
 *
 * PGLite ($0): an unmanaged brain (publishSinglePage) and a managed brain
 * (publishMaintenancePage). Synthetic content only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPhaseDrift } from '../src/core/cycle/drift.ts';
import { _resetBudgetMeterWarningsForTest } from '../src/core/cycle/budget-meter.ts';
import { withWriteTrust } from '../src/core/persistence/context.ts';
import type { TrustTier } from '../src/core/trust/tier.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const CYCLE_DATE = '2031-04-14';
const REPORT = `reports/drift-${CYCLE_DATE}`;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** The judged page at `tier`; its take and timeline evidence at `rowsTier` (default: the page's). */
async function seed(engine: BrainEngine, tier: TrustTier, rowsTier: TrustTier = tier) {
  const page = await engine.transaction(tx => withWriteTrust(tx, { tier, origin: { channel: 'sync' } }, () =>
    tx.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'A person at Acme.', timeline: '', frontmatter: {} })));
  await engine.transaction(tx => withWriteTrust(tx, { tier: rowsTier, origin: { channel: 'sync' } }, async () => {
    await tx.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Acme will ship the widget this year', kind: 'take', holder: 'world', weight: 0.6 }]);
    await tx.addTimelineEntriesBatch([{ slug: 'people/alice-example', date: '2031-04-10', source: 'meeting', summary: 'Widget launch slipped' }]);
  }));
  await engine.setConfig('dream.drift.enabled', 'true');
  await engine.setConfig('dream.drift.budget', '1.0');
  await engine.setConfig('models.drift', 'anthropic:claude-sonnet-4-6');
}

async function drift(engine: BrainEngine) {
  _resetBudgetMeterWarningsForTest();
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-9208-'));
  dirs.push(dir);
  const result = await runPhaseDrift(engine, {
    dryRun: false, forceEnabled: true, cycleDate: CYCLE_DATE, auditPath: join(dir, 'drift-audit.jsonl'),
    judge: async () => ({ drifted: true, confidence: 0.9, reasoning: 'Evidence moved.' }),
  });
  expect(result.status).toBe('complete');
  const [row] = await engine.executeRaw<{ trust_tier: string | null; write_origin: { channel?: string } | string | null }>(
    'SELECT trust_tier, write_origin FROM pages WHERE slug = $1', [REPORT]);
  expect(row).toBeDefined();
  const origin = typeof row!.write_origin === 'string' ? JSON.parse(row!.write_origin) : row!.write_origin;
  return { tier: row!.trust_tier, channel: origin?.channel ?? null };
}

const CASES: Array<[TrustTier, TrustTier]> = [['operator_curated', 'agent_written'], ['external_untrusted', 'external_untrusted']];

describe('#9208 drift report carries a derive:drift derivation', () => {
  for (const [input, expected] of CASES) {
    test(`unmanaged (publishSinglePage): ${input} judged page -> ${expected}`, async () => {
      await seed(engine, input);
      expect(await drift(engine)).toEqual({ tier: expected, channel: 'derive:drift' });
    }, 120_000);

    test(`managed (publishMaintenancePage): ${input} judged page -> ${expected}`, async () => {
      await managedBrain(async ({ engine }) => {
        expect(await drift(engine)).toEqual({ tier: expected, channel: 'derive:drift' });
      }, { setup: ({ engine }) => seed(engine, input) });
    }, 180_000);
  }

  test('the take and timeline evidence the judge read cap the report and are its recorded inputs', async () => {
    await seed(engine, 'operator_curated', 'external_untrusted');
    const [take] = await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM takes');
    expect(take!.trust_tier).toBe('external_untrusted');
    expect(await drift(engine)).toEqual({ tier: 'external_untrusted', channel: 'derive:drift' });
    const inputs = await engine.executeRaw<{ input_table: string }>(`SELECT DISTINCT d.input_table FROM derivation_inputs d
      JOIN pages p ON d.derived_table = 'pages' AND d.derived_id = p.id::text WHERE p.slug = $1 ORDER BY 1`, [REPORT]);
    expect(inputs.map(r => r.input_table)).toEqual(['pages', 'takes', 'timeline_entries']);
  }, 120_000);

  test('managed: the take and timeline evidence the judge read cap the report', async () => {
    await managedBrain(async ({ engine }) => {
      expect(await drift(engine)).toEqual({ tier: 'external_untrusted', channel: 'derive:drift' });
    }, { setup: ({ engine }) => seed(engine, 'operator_curated', 'external_untrusted') });
  }, 180_000);
});
