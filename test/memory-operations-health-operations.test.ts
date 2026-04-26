import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { operations } from '../src/core/operations.ts';
import type { Operation, OperationContext } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

function getOperation(name: string): Operation {
  const operation = operations.find((candidate) => candidate.name === name);
  if (!operation) throw new Error(`Operation not found: ${name}`);
  return operation;
}

async function createHarness(label: string): Promise<{
  engine: SQLiteEngine;
  ctx: (dryRun?: boolean) => OperationContext;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-memory-operations-health-${label}-`));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();
  return {
    engine,
    ctx: (dryRun = false) => ({
      engine,
      config: { engine: 'sqlite', database_path: databasePath },
      logger: console,
      dryRun,
    } as unknown as OperationContext),
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('memory operations health operation', () => {
  test('is registered as a read-only operation with CLI hints', () => {
    const operation = getOperation('get_memory_operations_health');

    expect(operation.mutating).toBe(false);
    expect(operation.params.scope_id.type).toBe('string');
    expect(operation.params.limit.default).toBe(100);
    expect(operation.cliHints?.name).toBe('memory-operations-health');
  });

  test('returns the health report through the operation layer', async () => {
    const harness = await createHarness('report');
    try {
      await harness.engine.createMemoryMutationEvent({
        id: 'event-health-a',
        session_id: 'session-health',
        realm_id: 'realm-health',
        actor: 'agent:test',
        operation: 'put_page',
        target_kind: 'page',
        target_id: 'concepts/health-a',
        scope_id: 'workspace:ops',
        source_refs: ['Source: health operation test'],
        result: 'applied',
      });
      await harness.engine.createMemoryRedactionPlan({
        id: 'redaction-plan:health-draft',
        scope_id: 'workspace:ops',
        query: 'secret',
        status: 'draft',
      });
      await harness.engine.createMemoryRedactionPlan({
        id: 'redaction-plan:health-approved',
        scope_id: 'workspace:ops',
        query: 'approved',
        status: 'approved',
      });
      await harness.engine.createMemoryCandidateEntry({
        id: 'candidate-health-proposed',
        scope_id: 'workspace:ops',
        candidate_type: 'note_update',
        proposed_content: 'Pending proposed patch.',
        source_refs: ['Source: health operation test'],
        generated_by: 'agent',
        extraction_kind: 'manual',
        confidence_score: 0.8,
        importance_score: 0.7,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'candidate',
        patch_target_kind: 'page',
        patch_target_id: 'concepts/health-a',
        patch_body: { compiled_truth: 'updated' },
        patch_format: 'merge_patch',
        patch_operation_state: 'proposed',
      });
      await harness.engine.createMemoryCandidateEntry({
        id: 'candidate-health-applied',
        scope_id: 'workspace:ops',
        candidate_type: 'note_update',
        proposed_content: 'Applied patch.',
        source_refs: ['Source: health operation test'],
        generated_by: 'agent',
        extraction_kind: 'manual',
        confidence_score: 0.8,
        importance_score: 0.7,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'candidate',
        patch_target_kind: 'page',
        patch_target_id: 'concepts/health-a',
        patch_body: { compiled_truth: 'updated' },
        patch_format: 'merge_patch',
        patch_operation_state: 'applied',
      });

      const report = await getOperation('get_memory_operations_health').handler(harness.ctx(true), {
        scope_id: 'workspace:ops',
      }) as any;

      expect(report).toMatchObject({
        scope_id: 'workspace:ops',
        sampled_row_limit: 100,
        mutation_event_count: 1,
        open_redaction_plan_count: 1,
        pending_candidate_patch_count: 1,
      });
      expect(report.summary_lines).toContain('workspace:ops sampled up to 100 rows per pending patch state and found 1 pending memory patch candidate.');
    } finally {
      await harness.cleanup();
    }
  });
});
