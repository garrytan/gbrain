import { describe, expect, test } from 'bun:test';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { runDreamCycleMaintenance } from '../src/core/services/dream-cycle-maintenance-service.ts';
import type { MemoryCandidateEntryInput } from '../src/core/types.ts';

async function createEngine(): Promise<SQLiteEngine> {
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: ':memory:' });
  await engine.initSchema();
  return engine;
}

function candidateInput(
  id: string,
  overrides: Partial<MemoryCandidateEntryInput> = {},
): MemoryCandidateEntryInput {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'note_update',
    proposed_content: 'Redis cache invalidation runbook belongs in system memory for operators.',
    source_refs: ['Source: User, direct message, 2026-06-15 12:00 KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.86,
    importance_score: 0.9,
    recurrence_score: 0.3,
    sensitivity: 'work',
    status: 'candidate',
    target_object_type: null,
    target_object_id: null,
    reviewed_at: null,
    review_reason: null,
    ...overrides,
  };
}

describe('canonical target proposals in dream-cycle maintenance', () => {
  test('targetless high-priority candidates create proposals without approving, binding, or writing pages', async () => {
    const engine = await createEngine();
    try {
      await engine.createMemoryCandidateEntry(candidateInput('candidate:redis-runbook'));

      const result = await runDreamCycleMaintenance(engine, {
        scope_id: 'workspace:default',
        now: '2026-06-15T03:00:00.000Z',
        limit: 5,
        write_candidates: true,
      });

      expect(result.canonical_target_proposals_created).toBe(1);
      expect(result.canonical_target_proposals_existing).toBe(0);
      expect(result.canonical_target_proposals_blocked).toBe(0);

      const proposals = await engine.listCanonicalTargetProposalEntries({
        scope_id: 'workspace:default',
        source_candidate_id: 'candidate:redis-runbook',
        limit: 10,
      });
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({
        source_candidate_id: 'candidate:redis-runbook',
        status: 'proposed',
        proposed_slug: 'systems/redis-cache-invalidation-runbook',
      });
      expect(proposals[0]!.approved_at).toBeNull();
      expect(proposals[0]!.bound_candidate_ids).toEqual([]);

      const candidate = await engine.getMemoryCandidateEntry('candidate:redis-runbook');
      expect(candidate).toMatchObject({
        status: 'candidate',
        target_object_type: null,
        target_object_id: null,
      });
      expect(await engine.getPage('systems/redis-cache-invalidation-runbook')).toBeNull();
      const mutations = await engine.listMemoryMutationEvents({ scope_id: 'workspace:default', limit: 10 });
      expect(mutations).toEqual([]);
    } finally {
      await engine.disconnect();
    }
  });

  test('repeated dream runs refresh active proposals instead of duplicating them', async () => {
    const engine = await createEngine();
    try {
      await engine.createMemoryCandidateEntry(candidateInput('candidate:repeat-runbook'));

      const first = await runDreamCycleMaintenance(engine, {
        scope_id: 'workspace:default',
        now: '2026-06-15T03:00:00.000Z',
        limit: 5,
        write_candidates: true,
      });
      const second = await runDreamCycleMaintenance(engine, {
        scope_id: 'workspace:default',
        now: '2026-06-15T04:00:00.000Z',
        limit: 5,
        write_candidates: true,
      });

      expect(first.canonical_target_proposals_created).toBe(1);
      expect(second.canonical_target_proposals_created).toBe(0);
      expect(second.canonical_target_proposals_existing).toBe(1);

      const proposals = await engine.listCanonicalTargetProposalEntries({
        scope_id: 'workspace:default',
        source_candidate_id: 'candidate:repeat-runbook',
        limit: 10,
      });
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.status).toBe('proposed');
    } finally {
      await engine.disconnect();
    }
  });

  test('low-importance one-off candidates do not create canonical target proposals', async () => {
    const engine = await createEngine();
    try {
      await engine.createMemoryCandidateEntry(candidateInput('candidate:one-off-task', {
        proposed_content: 'Ran bun test once and checked the current branch status.',
        importance_score: 0.2,
        recurrence_score: 0,
      }));

      const result = await runDreamCycleMaintenance(engine, {
        scope_id: 'workspace:default',
        now: '2026-06-15T03:00:00.000Z',
        limit: 5,
        write_candidates: true,
      });

      expect(result.canonical_target_proposals_created).toBe(0);
      expect(result.canonical_target_proposals_existing).toBe(0);
      expect(result.canonical_target_proposals_blocked).toBe(0);
      expect(await engine.listCanonicalTargetProposalEntries({
        scope_id: 'workspace:default',
        source_candidate_id: 'candidate:one-off-task',
        limit: 10,
      })).toEqual([]);
    } finally {
      await engine.disconnect();
    }
  });
});
