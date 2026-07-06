import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('canonical handoff operations are registered with CLI hints', () => {
  const record = operations.find((operation) => operation.name === 'record_canonical_handoff');
  const list = operations.find((operation) => operation.name === 'list_canonical_handoff_entries');

  expect(record?.cliHints?.name).toBe('record-canonical-handoff');
  expect(record?.params.interaction_id?.type).toBe('string');
  expect(list?.cliHints?.name).toBe('list-canonical-handoffs');
});

test('canonical handoff operations record and list explicit handoff rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-canonical-handoff-ops-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');
  const verify = operations.find((operation) => operation.name === 'verify_memory_candidate_entry');
  const promote = operations.find((operation) => operation.name === 'promote_memory_candidate_entry');
  const record = operations.find((operation) => operation.name === 'record_canonical_handoff');
  const list = operations.find((operation) => operation.name === 'list_canonical_handoff_entries');

  if (!create || !advance || !verify || !promote || !record || !list) {
    throw new Error('canonical handoff prerequisite operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await create.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-handoff-op',
      candidate_type: 'fact',
      proposed_content: 'This candidate can be handed off to canonical memory.',
      source_ref: 'User, direct message, 2026-04-23 4:05 PM KST',
      target_object_type: 'procedure',
      target_object_id: 'procedures/canonical-handoff',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-handoff-op',
      next_status: 'candidate',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-handoff-op',
      next_status: 'staged_for_review',
    });
    await verify.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-handoff-op',
      verification_status: 'verified',
      verification_method: 'source_recheck',
      verification_evidence: 'Checked canonical handoff operation fixture before promotion.',
      verification_source_refs: ['Fixture verification for candidate-handoff-op'],
      verified_at: '2026-06-16T00:00:00Z',
    });
    await promote.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-handoff-op',
    });

    const handoff = await record.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      candidate_id: 'candidate-handoff-op',
      review_reason: 'Explicitly handed off for canonical procedure update.',
      interaction_id: 'trace-handoff-op',
    });

    expect((handoff as any).handoff.target_object_type).toBe('procedure');
    expect((handoff as any).handoff.interaction_id).toBe('trace-handoff-op');

    const listed = await list.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      scope_id: 'workspace:default',
      limit: 10,
    });

    expect((listed as any[])).toHaveLength(1);
    expect((listed as any[])[0].candidate_id).toBe('candidate-handoff-op');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('complete_canonical_handoff operation completes a recorded handoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-canonical-handoff-complete-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');
  const verify = operations.find((operation) => operation.name === 'verify_memory_candidate_entry');
  const promote = operations.find((operation) => operation.name === 'promote_memory_candidate_entry');
  const record = operations.find((operation) => operation.name === 'record_canonical_handoff');
  const complete = operations.find((operation) => operation.name === 'complete_canonical_handoff');

  if (!create || !advance || !verify || !promote || !record || !complete) {
    throw new Error('canonical handoff prerequisite operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await create.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-handoff-complete',
      candidate_type: 'fact',
      proposed_content: 'This candidate handoff can be completed after the page write.',
      source_ref: 'User, direct message, 2026-07-06 10:00 AM KST',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/handoff-completion',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-handoff-complete',
      next_status: 'candidate',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-handoff-complete',
      next_status: 'staged_for_review',
    });
    await verify.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-handoff-complete',
      verification_status: 'verified',
      verification_method: 'source_recheck',
      verification_evidence: 'Checked handoff completion fixture before promotion.',
      verification_source_refs: ['Fixture verification for candidate-handoff-complete'],
      verified_at: '2026-07-06T00:00:00Z',
    });
    await promote.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-handoff-complete',
    });
    const recorded = await record.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      candidate_id: 'candidate-handoff-complete',
    }) as { handoff: { id: string; completed_at: string | null } };
    expect(recorded.handoff.completed_at).toBeNull();

    const completed = await complete.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: recorded.handoff.id,
      completion_kind: 'page_written',
      completion_ref: 'concepts/handoff-completion',
    }) as { id: string; completed_at: string | null; completion_kind: string; completion_ref: string | null };

    expect(completed.id).toBe(recorded.handoff.id);
    expect(completed.completed_at).not.toBeNull();
    expect(completed.completion_kind).toBe('page_written');
    expect(completed.completion_ref).toBe('concepts/handoff-completion');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('complete_canonical_handoff operation rejects unknown handoffs and bad completion kinds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-canonical-handoff-complete-errors-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const complete = operations.find((operation) => operation.name === 'complete_canonical_handoff');
  if (!complete) {
    throw new Error('complete_canonical_handoff operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await expect(complete.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'missing-handoff-id',
      completion_kind: 'manual',
    })).rejects.toMatchObject({ code: 'memory_candidate_not_found' });

    await expect(complete.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'missing-handoff-id',
      completion_kind: 'not-a-kind',
    })).rejects.toMatchObject({ code: 'invalid_params' });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical handoff list operation rejects blank scope filters', async () => {
  const list = operations.find((operation) => operation.name === 'list_canonical_handoff_entries');
  if (!list) {
    throw new Error('canonical handoff list operation is missing');
  }

  await expect(list.handler({ engine: {} as any, config: {} as any, logger: console, dryRun: false }, {
    scope_id: '',
  })).rejects.toMatchObject({ code: 'invalid_params' });
});
