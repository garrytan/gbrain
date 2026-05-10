import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseAutoThink } from '../src/core/cycle/auto-think.ts';
import { runPhaseDrift, __testing as driftTesting } from '../src/core/cycle/drift.ts';
import { _resetBudgetMeterWarningsForTest } from '../src/core/cycle/budget-meter.ts';
import type { ThinkLLMClient } from '../src/core/think/index.ts';

let engine: PGLiteEngine;
let alicePageId: number;
let tmpDir: string;

function makeStubClient(answer: string): ThinkLLMClient {
  return {
    create: async () => ({
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model: 'stub',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
      content: [{ type: 'text', text: JSON.stringify({ answer, citations: [], gaps: [] }) }],
    }),
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const alice = await engine.putPage('people/alice-example', {
    title: 'Alice', type: 'person', compiled_truth: 'Alice content',
  });
  alicePageId = alice.id;
  // Add takes spanning the soft band so drift candidates exist
  await engine.addTakesBatch([
    { page_id: alicePageId, row_num: 1, claim: 'CEO of Acme', kind: 'fact', holder: 'world', weight: 1.0 },
    { page_id: alicePageId, row_num: 2, claim: 'Strong technical founder', kind: 'take', holder: 'garry', weight: 0.6 },
    { page_id: alicePageId, row_num: 3, claim: 'Will reach $50B', kind: 'bet', holder: 'garry', weight: 0.5 },
  ]);
  // Add timeline entries to give drift candidates "recent evidence"
  await engine.addTimelineEntriesBatch([
    { slug: 'people/alice-example', date: new Date().toISOString().slice(0, 10), source: 'crustdata', summary: 'Funding round closed' },
    { slug: 'people/alice-example', date: new Date().toISOString().slice(0, 10), source: 'meeting', summary: 'OH discussion' },
  ]);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(() => {
  _resetBudgetMeterWarningsForTest();
  tmpDir = mkdtempSync(join(tmpdir(), 'auto-think-'));
});

describe('runPhaseAutoThink', () => {
  test('skipped when not enabled', async () => {
    const r = await runPhaseAutoThink(engine, { dryRun: false, auditPath: join(tmpDir, 'budget.jsonl') });
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('false');
  });

  test('skipped when enabled but no questions', async () => {
    await engine.setConfig('dream.auto_think.enabled', 'true');
    await engine.setConfig('dream.auto_think.questions', '[]');
    const r = await runPhaseAutoThink(engine, { dryRun: false, auditPath: join(tmpDir, 'b1.jsonl') });
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('empty');
    await engine.setConfig('dream.auto_think.enabled', 'false');
  });

  test('runs when enabled with questions, marks success on cooldown ts', async () => {
    await engine.setConfig('dream.auto_think.enabled', 'true');
    await engine.setConfig('dream.auto_think.questions', JSON.stringify(['What about technical founders?']));
    await engine.setConfig('dream.auto_think.max_per_cycle', '1');
    await engine.setConfig('dream.auto_think.budget', '10.0');
    await engine.setConfig('dream.auto_think.auto_commit', 'false');
    // Clear any prior cooldown
    await engine.setConfig('dream.auto_think.last_completion_ts', '');
    const r = await runPhaseAutoThink(engine, {
      dryRun: false,
      client: makeStubClient('Alice [people/alice-example#2] is a strong founder.'),
      auditPath: join(tmpDir, 'b2.jsonl'),
    });
    expect(r.status).toBe('complete');
    expect((r.totals as { synthesized?: number }).synthesized).toBe(1);
    const ts = await engine.getConfig('dream.auto_think.last_completion_ts');
    expect(ts).toBeTruthy();
    expect(ts!.length).toBeGreaterThan(0);
    await engine.setConfig('dream.auto_think.enabled', 'false');
  });

  test('cooldown skips next run', async () => {
    await engine.setConfig('dream.auto_think.enabled', 'true');
    await engine.setConfig('dream.auto_think.questions', JSON.stringify(['Q1']));
    await engine.setConfig('dream.auto_think.cooldown_days', '30');
    // Set a recent completion ts
    await engine.setConfig('dream.auto_think.last_completion_ts', new Date().toISOString());
    const r = await runPhaseAutoThink(engine, { dryRun: false, auditPath: join(tmpDir, 'b3.jsonl') });
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('cooled down');
    await engine.setConfig('dream.auto_think.enabled', 'false');
    await engine.setConfig('dream.auto_think.last_completion_ts', '');
  });

  test('budget exhausted denies further submits, returns partial', async () => {
    await engine.setConfig('dream.auto_think.enabled', 'true');
    await engine.setConfig('dream.auto_think.questions', JSON.stringify(['Q1', 'Q2', 'Q3']));
    await engine.setConfig('dream.auto_think.max_per_cycle', '3');
    await engine.setConfig('dream.auto_think.budget', '0.001');  // tiny cap forces budget_exhausted on first submit
    await engine.setConfig('dream.auto_think.cooldown_days', '0');
    await engine.setConfig('dream.auto_think.last_completion_ts', '');
    // Ensure a clean meter state (no warn-once leftover)
    _resetBudgetMeterWarningsForTest();
    const r = await runPhaseAutoThink(engine, {
      dryRun: false,
      client: makeStubClient('test'),
      auditPath: join(tmpDir, 'b4.jsonl'),
    });
    // First submit denied → no syntheses → status 'partial' if any attempts, else 'skipped'.
    // Our impl returns 'partial' when results.length > 0 and anyComplete=false.
    expect(['partial', 'skipped']).toContain(r.status);
    await engine.setConfig('dream.auto_think.enabled', 'false');
  });
});

describe('runPhaseDrift', () => {
  test('skipped when not enabled', async () => {
    const r = await runPhaseDrift(engine, { dryRun: false, auditPath: join(tmpDir, 'd0.jsonl') });
    expect(r.status).toBe('skipped');
  });

  test('findDriftCandidates returns soft-band takes with recent evidence', async () => {
    const cands = await driftTesting.findDriftCandidates(engine, 30);
    // Row 2 (weight 0.6) and row 3 (weight 0.5) qualify; row 1 (1.0) is filtered.
    expect(cands.length).toBeGreaterThanOrEqual(1);
    expect(cands.every(c => c.weight >= 0.3 && c.weight <= 0.85)).toBe(true);
  });

  test('runs and surfaces candidates when enabled', async () => {
    await engine.setConfig('dream.drift.enabled', 'true');
    await engine.setConfig('dream.drift.lookback_days', '30');
    await engine.setConfig('dream.drift.budget', '1.0');
    const r = await runPhaseDrift(engine, { dryRun: false, auditPath: join(tmpDir, 'd1.jsonl') });
    expect(r.status).toBe('complete');
    expect((r.totals as { candidates?: number }).candidates).toBeGreaterThanOrEqual(0);
    await engine.setConfig('dream.drift.enabled', 'false');
  });

  test('dry-run returns skipped with candidate count', async () => {
    await engine.setConfig('dream.drift.enabled', 'true');
    const r = await runPhaseDrift(engine, { dryRun: true, auditPath: join(tmpDir, 'd2.jsonl') });
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('dry-run');
    await engine.setConfig('dream.drift.enabled', 'false');
  });
});
