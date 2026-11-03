/**
 * GST-1251: SkillOpt's iterative reflect loop is deprecated and is removed on or after SKILLOPT_LOOP_REMOVAL_DATE.
 * Each entry point that runs it (the CLI's `--loop` or a resumed loop checkpoint, `run_skillopt` with
 * `optimizer_mode: "reflect"`, a `skillopt` job in reflect mode) emits the `skillopt_loop_deprecated` coaching
 * notice once per use; the run itself is unchanged.
 */
import type { Notice } from '../agent-output.ts';
import type { OptimizerMode } from './types.ts';

export const SKILLOPT_LOOP_REMOVAL_DATE = '2026-12-03';

export const SKILLOPT_LOOP_DEPRECATED = `SkillOpt's iterative loop (--loop, optimizer_mode "reflect") is deprecated and will be removed on or after ${SKILLOPT_LOOP_REMOVAL_DATE}; this run continues unchanged. `
  + 'Nothing replaces it: edit the skill directly, or run the default one-shot rewrite (gbrain skillopt <skill> without --loop), '
  + "which matched the loop's held-out score on gbrain-evals' benchmarks at about half the cost.";

export function skillOptLoopDeprecatedNotice(): Notice {
  return { code: 'skillopt_loop_deprecated', kind: 'coaching', why: SKILLOPT_LOOP_DEPRECATED };
}

/** Prints the notice on stderr when `mode` runs the loop (the CLI command and the job handler call it once per run). */
export function noteSkillOptLoopDeprecated(mode: OptimizerMode): void {
  if (mode !== 'reflect') return;
  process.stderr.write(`[gbrain notice skillopt_loop_deprecated] ${SKILLOPT_LOOP_DEPRECATED}\n`);
}
