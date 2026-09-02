/**
 * Public skillopt surface for downstream eval harnesses (audit finding
 * skillopt-cats-11, closed by the 2026-08 fix wave): gbrain-evals cat30–33
 * consume exactly these three entry points and previously reached them via
 * physical `node_modules/gbrain/src/...` deep imports, which break under
 * non-hoisting installs (Yarn PnP, relocated runners). The `./core/skillopt`
 * package export maps here; keep this barrel to the externally-consumed
 * surface — internal skillopt modules stay internal.
 */

export { runSkillOpt } from './orchestrator.ts';
export type { RunSkillOptResult } from './orchestrator.ts';
export type { SkillOptOpts, BenchmarkTask } from './types.ts';
export { scoreSkillOnTasks } from './validate-gate.ts';
export type { ScoreOnTasksOpts } from './validate-gate.ts';
export { loadHeldOut } from './held-out.ts';
