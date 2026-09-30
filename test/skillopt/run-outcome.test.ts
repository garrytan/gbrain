/**
 * #5584 — truthful outcome, remediation, output caps and resume correctness
 * (pure helpers; the orchestrator wiring is pinned in
 * test/e2e/skillopt-outcome.serial.test.ts).
 */

import { describe, expect, test } from 'bun:test';
import {
  clampRemoteReflectMaxTokens,
  resolveReflectMaxTokens,
  skilloptOutputCap,
} from '../../src/core/skillopt/output-cap.ts';
import {
  buildRemediation,
  errorCode,
  recordReflectError,
  SKILLOPT_REMEDIATION_CODES,
} from '../../src/core/skillopt/remediation.ts';
import {
  buildResumeCommand,
  recordOptimizerStep,
  resolveRunOutcome,
  shouldEarlyStop,
} from '../../src/core/skillopt/run-outcome.ts';
import {
  advanceCursor,
  assertResumeCompatible,
  rewindCursor,
  emptyTally,
  resumeCursor,
  type RunCheckpoint,
  type RunSpec,
} from '../../src/core/skillopt/checkpoint.ts';
import { formatRunSummary, parseFlags } from '../../src/commands/skillopt.ts';
import type { RunReceipt } from '../../src/core/skillopt/types.ts';
import { KNOWN_CONFIG_KEYS } from '../../src/core/config.ts';
import { isSkilloptMustAbort } from '../../src/core/skillopt/must-abort.ts';
import { invokeAI, withAIInvocationGuard } from '../../src/core/ai/invocation-guard.ts';

const THINKING = 'anthropic:claude-opus-5';
const PLAIN = 'anthropic:claude-sonnet-4-6';

function fakeEngine(value: string | null) {
  return { getConfig: async () => value };
}

describe('skilloptOutputCap (judge / bootstrap headroom)', () => {
  test('Claude 5 judge gets the 8192 thinking floor; non-thinking keeps the site cap', () => {
    expect(skilloptOutputCap(THINKING, 200)).toBe(8192);
    expect(skilloptOutputCap(PLAIN, 200)).toBe(200);
    expect(skilloptOutputCap(THINKING, 10_000)).toBe(10_000);
  });
});

describe('reflect cap resolution (flag > config > default)', () => {
  test('skillopt.reflect_max_tokens is a registered config key (config set accepts it without --force)', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('skillopt.reflect_max_tokens');
  });

  test('default is 32000 for thinking optimizers, 4096 otherwise', async () => {
    expect(await resolveReflectMaxTokens(fakeEngine(null), THINKING)).toEqual({ maxTokens: 32000, source: 'default' });
    expect(await resolveReflectMaxTokens(fakeEngine(null), PLAIN)).toEqual({ maxTokens: 4096, source: 'default' });
  });

  test('config is honored exactly, including below the default', async () => {
    expect(await resolveReflectMaxTokens(fakeEngine('1500'), THINKING)).toEqual({ maxTokens: 1500, source: 'config' });
  });

  test('explicit value beats config', async () => {
    expect(await resolveReflectMaxTokens(fakeEngine('1500'), THINKING, 9000)).toEqual({ maxTokens: 9000, source: 'flag' });
  });

  test('invalid config value falls back to the default', async () => {
    expect(await resolveReflectMaxTokens(fakeEngine('lots'), PLAIN)).toEqual({ maxTokens: 4096, source: 'default' });
    expect(await resolveReflectMaxTokens(fakeEngine('-5'), PLAIN)).toEqual({ maxTokens: 4096, source: 'default' });
  });

  test('unreadable config falls back to the default', async () => {
    const throwing = { getConfig: async (): Promise<string | null> => { throw new Error('db down'); } };
    expect(await resolveReflectMaxTokens(throwing, THINKING)).toEqual({ maxTokens: 32000, source: 'default' });
  });

  test('remote values are validated and clamped to [256, 32000]', () => {
    expect(clampRemoteReflectMaxTokens(undefined)).toBeUndefined();
    expect(clampRemoteReflectMaxTokens(10_000_000)).toBe(32000);
    expect(clampRemoteReflectMaxTokens(1)).toBe(256);
    expect(clampRemoteReflectMaxTokens(8000)).toBe(8000);
    expect(() => clampRemoteReflectMaxTokens(-1)).toThrow(/positive integer/);
    expect(() => clampRemoteReflectMaxTokens(1.5)).toThrow(/positive integer/);
    expect(() => clampRemoteReflectMaxTokens('abc')).toThrow(/positive integer/);
  });
});

