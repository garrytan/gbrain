import { describe, expect, test } from 'bun:test';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

const ctx: OperationContext = {
  engine: new Proxy({}, {
    get() {
      throw new Error('scenario memory orchestration operations must not read the engine');
    },
  }) as unknown as OperationContext['engine'],
  config: {} as OperationContext['config'],
  logger: console,
  dryRun: false,
};

describe('scenario memory orchestration operations', () => {
  test('registers classify_memory_scenario as non-mutating with CLI hint', () => {
    const op = operationsByName.classify_memory_scenario;
    expect(op).toBeDefined();
    expect(op?.mutating).toBe(false);
    expect(op?.cliHints?.name).toBe('classify-memory-scenario');
  });

  test('classify_memory_scenario returns coding continuation for task context', async () => {
    const result = await operationsByName.classify_memory_scenario.handler(ctx, {
      query: 'Continue fixing the failing test',
      task_id: 'task-123',
    });

    expect((result as { scenario: string }).scenario).toBe('coding_continuation');
    expect((result as { reason_codes: string[] }).reason_codes).toContain('task_id_present');
  });

  test('classify_memory_scenario rejects non-string task_id params', async () => {
    await expect(operationsByName.classify_memory_scenario.handler(ctx, {
      query: 'Continue fixing the failing test',
      task_id: 123,
    })).rejects.toThrow('task_id must be a string');
  });

  test('scenario operations expose array item schemas', () => {
    expect(operationsByName.classify_memory_scenario.params.known_subjects.items?.type).toEqual(['string', 'object']);
    expect(operationsByName.select_activation_policy.params.artifacts.items?.type).toBe('object');
    expect(operationsByName.plan_scenario_memory_request.params.known_subjects.items?.type).toEqual(['string', 'object']);
    expect(operationsByName.plan_scenario_memory_request.params.artifacts.items?.type).toBe('object');
  });

  test('registers select_activation_policy as non-mutating with CLI hint', () => {
    const op = operationsByName.select_activation_policy;
    expect(op).toBeDefined();
    expect(op?.mutating).toBe(false);
    expect(op?.cliHints?.name).toBe('select-activation-policy');
  });

  test('select_activation_policy parses artifacts and verifies stale codemap pointers first', async () => {
    const result = await operationsByName.select_activation_policy.handler(ctx, {
      scenario: 'project_qa',
      artifacts: [{
        id: 'codemap:systems/mbrain#selectRetrievalRoute',
        artifact_kind: 'codemap_pointer',
        source_ref: 'page:systems/mbrain',
        stale: true,
      }],
    });

    expect((result as { verification_required: boolean }).verification_required).toBe(true);
    expect((result as { next_tool: string }).next_tool).toBe('reverify_code_claims');
  });

  test('select_activation_policy accepts artifacts JSON string', async () => {
    const result = await operationsByName.select_activation_policy.handler(ctx, {
      scenario: 'project_qa',
      artifacts: JSON.stringify([{
        id: 'codemap:systems/mbrain#selectRetrievalRoute',
        artifact_kind: 'codemap_pointer',
        source_ref: 'page:systems/mbrain',
        stale: true,
      }]),
    });

    expect((result as { verification_required: boolean }).verification_required).toBe(true);
    expect((result as { next_tool: string }).next_tool).toBe('reverify_code_claims');
  });

  test('registers plan_scenario_memory_request as non-mutating with CLI hint', () => {
    const op = operationsByName.plan_scenario_memory_request;
    expect(op).toBeDefined();
    expect(op?.mutating).toBe(false);
    expect(op?.cliHints?.name).toBe('plan-scenario-memory-request');
  });

  test('plan_scenario_memory_request returns coding continuation reads and next tool', async () => {
    const result = await operationsByName.plan_scenario_memory_request.handler(ctx, {
      query: 'Continue this implementation task',
      task_id: 'task-123',
      repo_path: '/repo/mbrain',
    });

    const plan = result as {
      classification: { scenario: string };
      primary_reads: string[];
      next_tool: string;
    };
    expect(plan.classification.scenario).toBe('coding_continuation');
    expect(plan.primary_reads[0]).toBe('task_thread');
    expect(plan.next_tool).toBe('resume_task');
  });

  test('plan_scenario_memory_request exposes route_memory_writeback for session-end accumulation', async () => {
    const result = await operationsByName.plan_scenario_memory_request.handler(ctx, {
      query: '이번 세션에서 장기 기억 후보를 남길 내용을 검토하세요',
      source_kind: 'session_end',
    });

    const plan = result as {
      classification: { scenario: string };
      next_tool: string;
      writeback_hint: string;
    };
    expect(plan.classification.scenario).toBe('auto_accumulation');
    expect(plan.next_tool).toBe('route_memory_writeback');
    expect(plan.writeback_hint).toBe('create_candidate');
  });

  test('rejects invalid scenario enum', async () => {
    await expect(operationsByName.select_activation_policy.handler(ctx, {
      scenario: 'not-real',
      artifacts: [],
    })).rejects.toThrow('scenario must be one of');
  });

  test('rejects invalid artifact_kind', async () => {
    await expect(operationsByName.select_activation_policy.handler(ctx, {
      scenario: 'project_qa',
      artifacts: [{
        id: 'bad-artifact',
        artifact_kind: 'not-real',
      }],
    })).rejects.toThrow('artifacts[0].artifact_kind must be one of');
  });

  test('rejects invalid scope_policy', async () => {
    await expect(operationsByName.select_activation_policy.handler(ctx, {
      scenario: 'personal_recall',
      artifacts: [{
        id: 'bad-scope-policy',
        artifact_kind: 'profile_memory',
        scope_policy: 'maybe',
      }],
    })).rejects.toThrow('artifacts[0].scope_policy must be one of');
  });

  test('rejects invalid artifact optional field shapes', async () => {
    await expect(operationsByName.select_activation_policy.handler(ctx, {
      scenario: 'project_qa',
      artifacts: [{
        id: 'bad-source-ref',
        artifact_kind: 'codemap_pointer',
        source_ref: 123,
      }],
    })).rejects.toThrow('artifacts[0].source_ref must be a string');

    await expect(operationsByName.select_activation_policy.handler(ctx, {
      scenario: 'project_qa',
      artifacts: [{
        id: 'bad-stale',
        artifact_kind: 'codemap_pointer',
        stale: 'true',
      }],
    })).rejects.toThrow('artifacts[0].stale must be a boolean');
  });

  test('accepts typed known_subjects JSON through planner for system subjects', async () => {
    const result = await operationsByName.plan_scenario_memory_request.handler(ctx, {
      query: 'mbrain의 검색 라우팅 구조를 설명해 주세요',
      known_subjects: JSON.stringify([{ ref: 'systems/mbrain', kind: 'system' }]),
    });

    const plan = result as {
      classification: { scenario: string; reason_codes: string[] };
    };
    expect(plan.classification.scenario).toBe('project_qa');
    expect(plan.classification.reason_codes).toContain('system_or_project_subject');
  });

  test('accepts plain string known_subjects through planner', async () => {
    const result = await operationsByName.plan_scenario_memory_request.handler(ctx, {
      query: 'How does the mbrain retrieval route selector work?',
      known_subjects: 'systems/mbrain',
    });

    const plan = result as {
      classification: { scenario: string; reason_codes: string[] };
    };
    expect(plan.classification.scenario).toBe('project_qa');
    expect(plan.classification.reason_codes).toContain('system_or_project_subject');
  });

  test('plan_scenario_memory_request rejects non-string task_id params', async () => {
    await expect(operationsByName.plan_scenario_memory_request.handler(ctx, {
      query: 'Continue this implementation task',
      task_id: 123,
    })).rejects.toThrow('task_id must be a string');
  });

  test('plan_scenario_memory_request rejects invalid known_subjects params', async () => {
    await expect(operationsByName.plan_scenario_memory_request.handler(ctx, {
      query: 'Explain mbrain',
      known_subjects: [{ kind: 'system' }],
    })).rejects.toThrow('known_subjects[0].ref must be a non-empty string');

    await expect(operationsByName.plan_scenario_memory_request.handler(ctx, {
      query: 'Explain mbrain',
      known_subjects: [{ ref: 'systems/mbrain', kind: 'not-real' }],
    })).rejects.toThrow('known_subjects[0].kind must be one of');
  });
});
