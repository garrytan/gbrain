/**
 * #4210 — extract_facts op (and every other runFactsPipeline entry point
 * outside a cycle) ran with no ambient BudgetTracker, so the Haiku
 * extraction spend was a budget no-op: real money spent, zero rows in the
 * budget audit.
 *
 * Pins the fix's contract at the pipeline choke point (backstop.ts):
 *   - With NO ambient tracker, the pipeline installs a record-only
 *     fallback tracker labeled `facts:<ctx.source>` — the chat spend lands
 *     in the budget audit JSONL.
 *   - With an ambient tracker (the cycle case), the fallback does NOT
 *     engage: rows keep the ambient label and are recorded exactly once.
 *   - The fallback is uncapped, so it can never throw BudgetExhausted —
 *     the pipeline's failure surface is unchanged.
 *
 * Hermetic: PGLite engine + __setChatTransportForTests (which keeps
 * chat()'s real reserve/record wiring active) + GBRAIN_AUDIT_DIR pointed
 * at a temp dir. Env-mutating → serial-safe file (no test.concurrent).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsPipeline } from '../src/core/facts/backstop.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  withBudgetTracker,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';

let engine: PGLiteEngine;
let auditDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-facts-budget-'));
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  rmSync(auditDir, { recursive: true, force: true });
});

/** Stub the extractor's chat call. Priced model id → real cost math runs. */
function chatStub(): void {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({
      facts: [
        { fact: 'budget-accounting-probe fact', kind: 'fact', entity: null, confidence: 1.0, notability: 'medium' },
      ],
    }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 321, output_tokens: 45, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5-20251001',
    providerId: 'anthropic',
  }));
}

/** Every parsed row from every budget-*.jsonl in the temp audit dir. */
function readAuditRows(): any[] {
  const rows: any[] = [];
  for (const f of readdirSync(auditDir)) {
    if (!f.startsWith('budget')) continue;
    for (const line of readFileSync(join(auditDir, f), 'utf-8').split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line));
    }
  }
  return rows;
}

describe('facts pipeline budget accounting (#4210)', () => {
  test('runFactsPipeline with no ambient tracker records chat spend in the budget audit', async () => {
    chatStub();
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const r = await runFactsPipeline('a turn worth extracting', {
        engine,
        sourceId: 'default',
        sessionId: null,
        source: 'mcp:extract_facts',
      });
      expect(r.inserted).toBe(1);
    });

    const records = readAuditRows().filter(r => r.event === 'record');
    // The core of #4210: pre-fix this is [] — the Haiku call happened,
    // the money was spent, and no audit row exists anywhere.
    expect(records.length).toBe(1);
    expect(records[0].label).toBe('facts:mcp:extract_facts');
    expect(records[0].sub_label).toBe('gateway.chat');
    expect(records[0].model).toBe('anthropic:claude-haiku-4-5-20251001');
    expect(records[0].input_tokens).toBe(321);
    expect(records[0].output_tokens).toBe(45);
    expect(records[0].actual_cost_usd).toBeGreaterThan(0);
  });

  test('extract_facts op handler end-to-end: spend is audited, response envelope unchanged', async () => {
    chatStub();
    const op = operations.find(o => o.name === 'extract_facts')!;
    const ctx = {
      engine,
      config: {},
      logger: console,
      dryRun: false,
      remote: true,
    } as unknown as OperationContext;

    let result: any;
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      result = await op.handler(ctx, { turn_text: 'another turn worth extracting' });
    });

    // Response contract untouched by the fix.
    expect(typeof result.inserted).toBe('number');
    expect(Array.isArray(result.fact_ids)).toBe(true);

    const records = readAuditRows().filter(r => r.event === 'record');
    expect(records.length).toBe(1);
    expect(records[0].label).toBe('facts:mcp:extract_facts');
  });

  test('the fallback label carries the entry point: hook:compact audits as facts:hook:compact', async () => {
    chatStub();
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      await runFactsPipeline('a compaction-boundary turn', {
        engine,
        sourceId: 'default',
        sessionId: null,
        source: 'hook:compact',
      });
    });
    const records = readAuditRows().filter(r => r.event === 'record');
    expect(records.length).toBe(1);
    expect(records[0].label).toBe('facts:hook:compact');
  });

  test('an ambient tracker (cycle case) wins: rows keep the ambient label, recorded exactly once', async () => {
    chatStub();
    const ambient = new BudgetTracker({ label: 'cycle-phase-test', auditPath: join(auditDir, 'budget-ambient.jsonl') });
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      await withBudgetTracker(ambient, () =>
        runFactsPipeline('a cycle-scoped turn', {
          engine,
          sourceId: 'default',
          sessionId: null,
          source: 'sync:import',
        }),
      );
    });

    const records = readAuditRows().filter(r => r.event === 'record');
    // Exactly one record, under the ambient label — the fallback must not
    // double-wrap an already-scoped call.
    expect(records.length).toBe(1);
    expect(records[0].label).toBe('cycle-phase-test');
    expect(ambient.snapshot().callsRecorded).toBe(1);
    expect(ambient.totalSpent).toBeGreaterThan(0);
  });
});
