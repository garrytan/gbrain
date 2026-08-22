/**
 * #3683 — the empty-fence guard's early return skipped the facts.fence
 * rollup write entirely, so `halt_count` could never increment and doctor
 * extract_health / extract status / extract --explain were structurally
 * blind to a jammed phase (halt_rate pinned at 0 while the phase refused
 * to reconcile).
 *
 * Stub-engine repro from the issue: no database, no filesystem. The guard
 * path must book exactly one rollup UPSERT with halt_delta=1 /
 * round_completed_delta=0; the healthy path books completed=1 / halt=0.
 */

import { describe, test, expect } from 'bun:test';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import type { BrainEngine } from '../src/core/engine.ts';

interface CapturedCall {
  sql: string;
  params: unknown[];
}

function mkEngine(legacyCount: number): { calls: CapturedCall[]; engine: BrainEngine } {
  const calls: CapturedCall[] = [];
  const engine = {
    async executeRaw(sql: string, params: unknown[] = []) {
      calls.push({ sql: sql.trim().replace(/\s+/g, ' '), params });
      if (/COUNT\(\*\) AS n/.test(sql)) return [{ n: String(legacyCount) }];
      return [];
    },
    async getAllSlugs() { return []; },
    async getPage() { return null; },
    async deleteFactsForPage() { return { deleted: 0 }; },
    async insertFacts() { return { inserted: 0, ids: [], warnings: [], deleted: 0 }; },
  } as unknown as BrainEngine;
  return { calls, engine };
}

function rollupCalls(calls: CapturedCall[]): CapturedCall[] {
  return calls.filter((c) => c.sql.includes('INSERT INTO extract_rollup_7d'));
}

describe('extract_facts rollup telemetry (#3683)', () => {
  test('guard-triggered run books halt_delta=1 for facts.fence', async () => {
    const { calls, engine } = mkEngine(3);
    const r = await runExtractFacts(engine, { slugs: [], sourceId: 'default' });
    expect(r.guardTriggered).toBe(true);

    const rollups = rollupCalls(calls);
    expect(rollups.length).toBe(1);
    // Param order: kind, source_id, day, cost, halts, evalFails, evalPasses, completed, failures.
    const p = rollups[0]!.params;
    expect(p[0]).toBe('facts.fence');
    expect(p[1]).toBe('default');
    expect(p[4]).toBe(1); // halt_delta
    expect(p[7]).toBe(0); // round_completed_delta
  });

  test('healthy run books round_completed_delta=1, halt_delta=0', async () => {
    const { calls, engine } = mkEngine(0);
    const r = await runExtractFacts(engine, { slugs: [], sourceId: 'default' });
    expect(r.guardTriggered).toBe(false);

    const rollups = rollupCalls(calls);
    expect(rollups.length).toBe(1);
    const p = rollups[0]!.params;
    expect(p[0]).toBe('facts.fence');
    expect(p[4]).toBe(0); // halt_delta
    expect(p[7]).toBe(1); // round_completed_delta
  });

  test('dry-run guard trigger books nothing', async () => {
    const { calls, engine } = mkEngine(3);
    const r = await runExtractFacts(engine, { slugs: [], sourceId: 'default', dryRun: true });
    expect(r.guardTriggered).toBe(true);
    expect(rollupCalls(calls).length).toBe(0);
  });
});
