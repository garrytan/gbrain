/**
 * v0.41.16.0 — Progressive-batch primitive unit tests.
 *
 * Pins every verdict branch of runProgressiveBatch (D3 fail-closed
 * budget, D20 discriminated verifier shapes, D21 honest jump-to-full,
 * stage-slicing, ramp-stage interactive abort, cost projection).
 *
 * Hermetic: no PGLite, no Postgres, no real LLM. Every BudgetTracker
 * is constructed inline; the AsyncLocalStorage scope is set via
 * `withBudgetTracker` from gateway.ts. Audit JSONL writes go to
 * `GBRAIN_AUDIT_DIR=<tempdir>` to isolate from the user's real audit
 * dir. We use `withEnv` from test/helpers/with-env.ts per CLAUDE.md
 * R1 (test-isolation lint).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
import {
  parseEnvStages,
  resolveStages,
  resolveCostCap,
  sliceIntoStages,
  awaitInteractiveAbort,
  runProgressiveBatch,
} from '../../src/core/progressive-batch/orchestrator.ts';
import { BudgetTracker } from '../../src/core/budget/budget-tracker.ts';
import { withBudgetTracker } from '../../src/core/ai/gateway.ts';
import type {
  Policy,
  StageReport,
  Verifier,
} from '../../src/core/progressive-batch/types.ts';

// Helper: build a NoopVerifier with optional sampleQuality.
function makeNoopVerifier(
  costPerItem = 0.001,
  sampleQuality?: () => Promise<{ ok: boolean; reasons?: string[] }>,
): Verifier {
  return {
    kind: 'noop',
    costPerItem: () => costPerItem,
    sampleQuality,
  };
}

// Helper: build an OutputCountVerifier backed by an in-memory counter.
function makeOutputCountVerifier(opts: {
  initial?: number;
  perItemRows?: number;
  qualityOk?: boolean;
  qualityReasons?: string[];
  costPerItem?: number;
}): { verifier: Verifier; bump: (n: number) => void } {
  let count = opts.initial ?? 0;
  const perItem = opts.perItemRows ?? 1;
  return {
    verifier: {
      kind: 'output_count',
      countBefore: async () => count,
      countAfter: async () => count,
      expectedDelta: (processed: number) => processed * perItem,
      sampleQuality: async () => ({
        ok: opts.qualityOk ?? true,
        reasons: opts.qualityReasons,
      }),
      costPerItem: () => opts.costPerItem ?? 0.001,
    },
    bump: (n: number) => {
      count += n;
    },
  };
}

// Helper: build an IdempotentMutationVerifier backed by an in-memory counter.
function makeIdempotentVerifier(opts: {
  qualityOk?: boolean;
  qualityReasons?: string[];
  mutationsPerItem?: number;
  costPerItem?: number;
}): { verifier: Verifier; bump: (n: number) => void; resetForStage: () => void } {
  let mutations = 0;
  const perItem = opts.mutationsPerItem ?? 1;
  return {
    verifier: {
      kind: 'idempotent_mutation',
      mutatedCount: async () => mutations,
      expectedMutations: (processed: number) => processed * perItem,
      sampleQuality: async () => ({
        ok: opts.qualityOk ?? true,
        reasons: opts.qualityReasons,
      }),
      costPerItem: () => opts.costPerItem ?? 0.001,
    },
    bump: (n: number) => {
      mutations += n;
    },
    resetForStage: () => {
      mutations = 0;
    },
  };
}

// Helper: collect stage reports the orchestrator emits.
function collectReports(): {
  onStageReport: (r: StageReport) => void;
  reports: StageReport[];
} {
  const reports: StageReport[] = [];
  return {
    onStageReport: (r) => {
      reports.push(r);
    },
    reports,
  };
}

// Use a per-test tempdir for audit writes via GBRAIN_AUDIT_DIR.
function makeAuditEnv(): Record<string, string> {
  return {
    GBRAIN_AUDIT_DIR: mkdtempSync(join(tmpdir(), 'pb-audit-')),
    GBRAIN_PROGRESSIVE_BATCH_AUTO: '1',
    GBRAIN_PROGRESSIVE_BATCH_DISABLED: undefined as unknown as string,
    GBRAIN_PROGRESSIVE_BATCH_STAGES: undefined as unknown as string,
  };
}

describe('parseEnvStages', () => {
  test('null on unset', () => {
    expect(parseEnvStages(undefined)).toBeNull();
  });
  test('null on empty/whitespace', () => {
    expect(parseEnvStages('')).toBeNull();
    expect(parseEnvStages('   ')).toBeNull();
  });
  test('parses canonical', () => {
    expect(parseEnvStages('10,100,500')).toEqual([10, 100, 500]);
  });
  test('rejects non-int', () => {
    expect(parseEnvStages('10,foo,500')).toBeNull();
  });
  test('rejects zero/negative', () => {
    expect(parseEnvStages('0,100,500')).toBeNull();
    expect(parseEnvStages('-1,100,500')).toBeNull();
  });
  test('trims whitespace per entry', () => {
    expect(parseEnvStages(' 10 , 100 , 500 ')).toEqual([10, 100, 500]);
  });
});

describe('resolveStages', () => {
  test('env override wins', async () => {
    await withEnv({ GBRAIN_PROGRESSIVE_BATCH_STAGES: '5,50,500' }, async () => {
      expect(resolveStages({ label: 't', stages: [10, 100, 500] })).toEqual([
        5, 50, 500,
      ]);
    });
  });
  test('policy when env unset', async () => {
    await withEnv({ GBRAIN_PROGRESSIVE_BATCH_STAGES: undefined as unknown as string }, async () => {
      expect(resolveStages({ label: 't', stages: [7, 70, 700] })).toEqual([
        7, 70, 700,
      ]);
    });
  });
  test('default when both unset', async () => {
    await withEnv({ GBRAIN_PROGRESSIVE_BATCH_STAGES: undefined as unknown as string }, async () => {
      expect(resolveStages({ label: 't' })).toEqual([10, 100, 500]);
    });
  });
});

describe('resolveCostCap (D3 fail-closed)', () => {
  test('opt-out + maxCostUsd returns policy cap', () => {
    expect(
      resolveCostCap(
        { label: 't', requireBudgetSafetyNet: false, maxCostUsd: 1 },
        null,
      ),
    ).toEqual({ capUsd: 1, source: 'policy' });
  });
  test('opt-out + no cap returns Infinity', () => {
    expect(
      resolveCostCap({ label: 't', requireBudgetSafetyNet: false }, null),
    ).toEqual({ capUsd: Infinity, source: 'uncapped' });
  });
  test('no tracker + no policy cap = NULL (fail-closed)', () => {
    expect(resolveCostCap({ label: 't' }, null)).toBeNull();
  });
  test('policy cap + no tracker returns policy', () => {
    expect(resolveCostCap({ label: 't', maxCostUsd: 2 }, null)).toEqual({
      capUsd: 2,
      source: 'policy',
    });
  });
  test('tracker + no policy cap returns tracker headroom', () => {
    const t = new BudgetTracker({ label: 'test', maxCostUsd: 5 });
    const r = resolveCostCap({ label: 't' }, t);
    expect(r?.capUsd).toBeCloseTo(5);
    expect(r?.source).toBe('tracker');
  });
  test('both set: lower wins', () => {
    const t = new BudgetTracker({ label: 'test', maxCostUsd: 10 });
    // policy is tighter
    const r1 = resolveCostCap({ label: 't', maxCostUsd: 3 }, t);
    expect(r1?.capUsd).toBe(3);
    expect(r1?.source).toBe('policy');
    // tracker is tighter
    const r2 = resolveCostCap({ label: 't', maxCostUsd: 100 }, t);
    expect(r2?.capUsd).toBeCloseTo(10);
    expect(r2?.source).toBe('min');
  });
});

describe('sliceIntoStages', () => {
  test('1000 items / canonical stages', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const s = sliceIntoStages(items, [10, 100, 500]);
    expect(s.trial.length).toBe(10);
    expect(s.ramp_100.length).toBe(100);
    expect(s.ramp_500.length).toBe(500);
    expect(s.full.length).toBe(390);
    // Disjoint + ordered
    expect(s.trial[0]).toBe(0);
    expect(s.ramp_100[0]).toBe(10);
    expect(s.ramp_500[0]).toBe(110);
    expect(s.full[0]).toBe(610);
  });
  test('50 items: ramp_100 takes remaining; 500 + full empty', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const s = sliceIntoStages(items, [10, 100, 500]);
    expect(s.trial.length).toBe(10);
    expect(s.ramp_100.length).toBe(40);
    expect(s.ramp_500.length).toBe(0);
    expect(s.full.length).toBe(0);
  });
  test('5 items: only trial', () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    const s = sliceIntoStages(items, [10, 100, 500]);
    expect(s.trial.length).toBe(5);
    expect(s.ramp_100.length).toBe(0);
    expect(s.ramp_500.length).toBe(0);
    expect(s.full.length).toBe(0);
  });
  test('disabled (stages=[]) dumps everything to full', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const s = sliceIntoStages(items, []);
    expect(s.trial.length).toBe(0);
    expect(s.ramp_100.length).toBe(0);
    expect(s.ramp_500.length).toBe(0);
    expect(s.full.length).toBe(100);
  });
});

describe('awaitInteractiveAbort', () => {
  test('ms=0 resolves false immediately', async () => {
    expect(await awaitInteractiveAbort(0)).toBe(false);
  });
  test('positive ms resolves false after timeout', async () => {
    const start = Date.now();
    const r = await awaitInteractiveAbort(50);
    expect(r).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});

describe('runProgressiveBatch — D3 fail-closed safety net', () => {
  test('NO tracker + NO Policy.maxCostUsd → abort_cost_cap reason=no_budget_safety_net', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const { onStageReport, reports } = collectReports();
      const result = await runProgressiveBatch(
        [1, 2, 3],
        makeNoopVerifier(),
        { label: 'd3-test', onStageReport },
        async (slice) => ({ succeeded: slice.length, failed: 0, costUsd: 0 }),
      );
      expect(result.abortedAt?.verdict).toBe('abort_cost_cap');
      expect(result.abortedAt?.reason).toBe('no_budget_safety_net');
      expect(result.itemsProcessed).toBe(0);
      expect(reports.length).toBe(1);
      expect(reports[0].verdict).toBe('abort_cost_cap');
      expect(reports[0].abortReason).toBe('no_budget_safety_net');
    });
  });
  test('Policy.requireBudgetSafetyNet=false bypasses the gate (Infinity cap)', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const { onStageReport, reports } = collectReports();
      const result = await runProgressiveBatch(
        [1, 2, 3],
        makeNoopVerifier(),
        {
          label: 'optout',
          onStageReport,
          requireBudgetSafetyNet: false,
        },
        async (slice) => ({ succeeded: slice.length, failed: 0, costUsd: 0 }),
      );
      expect(result.abortedAt).toBeUndefined();
      expect(result.itemsProcessed).toBe(3);
      // 3 items < trial(10) → only trial runs (the rest are empty
      // stages with no audit row).
      expect(reports.length).toBe(1);
      expect(reports[0].verdict).toBe('proceed');
    });
  });
  test('Tracker present + no Policy.maxCostUsd → tracker headroom wins', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const t = new BudgetTracker({ label: 'unit', maxCostUsd: 10 });
      await withBudgetTracker(t, async () => {
        const { onStageReport } = collectReports();
        const result = await runProgressiveBatch(
          [1, 2, 3],
          makeNoopVerifier(0.001),
          { label: 'tracker-test', onStageReport },
          async (slice) => ({
            succeeded: slice.length,
            failed: 0,
            costUsd: 0.003,
          }),
        );
        expect(result.abortedAt).toBeUndefined();
        expect(result.itemsProcessed).toBe(3);
      });
    });
  });
});

describe('runProgressiveBatch — verifier shapes (D20)', () => {
  test('OutputCountVerifier: matched delta proceeds', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const { verifier, bump } = makeOutputCountVerifier({ perItemRows: 1 });
      const result = await runProgressiveBatch(
        Array.from({ length: 5 }, (_, i) => i),
        verifier,
        { label: 'oc', maxCostUsd: 1 },
        async (slice) => {
          bump(slice.length);
          return { succeeded: slice.length, failed: 0, costUsd: 0 };
        },
      );
      expect(result.abortedAt).toBeUndefined();
      expect(result.itemsProcessed).toBe(5);
    });
  });
  test('OutputCountVerifier: zero delta → abort_count_mismatch', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const { verifier } = makeOutputCountVerifier({ perItemRows: 1 });
      const result = await runProgressiveBatch(
        Array.from({ length: 10 }, (_, i) => i),
        verifier,
        { label: 'oc-mismatch', maxCostUsd: 1 },
        async (slice) => ({
          // Runner reports success but verifier sees no new rows.
          succeeded: slice.length,
          failed: 0,
          costUsd: 0,
        }),
      );
      expect(result.abortedAt?.verdict).toBe('abort_count_mismatch');
      expect(result.abortedAt?.reason).toBe('count_delta_outside_band');
    });
  });
  test('IdempotentMutationVerifier: matched mutation count proceeds', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const { verifier, bump } = makeIdempotentVerifier({});
      const result = await runProgressiveBatch(
        Array.from({ length: 5 }, (_, i) => i),
        verifier,
        { label: 'im', maxCostUsd: 1 },
        async (slice) => {
          bump(slice.length);
          return { succeeded: slice.length, failed: 0, costUsd: 0 };
        },
      );
      expect(result.abortedAt).toBeUndefined();
    });
  });
  test('NoopVerifier: only cost + error rate gating', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const result = await runProgressiveBatch(
        Array.from({ length: 5 }, (_, i) => i),
        makeNoopVerifier(),
        { label: 'np', maxCostUsd: 1 },
        async (slice) => ({ succeeded: slice.length, failed: 0, costUsd: 0 }),
      );
      expect(result.abortedAt).toBeUndefined();
      expect(result.itemsProcessed).toBe(5);
    });
  });
  test('NoopVerifier with sampleQuality returning not-ok → abort_data_quality', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const result = await runProgressiveBatch(
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        makeNoopVerifier(0.001, async () => ({
          ok: false,
          reasons: ['bad row 7'],
        })),
        { label: 'np-bad-quality', maxCostUsd: 1 },
        async (slice) => ({ succeeded: slice.length, failed: 0, costUsd: 0 }),
      );
      expect(result.abortedAt?.verdict).toBe('abort_data_quality');
      expect(result.abortedAt?.reason).toBe('data_quality_sample_failed');
      const trial = result.stageReports[0];
      expect(trial.qualityReasons).toEqual(['bad row 7']);
    });
  });
});

describe('runProgressiveBatch — error rate + cost cap gates', () => {
  test('error rate > maxErrorRate → abort_error_rate', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const result = await runProgressiveBatch(
        Array.from({ length: 10 }, (_, i) => i),
        makeNoopVerifier(),
        { label: 'er', maxCostUsd: 1, maxErrorRate: 0.1 },
        async (slice) => ({
          // 50% fail rate, well over the 10% threshold.
          succeeded: Math.floor(slice.length / 2),
          failed: Math.ceil(slice.length / 2),
          costUsd: 0,
        }),
      );
      expect(result.abortedAt?.verdict).toBe('abort_error_rate');
      expect(result.abortedAt?.reason).toBe('error_rate_exceeded');
    });
  });
  test('cost projection > cap → abort_cost_cap', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const result = await runProgressiveBatch(
        Array.from({ length: 1000 }, (_, i) => i),
        makeNoopVerifier(),
        { label: 'cc', maxCostUsd: 0.5 },
        async (slice) => ({
          // $0.01/item → 10 items = $0.10 in trial, projected
          // 1000-item run = $10.00 ≫ $0.50 cap.
          succeeded: slice.length,
          failed: 0,
          costUsd: slice.length * 0.01,
        }),
      );
      expect(result.abortedAt?.verdict).toBe('abort_cost_cap');
      expect(result.abortedAt?.reason).toBe('cost_projected_over_cap');
      // Trial stage should have processed 10; cumulative cost should be 0.10.
      expect(result.itemsProcessed).toBe(10);
      expect(result.totalCostUsd).toBeCloseTo(0.1);
    });
  });
});

describe('runProgressiveBatch — D21 honest behavior preservation', () => {
  test('GBRAIN_PROGRESSIVE_BATCH_DISABLED=1 skips ramp; goes to full', async () => {
    await withEnv(
      {
        ...makeAuditEnv(),
        GBRAIN_PROGRESSIVE_BATCH_DISABLED: '1',
      },
      async () => {
        const { onStageReport, reports } = collectReports();
        const result = await runProgressiveBatch(
          Array.from({ length: 100 }, (_, i) => i),
          makeNoopVerifier(),
          { label: 'disabled', maxCostUsd: 1, onStageReport },
          async (slice) => ({
            succeeded: slice.length,
            failed: 0,
            costUsd: 0,
          }),
        );
        expect(result.abortedAt).toBeUndefined();
        expect(result.itemsProcessed).toBe(100);
        // Only the 'full' stage report should be emitted.
        expect(reports.length).toBe(1);
        expect(reports[0].stage).toBe('full');
        expect(reports[0].itemsInStage).toBe(100);
      },
    );
  });
  test('interactiveAbortMs=0 → no Ctrl-C wait between stages', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const start = Date.now();
      const result = await runProgressiveBatch(
        Array.from({ length: 120 }, (_, i) => i),
        makeNoopVerifier(),
        { label: 'noramp', maxCostUsd: 1, interactiveAbortMs: 0 },
        async (slice) => ({ succeeded: slice.length, failed: 0, costUsd: 0 }),
      );
      expect(result.abortedAt).toBeUndefined();
      // Should run quickly without any 10s waits between stages.
      expect(Date.now() - start).toBeLessThan(500);
    });
  });
});

describe('runProgressiveBatch — onStageReport caller abort', () => {
  test('caller returns {abort:true} after trial → abort_explicit', async () => {
    await withEnv(makeAuditEnv(), async () => {
      let calls = 0;
      const result = await runProgressiveBatch(
        Array.from({ length: 100 }, (_, i) => i),
        makeNoopVerifier(),
        {
          label: 'explicit-abort',
          maxCostUsd: 1,
          onStageReport: (r) => {
            calls++;
            if (r.stage === 'trial') return { abort: true };
            return undefined;
          },
        },
        async (slice) => ({ succeeded: slice.length, failed: 0, costUsd: 0 }),
      );
      expect(result.abortedAt?.verdict).toBe('abort_explicit');
      expect(result.abortedAt?.reason).toBe('caller_signaled_abort');
      // Trial completed but caller signaled abort.
      expect(result.itemsProcessed).toBe(10);
      expect(calls).toBe(1);
    });
  });
});

describe('runProgressiveBatch — multi-stage success path', () => {
  test('1000 items: trial(10) → ramp_100 → ramp_500 → full(380); all stages reported', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const { onStageReport, reports } = collectReports();
      const result = await runProgressiveBatch(
        Array.from({ length: 1000 }, (_, i) => i),
        makeNoopVerifier(),
        { label: 'multi', maxCostUsd: 100, onStageReport },
        async (slice) => ({ succeeded: slice.length, failed: 0, costUsd: 0 }),
      );
      expect(result.abortedAt).toBeUndefined();
      expect(result.itemsProcessed).toBe(1000);
      expect(result.stagesCompleted).toEqual(['trial', 'ramp_100', 'ramp_500', 'full']);
      // Four stage reports (one per stage; the full stage processes 380).
      expect(reports).toHaveLength(4);
      expect(reports[0].stage).toBe('trial');
      expect(reports[0].itemsInStage).toBe(10);
      expect(reports[1].stage).toBe('ramp_100');
      expect(reports[1].itemsInStage).toBe(100);
      expect(reports[2].stage).toBe('ramp_500');
      expect(reports[2].itemsInStage).toBe(500);
      expect(reports[3].stage).toBe('full');
      expect(reports[3].itemsInStage).toBe(390);
      // Cumulative processed reaches 1000 by the last stage.
      expect(reports[3].itemsProcessedCumulative).toBe(1000);
      // All verdicts are proceed.
      expect(reports.every((r) => r.verdict === 'proceed')).toBe(true);
    });
  });

  test('IdempotentMutationVerifier: matched mutation count across stages', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const { verifier, bump, resetForStage } = makeIdempotentVerifier({});
      void resetForStage;
      const result = await runProgressiveBatch(
        Array.from({ length: 25 }, (_, i) => i),
        verifier,
        { label: 'multi-im', maxCostUsd: 1 },
        async (slice) => {
          bump(slice.length);
          return { succeeded: slice.length, failed: 0, costUsd: 0 };
        },
      );
      expect(result.abortedAt).toBeUndefined();
      expect(result.itemsProcessed).toBe(25);
    });
  });

  test('IdempotentMutationVerifier: mutation count off → abort_mutation_mismatch', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const { verifier } = makeIdempotentVerifier({});
      // Runner claims success but never bumps the mutation counter.
      const result = await runProgressiveBatch(
        Array.from({ length: 10 }, (_, i) => i),
        verifier,
        { label: 'im-mm', maxCostUsd: 1 },
        async (slice) => ({ succeeded: slice.length, failed: 0, costUsd: 0 }),
      );
      expect(result.abortedAt?.verdict).toBe('abort_mutation_mismatch');
      expect(result.abortedAt?.reason).toBe('mutation_count_outside_band');
    });
  });

  test('cumulative cost crosses cap mid-multi-stage → abort_cost_cap', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const result = await runProgressiveBatch(
        Array.from({ length: 200 }, (_, i) => i),
        makeNoopVerifier(),
        { label: 'cc-mid', maxCostUsd: 0.05 },
        async (slice) => ({
          // Trial: 10 items × $0.001 = $0.01 cumulative; projected
          // 200 × $0.001 = $0.20 ≫ $0.05 cap.
          succeeded: slice.length,
          failed: 0,
          costUsd: slice.length * 0.001,
        }),
      );
      expect(result.abortedAt?.verdict).toBe('abort_cost_cap');
      expect(result.abortedAt?.reason).toBe('cost_projected_over_cap');
    });
  });
});

describe('runProgressiveBatch — degenerate inputs', () => {
  test('empty item list runs no stages but reports the run happened', async () => {
    await withEnv(makeAuditEnv(), async () => {
      const { onStageReport, reports } = collectReports();
      const result = await runProgressiveBatch(
        [] as number[],
        makeNoopVerifier(),
        { label: 'empty', maxCostUsd: 1, onStageReport },
        async () => ({ succeeded: 0, failed: 0, costUsd: 0 }),
      );
      expect(result.abortedAt).toBeUndefined();
      expect(result.itemsProcessed).toBe(0);
      // We DO emit one report for the zero-item full stage so audit
      // shows the run was attempted.
      expect(reports.length).toBe(1);
      expect(reports[0].stage).toBe('full');
      expect(reports[0].verdict).toBe('proceed');
    });
  });
});
