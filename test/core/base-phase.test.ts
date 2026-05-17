/**
 * v0.36.0.0 — BaseCyclePhase unit tests.
 *
 * Pure structural tests against a TestPhase subclass. No PGLite, no
 * mock.module, no real engine — just exercise the abstract base's
 * contract: source-scope threading, error envelope, budget meter
 * construction, dry-run propagation.
 */

import { describe, test, expect } from 'bun:test';
import { BaseCyclePhase, type ScopedReadOpts, type BasePhaseOpts } from '../../src/core/cycle/base-phase.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { CyclePhase } from '../../src/core/cycle.ts';

// ─── TestPhase fixture ──────────────────────────────────────────────
// A minimal concrete subclass we drive through run() to assert base behavior.

type CapturedCall = {
  scope: ScopedReadOpts;
  ctxSourceId: string | undefined;
  ctxAllowedSources: string[] | undefined;
  dryRun: boolean | undefined;
  engineKind: string;
};

class TestPhase extends BaseCyclePhase {
  // Cast to existing CyclePhase union via TS so the structural test stays
  // valid. Use 'calibration_profile' as a stand-in once v0.36 lands; for now
  // we just use 'lint' which is a known-good CyclePhase value.
  readonly name = 'lint' as CyclePhase;
  protected readonly budgetUsdKey = 'cycle.test_phase.budget_usd';
  protected readonly budgetUsdDefault = 1.0;

  // Pluggable hook so tests can vary the inner work.
  public onProcess: (args: {
    engine: BrainEngine;
    scope: ScopedReadOpts;
    ctx: OperationContext;
    opts: BasePhaseOpts;
  }) => Promise<{
    summary: string;
    details: Record<string, unknown>;
  }> = async ({ scope, ctx, opts }) => {
    captured.push({
      scope,
      ctxSourceId: (ctx as OperationContext & { sourceId?: string }).sourceId,
      ctxAllowedSources: ctx.auth?.allowedSources,
      dryRun: opts.dryRun,
      engineKind: 'mock',
    });
    return { summary: 'ok', details: { ran: true } };
  };

  protected async process(
    engine: BrainEngine,
    scope: ScopedReadOpts,
    ctx: OperationContext,
    opts: BasePhaseOpts,
  ): Promise<{ summary: string; details: Record<string, unknown> }> {
    return this.onProcess({ engine, scope, ctx, opts });
  }

  protected override mapErrorCode(err: unknown): string {
    if (err instanceof Error && err.message.startsWith('TEST_CODE:')) {
      return err.message.slice('TEST_CODE:'.length);
    }
    return super.mapErrorCode(err);
  }
}

const captured: CapturedCall[] = [];

function mockEngine(): BrainEngine {
  return { kind: 'pglite' } as unknown as BrainEngine;
}

