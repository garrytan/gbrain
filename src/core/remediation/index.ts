// src/core/remediation/index.ts
// v0.41.18.0 (A1). Barrel for the doctor-remediation library.
// Consumers (doctor CLI, onboard CLI, MCP run_onboard) import from here.

export { computeRemediationPlan, SYNTHETIC_CHECK_NAMES } from './plan.ts';
export { runRemediation } from './run.ts';
export { loadRecommendationContext } from './context.ts';
export type { RecommendationContext } from './context.ts';
export type {
  RemediationPlan,
  RemediationPlanOpts,
  RemediationOpts,
  RemediationResult,
  RemediationHooks,
  StepResult,
} from './types.ts';
