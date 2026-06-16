import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMemoryInboxOperations } from '../src/core/operations-memory-inbox.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const operations = createMemoryInboxOperations({
  defaultScopeId: 'workspace:default',
  OperationError: class OperationError extends Error {
    constructor(
      public code: 'memory_candidate_not_found' | 'invalid_params',
      message: string,
      public suggestion?: string,
      public docs?: string,
    ) {
      super(message);
      this.name = 'OperationError';
    }
  },
});

test('memory inbox contradiction operation resolves unresolved contradictions and validates metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-contradiction-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');
  const verify = operations.find((operation) => operation.name === 'verify_memory_candidate_entry');
  const promote = operations.find((operation) => operation.name === 'promote_memory_candidate_entry');
  const resolve = operations.find((operation) => operation.name === 'resolve_memory_candidate_contradiction');

  if (!create || !advance || !verify || !promote || !resolve) {
    throw new Error('memory inbox contradiction operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await create.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'challenged',
      candidate_type: 'fact',
      proposed_content: 'Existing candidate under contradiction review.',
      source_ref: 'User, direct message, 2026-04-24 01:20 AM KST',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/memory-inbox',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'challenged',
      next_status: 'candidate',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'challenged',
      next_status: 'staged_for_review',
    });
    await verify.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'challenged',
      verification_status: 'verified',
      verification_method: 'source_recheck',
      verification_evidence: 'Checked contradiction operation baseline before promotion.',
      verification_source_refs: ['Fixture verification for challenged'],
      verified_at: '2026-06-16T00:00:00Z',
    });
    await promote.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'challenged',
      review_reason: 'Baseline promoted candidate.',
    });

    await create.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'challenger',
      candidate_type: 'fact',
      proposed_content: 'New contradictory candidate.',
      source_ref: 'User, direct message, 2026-04-24 01:21 AM KST',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/memory-inbox',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'challenger',
      next_status: 'candidate',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'challenger',
      next_status: 'staged_for_review',
    });

    const unresolved = await resolve.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      candidate_id: 'challenger',
      challenged_candidate_id: 'challenged',
      outcome: 'unresolved',
      review_reason: 'Needs more evidence.',
    });
    expect((unresolved as any).contradiction_entry.outcome).toBe('unresolved');
    expect((unresolved as any).candidate.status).toBe('staged_for_review');

    await expect(resolve.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      candidate_id: 'challenger',
      challenged_candidate_id: 'challenged',
      outcome: 'unresolved',
      reviewed_at: '2026-99-99T25:61:61Z',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
