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
  const promote = operations.find((operation) => operation.name === 'promote_memory_candidate_entry');
  const record = operations.find((operation) => operation.name === 'record_canonical_handoff');
  const list = operations.find((operation) => operation.name === 'list_canonical_handoff_entries');

  if (!create || !advance || !promote || !record || !list) {
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

test('canonical handoff list operation rejects blank scope filters', async () => {
  const list = operations.find((operation) => operation.name === 'list_canonical_handoff_entries');
  if (!list) {
    throw new Error('canonical handoff list operation is missing');
  }

  await expect(list.handler({ engine: {} as any, config: {} as any, logger: console, dryRun: false }, {
    scope_id: '',
  })).rejects.toMatchObject({ code: 'invalid_params' });
});
