import { describe, expect, test } from 'bun:test';
import { runProofAgentMemory } from '../src/core/services/proof-agent-service.ts';
import { formatResult, operationsByName } from '../src/core/operations.ts';

describe('proof agent memory service and operation', () => {
  test('runs deterministic proof scenarios without mutations', () => {
    const report = runProofAgentMemory({ verbose: true, now: '2026-06-06T00:00:00.000Z' });

    expect(report.status).toBe('pass');
    expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
      'decision_reuse',
      'failed_attempt_avoidance',
      'stale_code_verify_first',
      'candidate_exclusion',
      'memory_why_explanation',
    ]);
    expect(report.scenarios.every((scenario) => scenario.status === 'pass')).toBe(true);
    expect(report.scenarios.flatMap((scenario) => scenario.mutations)).toEqual([]);
    expect(report.mutations).toEqual([]);
    expect(report.authority_violations).toEqual([]);
    expect(report.memory_why.concise_lines.length).toBeLessThanOrEqual(5);
    expect(report.memory_why.concise_lines[0]).toBe('Used canonical reads: 1');
  });

  test('proves candidate and orientation artifacts are excluded from answer grounding', () => {
    const report = runProofAgentMemory({ now: '2026-06-06T00:00:00.000Z' });
    const candidateScenario = report.scenarios.find((scenario) => scenario.id === 'candidate_exclusion');

    expect(candidateScenario).toMatchObject({
      status: 'pass',
      activation: 'candidate_only',
      authority: 'unreviewed_candidate',
      mutations: [],
    });
    expect(candidateScenario?.reason_codes).toContain('memory_candidate');
    expect(report.memory_why.authority_violations).toEqual([]);
  });

  test('registers proof-agent as a read-only shared operation and formats output', async () => {
    const op = operationsByName.proof_agent_memory;
    expect(op).toBeDefined();
    expect(op?.mutating).toBe(false);
    expect(op?.cliHints?.name).toBe('proof-agent');

    const result = await op!.handler({
      engine: {} as any,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      verbose: true,
    }) as ReturnType<typeof runProofAgentMemory>;

    expect(result.status).toBe('pass');
    const output = formatResult('proof_agent_memory', result, { verbose: true });
    expect(output).toContain('Proof status: pass');
    expect(output).toContain('decision_reuse\tpass\tanswer_ground\tcanonical_compiled_truth');
    expect(output).toContain('candidate_exclusion\tpass\tcandidate_only\tunreviewed_candidate');
    expect(output).toContain('Memory why:');
    expect(output).toContain('Used canonical reads: 1');
    expect(output).toContain('Authority violations: none');
  });
});
