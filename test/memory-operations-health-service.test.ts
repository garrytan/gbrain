import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { getMemoryOperationsHealth } from '../src/core/services/memory-operations-health-service.ts';

describe('memory operations health service', () => {
  test('counts mutation events, draft redaction plans, and pending patch candidates for a scope', async () => {
    const calls: Array<{ method: string; filters: Record<string, unknown> }> = [];
    const engine = {
      listMemoryMutationEvents: async (filters: Record<string, unknown>) => {
        calls.push({ method: 'listMemoryMutationEvents', filters });
        return [{ id: 'event-a' }, { id: 'event-b' }];
      },
      listMemoryRedactionPlans: async (filters: Record<string, unknown>) => {
        calls.push({ method: 'listMemoryRedactionPlans', filters });
        return [{ id: 'plan-a' }];
      },
      listMemoryCandidateEntries: async (filters: Record<string, unknown>) => {
        calls.push({ method: 'listMemoryCandidateEntries', filters });
        if (filters.patch_operation_state === 'proposed') return [{ id: 'candidate-proposed' }];
        if (filters.patch_operation_state === 'dry_run_validated') return [
          { id: 'candidate-dry-run-a' },
          { id: 'candidate-dry-run-b' },
        ];
        if (filters.patch_operation_state === 'approved_for_apply') return [{ id: 'candidate-approved' }];
        throw new Error(`unexpected patch state: ${String(filters.patch_operation_state)}`);
      },
    } as unknown as BrainEngine;

    const report = await getMemoryOperationsHealth(engine, {
      scope_id: 'workspace:ops',
      limit: 25,
    });

    expect(report).toMatchObject({
      scope_id: 'workspace:ops',
      sampled_row_limit: 25,
      mutation_event_count: 2,
      open_redaction_plan_count: 1,
      pending_candidate_patch_count: 4,
    });
    expect(report.summary_lines).toEqual([
      'workspace:ops sampled up to 25 rows and found 2 memory mutation events.',
      'workspace:ops sampled up to 25 draft redaction plans and found 1 draft redaction plan.',
      'workspace:ops sampled up to 25 rows per pending patch state and found 4 pending memory patch candidates.',
    ]);
    expect(calls).toEqual([
      { method: 'listMemoryMutationEvents', filters: { scope_id: 'workspace:ops', limit: 25, offset: 0 } },
      { method: 'listMemoryRedactionPlans', filters: { scope_id: 'workspace:ops', status: 'draft', limit: 25, offset: 0 } },
      { method: 'listMemoryCandidateEntries', filters: { scope_id: 'workspace:ops', patch_operation_state: 'proposed', limit: 25, offset: 0 } },
      { method: 'listMemoryCandidateEntries', filters: { scope_id: 'workspace:ops', patch_operation_state: 'dry_run_validated', limit: 25, offset: 0 } },
      { method: 'listMemoryCandidateEntries', filters: { scope_id: 'workspace:ops', patch_operation_state: 'approved_for_apply', limit: 25, offset: 0 } },
    ]);
  });

  test('defaults to workspace scope and does not require a separate patch table API', async () => {
    const engine = {
      listMemoryMutationEvents: async () => [],
      listMemoryRedactionPlans: async () => [],
      listMemoryCandidateEntries: async () => [{ id: 'pending' }],
    } as unknown as BrainEngine;

    const report = await getMemoryOperationsHealth(engine);

    expect(report.scope_id).toBe('workspace:default');
    expect(report.sampled_row_limit).toBe(100);
    expect(report.pending_candidate_patch_count).toBe(3);
    expect((engine as any).listMemoryCandidatePatches).toBeUndefined();
  });
});
