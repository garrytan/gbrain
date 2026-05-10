import { describe, expect, test } from 'bun:test';
import { planScenarioMemoryRequest } from '../src/core/services/scenario-memory-request-planner-service.ts';

describe('scenario memory request planner', () => {
  test('plans coding continuation before raw source reads', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Continue fixing the failing retrieval route test',
      task_id: 'task-123',
      repo_path: '/repo/mbrain',
    });

    expect(plan.classification.scenario).toBe('coding_continuation');
    expect(plan.primary_reads).toEqual([
      'task_thread',
      'working_set',
      'recent_episodes',
      'recent_attempts_decisions',
      'linked_procedures',
    ]);
    expect(plan.secondary_reads).toContain('code_files_after_task_state');
    expect(plan.next_tool).toBe('resume_task');
    expect(plan.writeback_hint).toBe('record_trace');
    expect(plan.trace_required).toBe(true);
  });

  test('keeps coding-local fix explanations as coding continuation', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Continue fixing the failing route test and explain the fix',
      task_id: 'task-123',
      repo_path: '/repo/mbrain',
    });

    expect(plan.classification.scenario).toBe('coding_continuation');
    expect(plan.decomposed_plans).toEqual([]);
    expect(plan.next_tool).toBe('resume_task');
  });

  test('keeps coding-local fix rationale explanations as coding continuation', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Continue fixing the failing route test and explain why the fix works',
      task_id: 'task-123',
      repo_path: '/repo/mbrain',
    });

    expect(plan.classification.scenario).toBe('coding_continuation');
    expect(plan.decomposed_plans).toEqual([]);
    expect(plan.next_tool).toBe('resume_task');
  });

  test('keeps coding-local failing test explanations as coding continuation', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Continue implementation and explain failing tests',
      task_id: 'task-123',
      repo_path: '/repo/mbrain',
    });

    expect(plan.classification.scenario).toBe('coding_continuation');
    expect(plan.decomposed_plans).toEqual([]);
    expect(plan.next_tool).toBe('resume_task');
  });

  test('keeps repeated coding-local route test explanations as coding continuation', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Continue fixing failing route tests and explain failing route tests',
      task_id: 'task-123',
      repo_path: '/repo/mbrain',
    });

    expect(plan.classification.scenario).toBe('coding_continuation');
    expect(plan.decomposed_plans).toEqual([]);
    expect(plan.next_tool).toBe('resume_task');
  });

  test('plans PR review branch work as coding continuation', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Review mbrain PR #70 on branch codex/scenario-memory-orchestration-phase-a',
      known_subjects: ['src/core/operations.ts'],
    });

    expect(plan.classification.scenario).toBe('coding_continuation');
    expect(plan.primary_reads[0]).toBe('task_thread');
    expect(plan.secondary_reads).toContain('code_files_after_task_state');
    expect(plan.next_tool).toBe('resume_task');
  });

  test('plans generic code review as coding continuation', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Review this code',
    });

    expect(plan.classification.scenario).toBe('coding_continuation');
    expect(plan.primary_reads[0]).toBe('task_thread');
    expect(plan.next_tool).toBe('resume_task');
  });

  test('plans project QA through project and system pages before maps', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Explain the mbrain retrieval architecture',
      known_subjects: [{ ref: 'systems/mbrain', kind: 'system' }],
    });

    expect(plan.classification.scenario).toBe('project_qa');
    expect(plan.primary_reads).toEqual([
      'project_page',
      'system_pages',
      'codemap_concept_pages',
      'source_records',
    ]);
    expect(plan.secondary_reads).toContain('context_map_orientation');
    expect(plan.next_tool).toBe('get_page');
  });

  test('plans knowledge QA with exact page preference', () => {
    const plan = planScenarioMemoryRequest({
      query: 'What do we know about Pedro?',
    });

    expect(plan.classification.scenario).toBe('knowledge_qa');
    expect(plan.primary_reads).toEqual([
      'exact_curated_page',
      'linked_canonical_pages',
      'timeline_source_evidence',
    ]);
    expect(plan.next_tool).toBe('get_page');
  });

  test('plans personal recall through scope gate first', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Remember my coffee preference',
      requested_scope: 'personal',
    });

    expect(plan.classification.scenario).toBe('personal_recall');
    expect(plan.primary_reads[0]).toBe('scope_gate');
    expect(plan.next_tool).toBe('evaluate_scope_gate');
  });

  test('plans auto accumulation through the writeback router', () => {
    const plan = planScenarioMemoryRequest({
      query: 'review this session for durable memory candidates',
      source_kind: 'session_end',
    });

    expect(plan.classification.scenario).toBe('auto_accumulation');
    expect(plan.next_tool).toBe('route_memory_writeback');
    expect(plan.writeback_hint).toBe('create_candidate');
  });

  test('decomposes mixed requests into ordered subplans', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Continue the task and explain the mbrain project architecture',
      task_id: 'task-123',
      known_subjects: [{ ref: 'systems/mbrain', kind: 'system' }],
    });

    expect(plan.classification.scenario).toBe('mixed');
    expect(plan.decomposed_plans.map((subplan) => subplan.scenario)).toEqual([
      'coding_continuation',
      'project_qa',
    ]);
    expect(plan.next_tool).toBe('resume_task');
  });

  test('preserves explicit mixed project asks without known subjects', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Continue the task and explain the mbrain project architecture',
      task_id: 'task-123',
    });

    expect(plan.classification.scenario).toBe('mixed');
    expect(plan.decomposed_plans.map((subplan) => subplan.scenario)).toEqual([
      'coding_continuation',
      'project_qa',
    ]);
    expect(plan.next_tool).toBe('resume_task');
  });

  test('preserves system architecture explanations as project QA subplans', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Continue the task and explain the mbrain system architecture',
      task_id: 'task-123',
    });

    expect(plan.classification.scenario).toBe('mixed');
    expect(plan.classification.decomposed_routes.map((route) => route.scenario)).toEqual([
      'coding_continuation',
      'project_qa',
    ]);
    expect(plan.next_tool).toBe('resume_task');
  });

  test('preserves explicit mixed generic concept asks without known subjects', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Continue the task and explain vector clocks',
      task_id: 'task-123',
    });

    expect(plan.classification.scenario).toBe('mixed');
    expect(plan.decomposed_plans.map((subplan) => subplan.scenario)).toEqual([
      'coding_continuation',
      'knowledge_qa',
    ]);
    expect(plan.next_tool).toBe('resume_task');
  });

  test('preserves resume implementation plus concept explanation as mixed', () => {
    const plan = planScenarioMemoryRequest({
      query: 'Resume implementation and explain dependency injection',
      task_id: 'task-123',
    });

    expect(plan.classification.scenario).toBe('mixed');
    expect(plan.decomposed_plans.map((subplan) => subplan.scenario)).toEqual([
      'coding_continuation',
      'knowledge_qa',
    ]);
    expect(plan.next_tool).toBe('resume_task');
  });

  test('returns planned activation rules for project map orientation before artifacts exist', () => {
    const plan = planScenarioMemoryRequest({
      query: 'mbrain 검색 라우팅 구조를 설명해 주세요',
      known_subjects: [{ ref: 'systems/mbrain', kind: 'system' }],
    });

    expect(plan.classification.scenario).toBe('project_qa');
    expect(plan.planned_activation_rules).toContainEqual({
      planned_read: 'context_map_orientation',
      artifact_kind: 'context_map',
      decision: 'orientation_only',
      authority: 'derived_orientation',
      reason_codes: ['secondary_orientation_read'],
    });
  });

  test('marks failed attempts as suppress-if-valid in coding plans before artifacts exist', () => {
    const plan = planScenarioMemoryRequest({
      query: '이어서 실패한 테스트 수정을 진행하세요',
      task_id: 'task-123',
      repo_path: '/repo/mbrain',
    });

    expect(plan.classification.scenario).toBe('coding_continuation');
    expect(plan.planned_activation_rules).toContainEqual({
      planned_read: 'recent_attempts_decisions',
      artifact_kind: 'task_attempt_failed',
      decision: 'suppress_if_valid',
      authority: 'operational_memory',
      reason_codes: ['primary_operational_read'],
    });
  });

  test('keeps planned activation rules on decomposed mixed subplans', () => {
    const plan = planScenarioMemoryRequest({
      query: '내 선호를 참고해서 mbrain 구조도 설명해 주세요',
      requested_scope: 'mixed',
      known_subjects: [{ ref: 'systems/mbrain', kind: 'system' }],
    });

    expect(plan.classification.scenario).toBe('mixed');
    expect(plan.decomposed_plans[0]?.planned_activation_rules.length).toBeGreaterThan(0);
    expect(plan.decomposed_plans[1]?.planned_activation_rules.length).toBeGreaterThan(0);
  });
});