function buildCtx(opts: {
  sourceId?: string;
  allowedSources?: string[];
} = {}): OperationContext {
  const ctx: OperationContext = {
    engine: mockEngine(),
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    // sourceId is REQUIRED on OperationContext (v0.34 D4); default to 'default'.
    // For the "neither sourceId nor allowedSources" test we leave it as 'default'
    // and don't set allowedSources — that yields scalar {sourceId: 'default'}.
    sourceId: opts.sourceId ?? 'default',
  };
  if (opts.allowedSources) {
    ctx.auth = { allowedSources: opts.allowedSources } as never;
  }
  return ctx;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('BaseCyclePhase', () => {
  describe('source-scope threading', () => {
    test('passes sourceId scope when ctx has scalar sourceId', async () => {
      captured.length = 0;
      const phase = new TestPhase();
      const ctx = buildCtx({ sourceId: 'tenant-a' });
      const result = await phase.run(ctx);
      expect(result.status).toBe('ok');
      expect(captured).toHaveLength(1);
      expect(captured[0]!.scope).toEqual({ sourceId: 'tenant-a' });
    });

    test('passes sourceIds federated array when ctx.auth.allowedSources is set', async () => {
      captured.length = 0;
      const phase = new TestPhase();
      const ctx = buildCtx({ allowedSources: ['tenant-a', 'tenant-b'] });
      await phase.run(ctx);
      expect(captured[0]!.scope).toEqual({ sourceIds: ['tenant-a', 'tenant-b'] });
    });

    test('federated array takes precedence over scalar sourceId', async () => {
      captured.length = 0;
      const phase = new TestPhase();
      const ctx = buildCtx({ sourceId: 'tenant-a', allowedSources: ['tenant-b', 'tenant-c'] });
      await phase.run(ctx);
      expect(captured[0]!.scope).toEqual({ sourceIds: ['tenant-b', 'tenant-c'] });
    });

    test('empty allowedSources array does NOT widen scope (returns scalar fallback)', async () => {
      // attacker-controlled `allowedSources: []` MUST NOT be treated as "all sources".
      captured.length = 0;
      const phase = new TestPhase();
      const ctx = buildCtx({ sourceId: 'tenant-a', allowedSources: [] });
      await phase.run(ctx);
      expect(captured[0]!.scope).toEqual({ sourceId: 'tenant-a' });
    });

    test('falls back to scalar default when neither explicit sourceId nor allowedSources is set', async () => {
      // Note: OperationContext.sourceId is REQUIRED post-v0.34 D4. The default
      // 'default' value is what `buildOperationContext` auto-fills for callers
      // who don't pass an explicit sourceId. Empty scope is unreachable through
      // the type system; verify the scalar path fires instead.
      captured.length = 0;
      const phase = new TestPhase();
      const ctx = buildCtx({});
      await phase.run(ctx);
      expect(captured[0]!.scope).toEqual({ sourceId: 'default' });
    });
  });

  describe('PhaseResult shape', () => {
    test('happy path returns status=ok with summary + details + duration_ms', async () => {
      const phase = new TestPhase();
      const ctx = buildCtx({ sourceId: 'tenant-a' });
      const result = await phase.run(ctx);
      expect(result.phase).toBe('lint');
      expect(result.status).toBe('ok');
      expect(result.summary).toBe('ok');
      expect(result.details).toEqual({ ran: true });
      expect(typeof result.duration_ms).toBe('number');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    test('thrown error is caught and converted to status=fail with PhaseError envelope', async () => {
      const phase = new TestPhase();
      phase.onProcess = async () => {
        throw new Error('TEST_CODE:GRADE_BUDGET_EXHAUSTED');
      };
      const ctx = buildCtx({ sourceId: 'tenant-a' });
      const result = await phase.run(ctx);
      expect(result.status).toBe('fail');
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('GRADE_BUDGET_EXHAUSTED');
      expect(result.error!.message).toBe('TEST_CODE:GRADE_BUDGET_EXHAUSTED');
      expect(result.details).toEqual({ error_code: 'GRADE_BUDGET_EXHAUSTED' });
    });

    test('thrown non-Error value is converted gracefully (no crash on String(...))', async () => {
      const phase = new TestPhase();
      phase.onProcess = async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'plain string failure';
      };
      const ctx = buildCtx({ sourceId: 'tenant-a' });
      const result = await phase.run(ctx);
      expect(result.status).toBe('fail');
      expect(result.error!.message).toBe('plain string failure');
    });
  });

  describe('dry-run propagation', () => {
    test('opts.dryRun is forwarded through to process()', async () => {
      captured.length = 0;
      const phase = new TestPhase();
      const ctx = buildCtx({ sourceId: 'tenant-a' });
      await phase.run(ctx, { dryRun: true });
      expect(captured[0]!.dryRun).toBe(true);
    });

    test('omitting opts.dryRun leaves it undefined (not coerced)', async () => {
      captured.length = 0;
      const phase = new TestPhase();
      const ctx = buildCtx({ sourceId: 'tenant-a' });
      await phase.run(ctx);
      expect(captured[0]!.dryRun).toBeUndefined();
    });
  });

  describe('budget meter construction', () => {
    test('resolves explicit opts.budgetUsd override', async () => {
      captured.length = 0;
      const phase = new TestPhase();
      phase.onProcess = async ({ }) => {
        // Inspect this.meter via untyped access (no public getter needed for the test).
        const meter = (phase as unknown as { meter?: { check: (e: unknown) => { budgetUsd: number } } }).meter;
        const check = meter?.check({
          modelId: 'claude-haiku-4-5',
          estimatedInputTokens: 1000,
          maxOutputTokens: 100,
        });
        return { summary: 'ok', details: { budgetUsd: check?.budgetUsd } };
      };
      const ctx = buildCtx({ sourceId: 'tenant-a' });
      const result = await phase.run(ctx, { budgetUsd: 5.0 });
      expect(result.details.budgetUsd).toBe(5.0);
    });

    test('falls back to budgetUsdDefault when no override and no config key', async () => {
      const phase = new TestPhase();
      phase.onProcess = async () => {
        const meter = (phase as unknown as { meter?: { check: (e: unknown) => { budgetUsd: number } } }).meter;
        const check = meter?.check({
          modelId: 'claude-haiku-4-5',
          estimatedInputTokens: 1000,
          maxOutputTokens: 100,
        });
        return { summary: 'ok', details: { budgetUsd: check?.budgetUsd } };
      };
      const ctx = buildCtx({ sourceId: 'tenant-a' });
      const result = await phase.run(ctx);
      // budgetUsdDefault = 1.0 on TestPhase
      expect(result.details.budgetUsd).toBe(1.0);
    });

    test('reads numeric config key when present', async () => {
      const phase = new TestPhase();
      phase.onProcess = async () => {
        const meter = (phase as unknown as { meter?: { check: (e: unknown) => { budgetUsd: number } } }).meter;
        const check = meter?.check({
          modelId: 'claude-haiku-4-5',
          estimatedInputTokens: 1000,
          maxOutputTokens: 100,
        });
        return { summary: 'ok', details: { budgetUsd: check?.budgetUsd } };
      };
      const ctx = {
        ...buildCtx({ sourceId: 'tenant-a' }),
        config: { 'cycle.test_phase.budget_usd': 7.25 },
      } as unknown as OperationContext;
      const result = await phase.run(ctx);
      expect(result.details.budgetUsd).toBe(7.25);
    });
  });
});