describe('remediation', () => {
  test('Object.prototype keys are not remediation codes', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(errorCode(`${k}: boom`)).toBeUndefined();
      expect(buildRemediation([`${k}: boom`])).toEqual([]);
    }
  });

  test('every emitted code class maps to a remediation entry with a docs anchor', () => {
    const emitted = [
      'reflect_failure_truncated: 2048 output tokens, max_tokens=2048',
      'reflect_success_empty_reply: stop=end',
      'reflect_failure_no_parseable_edits: 12 output tokens, stop=end',
      'reflect_failure_invalid_edits: 2 proposed, 0 valid',
      'reflect_failure_context_too_small: need 1, window 0',
      'reflect_failure_context_overflow: prompt is too long',
      'reflect_failure_failed: 500',
      'one_shot_rewrite_truncated: 1 output tokens, max_tokens=1',
      'one_shot_rewrite_output_cap_too_small: need ~1 tokens, cap 1; set skillopt.reflect_max_tokens',
      'one_shot_rewrite_body_truncated: sent 0 of 1 chars',
      'one_shot_rewrite_empty_reply: stop=end',
      'one_shot_rewrite_failed: boom',
      'reservation_exceeds_cap',
    ];
    const entries = buildRemediation(emitted, 'budget_exhausted');
    const codes = entries.map((e) => e.code);
    expect(new Set(codes)).toEqual(new Set(SKILLOPT_REMEDIATION_CODES.filter((c) => c !== 'runtime_exceeded')));
    for (const e of entries) {
      expect(e.docs).toBe(`docs/guides/skillopt.md#${e.code}`);
      expect(e.fix.length).toBeGreaterThan(10);
    }
    expect(entries.find((e) => e.code === 'reflect_truncated')!.fix).toContain('--reflect-max-tokens');
    expect(entries.find((e) => e.code === 'reflect_invalid_edits')!.fix).toContain('--optimizer-model');
    const budget = entries.find((e) => e.code === 'budget_exhausted')!.fix;
    expect(budget).toContain('--max-cost-usd');
    expect(budget).toContain('cycle.skillopt.per_skill_cap_usd');
  });

  test('one entry per distinct code (both reflect modes collapse); abort_detail prefix unwrapped', () => {
    const entries = buildRemediation([
      'reflect_failure_truncated: a',
      'reflect_success_truncated: b',
      'optimizer_output_unusable: reflect_failure_truncated: a',
    ]);
    expect(entries.map((e) => e.code)).toEqual(['reflect_truncated']);
    expect(errorCode('something unrelated: x')).toBeUndefined();
  });

  test('receipt error list is deduped and capped (20 x 300 chars)', () => {
    const list: string[] = [];
    recordReflectError(list, 'dup');
    recordReflectError(list, 'dup');
    recordReflectError(list, 'x'.repeat(500));
    expect(list).toEqual(['dup', 'x'.repeat(300)]);
    for (let i = 0; i < 30; i++) recordReflectError(list, `e${i}`);
    expect(list).toHaveLength(20);
  });
});

