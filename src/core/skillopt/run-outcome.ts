/**
 * SkillOpt truthful outcome (#5584).
 *
 *   caught abort/error ............................ aborted | errored (stop_reason 'aborted')
 *   any candidate accepted ........................ accepted (even after an early stop)
 *   optimizer called, never a usable reply ........ errored, abort_detail 'optimizer_output_unusable: <first error>'
 *   otherwise ..................................... no_improvement
 *
 * A step is "fully unusable" when it made optimizer calls and every one
 * errored (any class). After EARLY_STOP_UNUSABLE_STEPS consecutive fully
 * unusable steps the loop stops instead of spending the remaining budget.
 */

import type { ReflectTally, RunSpec } from './checkpoint.ts';
import type { ReflectResult } from './reflect.ts';
import { errorCode, OPTIMIZER_OUTPUT_UNUSABLE, recordReflectError } from './remediation.ts';
import type { RunReceipt } from './types.ts';

export const EARLY_STOP_UNUSABLE_STEPS = 2;

export type RunOutcome = NonNullable<RunReceipt['outcome']>;
export type StopReason = NonNullable<RunReceipt['stop_reason']>;

/** Fold one step's optimizer calls into the tally; returns true when the step was fully unusable. */
export function recordOptimizerStep(
  tally: ReflectTally,
  step: Pick<ReflectResult, 'calls' | 'usableReplies' | 'errors' | 'invalidEditsDropped'>,
): boolean {
  tally.reflect_calls += step.calls;
  tally.usable_replies += step.usableReplies;
  tally.invalid_edits_dropped += step.invalidEditsDropped;
  for (const e of step.errors) recordReflectError(tally.reflect_errors, e);
  const fullyUnusable = step.calls > 0 && step.usableReplies === 0;
  if (fullyUnusable) tally.unusable_streak += 1;
  else if (step.usableReplies > 0) tally.unusable_streak = 0;
  return fullyUnusable;
}

export function shouldEarlyStop(tally: ReflectTally): boolean {
  return tally.unusable_streak >= EARLY_STOP_UNUSABLE_STEPS;
}

export interface ResolvedOutcome {
  outcome: RunOutcome;
  stopReason: StopReason;
  abortReason?: NonNullable<RunReceipt['abort_reason']>;
  abortDetail?: string;
}

export function resolveRunOutcome(input: {
  caught?: { outcome: 'aborted' | 'errored'; abortReason: NonNullable<RunReceipt['abort_reason']>; abortDetail: string };
  tally: ReflectTally;
  earlyStopped: boolean;
}): ResolvedOutcome {
  const { caught, tally } = input;
  if (caught) {
    return { outcome: caught.outcome, stopReason: 'aborted', abortReason: caught.abortReason, abortDetail: caught.abortDetail };
  }
  const stopReason: StopReason = input.earlyStopped ? 'early_stop_unusable_output' : 'completed';
  if (tally.accepted_steps > 0) return { outcome: 'accepted', stopReason };
  if (tally.reflect_calls > 0 && tally.usable_replies === 0) {
    return {
      outcome: 'errored',
      stopReason,
      abortReason: 'error',
      abortDetail: `${OPTIMIZER_OUTPUT_UNUSABLE}: ${tally.reflect_errors[0] ?? 'no usable optimizer reply'}`,
    };
  }
  return { outcome: 'no_improvement', stopReason };
}

/** Human class label for the early-stop line (distinct codes, e.g. `reflect_truncated`). */
export function unusableClasses(tally: ReflectTally): string {
  const codes = [...new Set(tally.reflect_errors.map((e) => errorCode(e) ?? e.split(':', 1)[0]!))];
  return codes.join(', ') || 'unusable optimizer output';
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function shellArg(v: string | number): string {
  const s = String(v).replace(CONTROL_CHARS, '');
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Output-cap failures: resuming with a doubled reflect cap is the fix. */
const CAP_TOO_SMALL_CODES: ReadonlySet<string> = new Set([
  'reflect_truncated',
  'one_shot_rewrite_truncated',
  'one_shot_rewrite_output_cap_too_small',
]);

/** Run-level flags that are not part of the resume-compatibility spec. */
export interface ResumeRunFlags {
  mode: 'patch' | 'rewrite';
  /** 0 = uncapped (`--no-max-cost`). */
  maxCostUsd: number;
  maxRuntimeMin: number;
  /** The run used --force, or it accepted a candidate that left SKILL.md dirty. */
  force?: boolean;
  modelsStrict?: boolean;
}

/**
 * The exact command that resumes this run, rebuilt from the stored spec plus
 * the run's mode and cost/runtime caps. An output-cap failure doubles the
 * reflect cap; an edits-contract failure replaces the optimizer with an
 * `<other-model>` placeholder to fill in.
 */
export function buildResumeCommand(
  skill: string,
  runId: string,
  spec: RunSpec,
  failureCode?: string,
  run?: ResumeRunFlags,
): string {
  const cap = failureCode !== undefined && CAP_TOO_SMALL_CODES.has(failureCode) ? spec.reflect_max_tokens * 2 : spec.reflect_max_tokens;
  const contract = failureCode !== undefined && /(_empty_reply|_no_parseable_edits|_invalid_edits)$/.test(failureCode);
  const args: Array<string | number> = [
    'gbrain', 'skillopt', skill, '--resume', runId,
    '--skills-dir', spec.skills_dir,
    '--benchmark', spec.benchmark_path,
    '--split', spec.split.join(':'),
    '--epochs', spec.epochs,
    '--batch-size', spec.batch_size,
    '--lr', spec.lr,
    '--lr-schedule', spec.lr_schedule,
    '--optimizer-model', spec.optimizer_model,
    '--target-model', spec.target_model,
    '--judge-model', spec.judge_model,
    '--reflect-max-tokens', cap,
  ];
  if (spec.held_out_path) args.push('--held-out', spec.held_out_path);
  if (spec.no_mutate) args.push('--no-mutate');
  if (spec.allow_mutate_bundled) args.push('--allow-mutate-bundled');
  if (spec.bootstrap_reviewed) args.push('--bootstrap-reviewed');
  if (run) {
    if (run.mode === 'rewrite') args.push('--rewrite');
    if (run.maxCostUsd > 0) args.push('--max-cost-usd', run.maxCostUsd);
    else args.push('--no-max-cost');
    args.push('--max-runtime-min', run.maxRuntimeMin);
    if (run.force) args.push('--force');
    if (run.modelsStrict) args.push('--models-strict');
  }
  const rendered = args.map(shellArg);
  // Quoted: a bare `<other-model>` would be read by the shell as a redirection.
  if (contract) rendered[rendered.indexOf('--optimizer-model') + 1] = `'<other-model>'`;
  return rendered.join(' ');
}
