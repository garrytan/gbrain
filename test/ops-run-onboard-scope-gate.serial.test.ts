/**
 * A4 (test-gap wave 1) — run_onboard's protected-scope gate + max_usd cron cap.
 *
 * The protected-job filter operates on runAllOnboardChecks OUTPUT (that is
 * where extraRemediations come from), so that is what gets stubbed — NOT
 * computeRemediationPlan. All three deps are dynamic imports inside the
 * handler → mock.module → serial lane (isolation rule R2).
 *
 * Companion pin: 'run_protected_onboard' is deliberately absent from
 * ALLOWED_SCOPES_LIST — the grant branch is unreachable through OAuth today.
 * Making it grantable is a capability-model change (its own PR); this test
 * asserts the CURRENT unreachability so any change is a visible decision.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';

type Step = { id: string; job: string };

let checksBehavior: () => Promise<Array<{ remediations: Step[] }>> = async () => [];
let runRemediationCalls: Array<{ extraRemediations: Step[] }> = [];
let computePlanCalls = 0;

mock.module('../src/core/onboard/checks.ts', () => ({
  runAllOnboardChecks: async () => checksBehavior(),
}));
mock.module('../src/core/remediation/index.ts', () => ({
  computeRemediationPlan: async (_e: unknown, _o: unknown) => {
    computePlanCalls++;
    return { steps: [], score: 42 };
  },
  runRemediation: async (_e: unknown, opts: { extraRemediations: Step[] }) => {
    runRemediationCalls.push({ extraRemediations: opts.extraRemediations });
    return { submitted: opts.extraRemediations.map(r => r.id) };
  },
}));
mock.module('../src/core/onboard/render.ts', () => ({
  buildOnboardReport: (plan: unknown) => ({ report: 'stub', plan }),
}));

import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { ALLOWED_SCOPES_LIST } from '../src/core/scope.ts';
const run_onboard = operations.find(o => o.name === 'run_onboard')!;

function ctxOf(scopes: string[]): OperationContext {
  return {
    engine: { name: 'fake' } as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    auth: { scopes } as any,
  } as OperationContext;
}

const PROTECTED_STEP: Step = { id: 'r-synth', job: 'synthesize' };
const PLAIN_STEP: Step = { id: 'r-plain', job: 'embed-backfill' };

beforeEach(() => {
  checksBehavior = async () => [{ remediations: [PROTECTED_STEP, PLAIN_STEP] }];
  runRemediationCalls = [];
  computePlanCalls = 0;
});

describe('run_onboard protected-scope gate', () => {
  test("scopes=['admin']: protected job filtered into skipped_missing_scope, plain job submits", async () => {
    const res = await run_onboard.handler(ctxOf(['admin']), { mode: 'auto', max_usd: 1 }) as {
      submitted: string[];
      skipped_missing_scope: Array<{ id: string; job: string; reason: string }>;
    };
    expect(runRemediationCalls.length).toBe(1);
    expect(runRemediationCalls[0].extraRemediations.map(r => r.job)).toEqual(['embed-backfill']);
    expect(res.skipped_missing_scope).toEqual([
      { id: 'r-synth', job: 'synthesize', reason: 'requires run_protected_onboard scope' },
    ]);
    expect(res.submitted).toEqual(['r-plain']);
  });

  test("scopes=['admin','run_protected_onboard']: both submit, nothing skipped", async () => {
    const res = await run_onboard.handler(ctxOf(['admin', 'run_protected_onboard']), { mode: 'auto', max_usd: 1 }) as {
      skipped_missing_scope: unknown[];
    };
    expect(runRemediationCalls[0].extraRemediations.map(r => r.job).sort()).toEqual(['embed-backfill', 'synthesize']);
    expect(res.skipped_missing_scope).toEqual([]);
  });

  test("mode='auto' without max_usd → OperationError code invalid_params (cron-safety cap)", async () => {
    let thrown: unknown;
    try { await run_onboard.handler(ctxOf(['admin']), { mode: 'auto' }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(OperationError);
    expect((thrown as OperationError).code).toBe('invalid_params');
    expect(runRemediationCalls.length).toBe(0);
  });

  test("mode='check' never submits — plan + report only", async () => {
    const res = await run_onboard.handler(ctxOf(['admin']), {}) as { report: string };
    expect(res.report).toBe('stub');
    expect(computePlanCalls).toBe(1);
    expect(runRemediationCalls.length).toBe(0);
  });

  test('runAllOnboardChecks throwing fails OPEN: check mode still returns a report', async () => {
    checksBehavior = async () => { throw new Error('probe exploded'); };
    const res = await run_onboard.handler(ctxOf(['admin']), {}) as { report: string };
    expect(res.report).toBe('stub');
  });
});

describe('run_protected_onboard capability-model pin', () => {
  test('the scope is NOT grantable via ALLOWED_SCOPES_LIST (unreachable grant branch)', () => {
    // Changing this is a capability-model decision (IMPLIES,
    // assertAllowedScopes, OAuth client registration) — its own PR, never a
    // silent rider. This pin makes any change a visible test edit.
    expect(ALLOWED_SCOPES_LIST.includes('run_protected_onboard' as never)).toBe(false);
  });
});