describe('outcome precedence + early stop', () => {
  const unusable = (err: string) => ({ calls: 2, usableReplies: 0, errors: [err, err], invalidEditsDropped: 0 });
  const usable = { calls: 2, usableReplies: 1, errors: ['reflect_success_truncated: x'], invalidEditsDropped: 1 };

  test('early stop after 2 consecutive fully-unusable steps of ANY class; usable step resets', () => {
    const t = emptyTally();
    expect(recordOptimizerStep(t, unusable('reflect_failure_truncated: a'))).toBe(true);
    expect(shouldEarlyStop(t)).toBe(false);
    recordOptimizerStep(t, usable);
    expect(t.unusable_streak).toBe(0);
    recordOptimizerStep(t, unusable('reflect_failure_truncated: a'));
    recordOptimizerStep(t, unusable('reflect_failure_invalid_edits: 2 proposed, 0 valid'));
    expect(shouldEarlyStop(t)).toBe(true);
    expect(t.invalid_edits_dropped).toBe(1);
  });

  test('a step with no optimizer calls neither counts nor resets the streak', () => {
    const t = emptyTally();
    recordOptimizerStep(t, unusable('reflect_failure_truncated: a'));
    expect(recordOptimizerStep(t, { calls: 0, usableReplies: 0, errors: [], invalidEditsDropped: 0 })).toBe(false);
    expect(t.unusable_streak).toBe(1);
  });

  test('mixed classes, all unusable -> errored optimizer_output_unusable with the first error', () => {
    const t = emptyTally();
    recordOptimizerStep(t, unusable('reflect_failure_truncated: 2048 output tokens, max_tokens=2048'));
    recordOptimizerStep(t, unusable('reflect_failure_no_parseable_edits: 3 output tokens, stop=end'));
    const r = resolveRunOutcome({ tally: t, earlyStopped: true });
    expect(r).toEqual({
      outcome: 'errored',
      stopReason: 'early_stop_unusable_output',
      abortReason: 'error',
      abortDetail: 'optimizer_output_unusable: reflect_failure_truncated: 2048 output tokens, max_tokens=2048',
    });
  });

  test('accepted step then early stop -> accepted (acceptance history wins)', () => {
    const t = emptyTally();
    recordOptimizerStep(t, { calls: 1, usableReplies: 1, errors: [], invalidEditsDropped: 0 });
    t.accepted_steps = 1;
    recordOptimizerStep(t, unusable('reflect_success_truncated: a'));
    recordOptimizerStep(t, unusable('reflect_success_truncated: a'));
    expect(resolveRunOutcome({ tally: t, earlyStopped: true })).toEqual({ outcome: 'accepted', stopReason: 'early_stop_unusable_output' });
  });

  test('one usable reply -> no_improvement; zero optimizer calls -> no_improvement', () => {
    const t = emptyTally();
    recordOptimizerStep(t, usable);
    expect(resolveRunOutcome({ tally: t, earlyStopped: false }).outcome).toBe('no_improvement');
    expect(resolveRunOutcome({ tally: emptyTally(), earlyStopped: false }).outcome).toBe('no_improvement');
  });

  test('caught abort wins over everything', () => {
    const t = emptyTally();
    t.accepted_steps = 1;
    const r = resolveRunOutcome({ tally: t, earlyStopped: false, caught: { outcome: 'aborted', abortReason: 'budget_exhausted', abortDetail: 'cap' } });
    expect(r).toEqual({ outcome: 'aborted', stopReason: 'aborted', abortReason: 'budget_exhausted', abortDetail: 'cap' });
  });
});

const SPEC: RunSpec = {
  skills_dir: '/tmp/my skills',
  benchmark_path: '/tmp/my skills/demo/skillopt-benchmark.jsonl',
  benchmark_sha8: 'aaaa1111',
  held_out_path: null,
  held_out_sha8: null,
  split: [4, 1, 5],
  mutate: false,
  no_mutate: true,
  allow_mutate_bundled: false,
  bootstrap_reviewed: false,
  optimizer_model: THINKING,
  target_model: PLAIN,
  judge_model: PLAIN,
  epochs: 2,
  batch_size: 4,
  lr: 4,
  lr_schedule: 'cosine',
  reflect_max_tokens: 32000,
};

function checkpoint(over: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    schema: 1, run_id: 'run-1', skill: 'demo', skill_sha8: 's', benchmark_sha8: SPEC.benchmark_sha8,
    optimizer_model: THINKING, target_model: PLAIN, judge_model: PLAIN, epochs: 2, batch_size: 4, lr: 4,
    lr_schedule: 'cosine', best_sel_score: 0.5, best_skill_text: 'x', last_completed_epoch: 0,
    last_completed_step: 0, cumulative_cost_usd: 0, started_at: '', last_updated_at: '', ...over,
  };
}

describe('resume cursor', () => {
  test('legacy checkpoints convert: step 0 / full epoch -> next epoch, else same epoch next step', () => {
    expect(resumeCursor(checkpoint({ last_completed_epoch: 1, last_completed_step: 0 }), 5)).toEqual({ epoch: 2, step: 1 });
    expect(resumeCursor(checkpoint({ last_completed_epoch: 1, last_completed_step: 5 }), 5)).toEqual({ epoch: 2, step: 1 });
    expect(resumeCursor(checkpoint({ last_completed_epoch: 1, last_completed_step: 2 }), 5)).toEqual({ epoch: 1, step: 3 });
    expect(resumeCursor(checkpoint(), 5)).toEqual({ epoch: 1, step: 1 });
  });

  test('advanceCursor moves past a completed step, rolling to the next epoch at the end', () => {
    const cp = checkpoint();
    advanceCursor(cp, 1, 2, 5);
    expect(resumeCursor(cp, 5)).toEqual({ epoch: 1, step: 3 });
    expect(cp.last_completed_epoch).toBe(0);
    advanceCursor(cp, 1, 5, 5);
    expect(resumeCursor(cp, 5)).toEqual({ epoch: 2, step: 1 });
    expect(cp.last_completed_epoch).toBe(1);
  });
});

