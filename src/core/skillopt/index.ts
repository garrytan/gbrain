/**
 * Public skillopt surface for downstream eval harnesses (audit finding
 * skillopt-cats-11, closed by the 2026-08 fix wave): gbrain-evals cat30–33
 * consume these entry points and previously reached them via physical
 * `node_modules/gbrain/src/...` deep imports, which break under non-hoisting
 * installs (Yarn PnP, relocated runners). The `./core/skillopt` package
 * export maps here; keep this barrel to the externally-consumed surface —
 * internal skillopt modules stay internal. B1.1 adds the rollout and scoring
 * primitives a method benchmark's rollout server runs, so every optimizer arm
 * runs the target with gbrain's own rollout.
 */

export { runSkillOpt } from './orchestrator.ts';
export type { RunSkillOptResult } from './orchestrator.ts';
export type {
  SkillOptOpts,
  BenchmarkTask,
  Judge,
  Trajectory,
  ScoredRollout,
  RunReceipt,
  OptimizerMode,
  RolloutPhase,
  RolloutBatchRequest,
  RolloutBatchHook,
} from './types.ts';
export { scoreSkillOnTasks, scoreSkillPerTask } from './validate-gate.ts';
export type { ScoreOnTasksOpts, PerTaskScore } from './validate-gate.ts';
export { loadHeldOut } from './held-out.ts';
export { runRollout, READ_ONLY_BRAIN_TOOLS, rolloutToolsForSkill } from './rollout.ts';
export type { RolloutOpts } from './rollout.ts';
export { scoreTrajectory } from './score.ts';
export { describeJudge, describeJudges } from './reflect.ts';
export { SKILLOPT_HOOK_BUDGET_EXHAUSTED, SKILLOPT_HOOK_INFRA_ERROR } from './must-abort.ts';
