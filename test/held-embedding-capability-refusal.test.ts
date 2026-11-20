/**
 * A brain whose engine keeps no page embedding ledger (the Rust engine) refuses the budget reads by name, and the two
 * user-facing callers say "unknown" instead of "no large page waits".
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: doctor `partial_embedding` reports health unknown (warn, `engine_capability_missing`) on that refusal, and
 *    `gbrain embed --stale` keeps its result, adds `budget_limited_unknown` and prints one line naming the refusal.
 *  - Regression: the doctor check turned the refusal into "Could not read …" (no capability named), and the embed note
 *    threw after the embed had already run, losing the run's result document.
 *  - Why existing coverage misses it: test/held-embedding-budgets.test.ts runs these callers on PGLite and Postgres,
 *    which never refuse; test/engine-parity/doctor-derived.test.ts pins the member's refusal, not its callers.
 *  - Seam: a stub engine whose budget read refuses as the Rust engine does (capabilityMissing); no database runs.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { noteBudgetLimited } from '../src/core/held-embedding.ts';
import { partialEmbeddingEntry } from '../src/commands/doctor/checks/content-quality.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

function refusingEngine(): BrainEngine {
  return {
    getConfigValues: async () => [],
    listBudgetLimitedRows: async () => { throw capabilityMissing('health', 'listBudgetLimitedRows'); },
    readBudgetHoldAge: async () => { throw capabilityMissing('health', 'readBudgetHoldAge'); },
  } as unknown as BrainEngine;
}

describe('page embedding budget reads refused by the engine', () => {
  test('doctor partial_embedding reports health unknown and names the capability', async () => {
    const ctx = { engine: refusingEngine(), progress: { heartbeat: () => undefined } } as unknown as DoctorContext;
    const ran = await partialEmbeddingEntry.run(ctx);
    if (!Array.isArray(ran)) throw new Error('partial_embedding returned no checks');
    const checks: Check[] = ran;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: 'partial_embedding', status: 'warn',
      details: { health: 'unknown', reason: 'engine_capability_missing', capability: 'health' },
    });
    expect(checks[0]!.message).toStartWith('Health unknown: ');
    expect(checks[0]!.message).toContain('listBudgetLimitedRows');
  });

  test('gbrain embed --stale keeps its result and names the refusal', async () => {
    const result: Record<string, unknown> = { embedded: 3 };
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await noteBudgetLimited(refusingEngine(), ['--stale'], result, false);
      expect(result.embedded).toBe(3);
      expect(result.budget_limited).toBeUndefined();
      expect(result.budget_limited_unknown).toMatchObject({ code: 'engine_capability_missing' });
      expect(String((result.budget_limited_unknown as { message: string }).message)).toContain('listBudgetLimitedRows');
      expect(log.mock.calls.map(c => String(c[0]))).toEqual([expect.stringContaining('[embed] Large pages held for embedding approval are unknown on this brain:')]);
    } finally {
      log.mockRestore();
    }
  });

  test('any other error still throws from the embed note', async () => {
    const engine = { getConfigValues: async () => [], listBudgetLimitedRows: async () => { throw new Error('boom'); } } as unknown as BrainEngine;
    await expect(noteBudgetLimited(engine, ['--stale'], {}, true)).rejects.toThrow('boom');
  });
});