describe('resume spec refusal', () => {
  const stored = checkpoint({ run_spec: SPEC });

  test('changed benchmark / held-out / split / target / batch size refused naming the field', () => {
    for (const [field, value] of [
      ['benchmark_sha8', 'bbbb2222'], ['held_out_sha8', 'cccc3333'], ['split', [1, 1, 1]],
      ['target_model', 'openai:gpt-4o'], ['judge_model', 'openai:gpt-4o'], ['batch_size', 8],
    ] as const) {
      expect(() => assertResumeCompatible(stored, { ...SPEC, [field]: value } as RunSpec)).toThrow(new RegExp(`${field} changed`));
    }
  });

  test('mutate widening (no-mutate -> mutate) refused; narrowing allowed', () => {
    expect(() => assertResumeCompatible(stored, { ...SPEC, mutate: true, no_mutate: false })).toThrow(/mutate policy changed/);
    expect(() => assertResumeCompatible(checkpoint({ run_spec: { ...SPEC, mutate: true } }), SPEC)).not.toThrow();
  });

  test('optimizer model, reflect cap and epochs may change', () => {
    expect(() => assertResumeCompatible(stored, { ...SPEC, optimizer_model: 'openai:gpt-5', reflect_max_tokens: 64000, epochs: 4 })).not.toThrow();
  });

  test('legacy checkpoint without a spec still refuses a changed benchmark', () => {
    expect(() => assertResumeCompatible(checkpoint(), { ...SPEC, benchmark_sha8: 'bbbb2222' })).toThrow(/benchmark_sha8 changed/);
    expect(() => assertResumeCompatible(checkpoint(), SPEC)).not.toThrow();
  });
});

describe('rewindCursor', () => {
  test('steps back across epoch boundaries and never before the first step', () => {
    expect(rewindCursor({ epoch: 1, step: 4 }, 2, 10)).toEqual({ epoch: 1, step: 2 });
    expect(rewindCursor({ epoch: 2, step: 1 }, 2, 10)).toEqual({ epoch: 1, step: 9 });
    expect(rewindCursor({ epoch: 2, step: 1 }, 1, 1)).toEqual({ epoch: 1, step: 1 });
    expect(rewindCursor({ epoch: 1, step: 2 }, 5, 10)).toEqual({ epoch: 1, step: 1 });
    expect(rewindCursor({ epoch: 3, step: 2 }, 0, 10)).toEqual({ epoch: 3, step: 2 });
  });
});

describe('resume command', () => {
  test('rebuilt from the stored spec; truncation doubles the cap; paths quoted', () => {
    const cmd = buildResumeCommand('demo', 'run-1', SPEC, 'reflect_truncated');
    expect(cmd).toStartWith('gbrain skillopt demo --resume run-1 ');
    expect(cmd).toContain(`--skills-dir '/tmp/my skills'`);
    expect(cmd).toContain(`--benchmark '/tmp/my skills/demo/skillopt-benchmark.jsonl'`);
    expect(cmd).toContain('--split 4:1:5 --epochs 2 --batch-size 4 --lr 4 --lr-schedule cosine');
    expect(cmd).toContain(`--optimizer-model ${THINKING}`);
    expect(cmd).toContain('--reflect-max-tokens 64000');
    expect(cmd).toContain('--no-mutate');
  });

  test('contract class swaps in an --optimizer-model placeholder; other failures keep the cap', () => {
    const cmd = buildResumeCommand('demo', 'run-1', SPEC, 'reflect_invalid_edits');
    // Quoted, so pasting the command never turns the placeholder into a shell redirection.
    expect(cmd).toContain(`--optimizer-model '<other-model>'`);
    expect(cmd).not.toContain(THINKING);
    expect(buildResumeCommand('demo', 'run-1', SPEC)).toContain('--reflect-max-tokens 32000');
  });

  test('only output-cap failures double the cap; a context-window failure keeps it', () => {
    expect(buildResumeCommand('demo', 'run-1', SPEC, 'one_shot_rewrite_truncated')).toContain('--reflect-max-tokens 64000');
    expect(buildResumeCommand('demo', 'run-1', SPEC, 'one_shot_rewrite_output_cap_too_small')).toContain('--reflect-max-tokens 64000');
    // The output cap shares the context window, so doubling it would make a
    // body-too-large refusal certain again.
    expect(buildResumeCommand('demo', 'run-1', SPEC, 'one_shot_rewrite_body_truncated')).toContain('--reflect-max-tokens 32000');
    expect(buildResumeCommand('demo', 'run-1', SPEC, 'reflect_context_too_small')).toContain('--reflect-max-tokens 32000');
  });

  test('carries the run mode, cost cap and runtime cap', () => {
    const capped = buildResumeCommand('demo', 'run-1', SPEC, undefined, { mode: 'rewrite', maxCostUsd: 20, maxRuntimeMin: 45 });
    expect(capped).toContain('--rewrite --max-cost-usd 20 --max-runtime-min 45');
    const uncapped = buildResumeCommand('demo', 'run-1', SPEC, undefined, { mode: 'patch', maxCostUsd: 0, maxRuntimeMin: 30 });
    expect(uncapped).toContain('--no-max-cost --max-runtime-min 30');
    expect(uncapped).not.toContain('--rewrite');
    expect(uncapped).not.toContain('--max-cost-usd');
    expect(uncapped).not.toContain('--force');
    expect(uncapped).not.toContain('--models-strict');
    const forced = buildResumeCommand('demo', 'run-1', SPEC, undefined, { mode: 'patch', maxCostUsd: 5, maxRuntimeMin: 30, force: true, modelsStrict: true });
    expect(forced).toEndWith('--max-runtime-min 30 --force --models-strict');
  });

  test('optional spec flags and shell quoting of quotes and control characters', () => {
    const cmd = buildResumeCommand('demo', 'run-1', {
      ...SPEC,
      held_out_path: "/tmp/it's\nheld.jsonl",
      allow_mutate_bundled: true,
      bootstrap_reviewed: true,
    });
    expect(cmd).toContain(`--held-out '/tmp/it'\\''sheld.jsonl'`);
    expect(cmd).toContain('--allow-mutate-bundled --bootstrap-reviewed');
    expect(cmd).not.toContain('\n');
  });
});

