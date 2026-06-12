import type {
  DreamCycleRunDeps,
  DreamReplayCanaryResult,
} from './dream-cycle-runner-service.ts';
import { runProofAgentMemory } from './proof-agent-service.ts';

export type DreamReplayCanary = NonNullable<DreamCycleRunDeps['replayCanary']>;

export function createProofAgentDreamReplayCanary(): DreamReplayCanary {
  return {
    run: async (input) => runProofAgentDreamReplayCanary({ now: input.now }),
  };
}

export function runProofAgentDreamReplayCanary(input: { now: string }): DreamReplayCanaryResult {
  const proof = runProofAgentMemory({ now: input.now });
  const failedScenarios = proof.scenarios.filter((scenario) => scenario.status !== 'pass');
  const unexpectedMutationCount = proof.mutations.length;
  const authorityViolationCount = proof.authority_violations.length;
  const passed = proof.status === 'pass'
    && failedScenarios.length === 0
    && unexpectedMutationCount === 0
    && authorityViolationCount === 0;

  if (passed) {
    return {
      status: 'passed',
      reason_codes: ['proof_agent_memory_passed'],
      summary_lines: ['Proof-agent memory replay canary passed without mutations or authority violations.'],
    };
  }

  return {
    status: 'failed',
    reason_codes: [
      'proof_agent_memory_failed',
      ...(unexpectedMutationCount > 0 ? ['proof_agent_unexpected_mutation'] : []),
      ...(authorityViolationCount > 0 ? ['proof_agent_authority_violation'] : []),
      ...failedScenarios.map((scenario) => `proof_agent_scenario_failed:${scenario.id}`),
    ],
    summary_lines: [
      `Proof-agent memory replay canary failed with ${failedScenarios.length} failed scenarios, ${unexpectedMutationCount} mutations, and ${authorityViolationCount} authority violations.`,
    ],
  };
}
