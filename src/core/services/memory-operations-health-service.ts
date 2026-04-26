import type { BrainEngine } from '../engine.ts';
import type { MemoryPatchOperationState } from '../types.ts';

export const DEFAULT_MEMORY_OPERATIONS_HEALTH_SCOPE_ID = 'workspace:default';
export const DEFAULT_MEMORY_OPERATIONS_HEALTH_LIMIT = 100;

const PENDING_PATCH_OPERATION_STATES = [
  'proposed',
  'dry_run_validated',
  'approved_for_apply',
] as const satisfies readonly MemoryPatchOperationState[];

export interface MemoryOperationsHealthInput {
  scope_id?: string;
  limit?: number;
}

export interface MemoryOperationsHealthReport {
  scope_id: string;
  sampled_row_limit: number;
  mutation_event_count: number;
  open_redaction_plan_count: number;
  pending_candidate_patch_count: number;
  summary_lines: string[];
}

export async function getMemoryOperationsHealth(
  engine: BrainEngine,
  input: MemoryOperationsHealthInput = {},
): Promise<MemoryOperationsHealthReport> {
  const scopeId = input.scope_id ?? DEFAULT_MEMORY_OPERATIONS_HEALTH_SCOPE_ID;
  const limit = input.limit ?? DEFAULT_MEMORY_OPERATIONS_HEALTH_LIMIT;

  const [mutationEvents, openRedactionPlans, pendingPatchCounts] = await Promise.all([
    engine.listMemoryMutationEvents({ scope_id: scopeId, limit, offset: 0 }),
    engine.listMemoryRedactionPlans({ scope_id: scopeId, status: 'draft', limit, offset: 0 }),
    Promise.all(PENDING_PATCH_OPERATION_STATES.map(async (patchOperationState) => {
      const entries = await engine.listMemoryCandidateEntries({
        scope_id: scopeId,
        patch_operation_state: patchOperationState,
        limit,
        offset: 0,
      });
      return entries.length;
    })),
  ]);

  const report: MemoryOperationsHealthReport = {
    scope_id: scopeId,
    sampled_row_limit: limit,
    mutation_event_count: mutationEvents.length,
    open_redaction_plan_count: openRedactionPlans.length,
    pending_candidate_patch_count: pendingPatchCounts.reduce((total, count) => total + count, 0),
    summary_lines: [],
  };
  report.summary_lines = [
    `${scopeId} sampled up to ${formatCount(limit, 'row')} and found ${formatCount(report.mutation_event_count, 'memory mutation event')}.`,
    `${scopeId} sampled up to ${formatCount(limit, 'draft redaction plan')} and found ${formatCount(report.open_redaction_plan_count, 'draft redaction plan')}.`,
    `${scopeId} sampled up to ${formatCount(limit, 'row')} per pending patch state and found ${formatCount(report.pending_candidate_patch_count, 'pending memory patch candidate')}.`,
  ];
  return report;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}