describe('CLI', () => {
  test('--reflect-max-tokens parses a positive integer and rejects anything else', () => {
    expect(parseFlags(['demo', '--reflect-max-tokens', '12000']).reflectMaxTokens).toBe(12000);
    expect(parseFlags(['demo']).reflectMaxTokens).toBeUndefined();
    for (const bad of ['0', '-3', '1.5', 'many']) {
      expect(() => parseFlags(['demo', '--reflect-max-tokens', bad])).toThrow(/--reflect-max-tokens requires a positive integer/);
    }
  });

  test('errored summary names the warning, the fix, the run id, the checkpoint and the resume command', () => {
    const receipt = {
      run_id: 'run-1', skill: 'demo', outcome: 'errored', abort_reason: 'error',
      abort_detail: 'optimizer_output_unusable: reflect_failure_truncated: 32000 output tokens, max_tokens=32000',
      stop_reason: 'early_stop_unusable_output',
      reflect_errors: ['reflect_failure_truncated: 32000 output tokens, max_tokens=32000'],
      remediation: buildRemediation(['reflect_failure_truncated: x']),
      reflect_max_tokens: 32000,
      resume_command: 'gbrain skillopt demo --resume run-1 --reflect-max-tokens 64000',
    } as RunReceipt;
    const out = formatRunSummary('errored', receipt, '/tmp/skills');
    expect(out).toContain('[skillopt] Outcome: errored');
    expect(out).toContain('[skillopt] Detail: optimizer_output_unusable: reflect_failure_truncated');
    expect(out).toContain('[skillopt] Warning: 1 optimizer reply error(s) (optimizer output cap 32000)');
    expect(out).toContain('[skillopt] Fix (reflect_truncated): ');
    expect(out).toContain('docs/guides/skillopt.md#reflect_truncated');
    expect(out).toContain('[skillopt] Stopped early');
    expect(out).toContain('[skillopt] Run id: run-1');
    expect(out).toContain('[skillopt] Checkpoint: /tmp/skills/demo/skillopt/checkpoint-run-1.json');
    expect(out).toContain('[skillopt] Resume: gbrain skillopt demo --resume run-1 --reflect-max-tokens 64000');
  });

  test('a clean no_improvement summary prints no warnings', () => {
    const out = formatRunSummary('no_improvement', { run_id: 'r', skill: 'demo' } as RunReceipt, '/tmp/skills');
    expect(out).toBe('[skillopt] Outcome: no_improvement\n');
  });
});

describe('must-abort', () => {
  test('an AI spend-policy refusal is a must-abort, never a per-call reflect/judge error', async () => {
    const denied = new Error('spend policy refused');
    await withAIInvocationGuard(async () => { throw denied; }, () =>
      invokeAI({ operation: 'test', kind: 'chat', model: 'test:model' }, async () => 'unreached', () => null)).catch(() => {});
    expect(isSkilloptMustAbort(denied)).toBe(true);
    expect(isSkilloptMustAbort(new Error('provider 500'))).toBe(false);
  });
});
