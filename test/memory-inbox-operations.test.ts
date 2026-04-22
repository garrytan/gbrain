import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMemoryInboxOperations } from '../src/core/operations-memory-inbox.ts';
import { operations } from '../src/core/operations.ts';
import { OperationError } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('memory inbox operations can be built from a dedicated domain module', () => {
  const built = createMemoryInboxOperations({
    defaultScopeId: 'workspace:default',
    OperationError,
  });

  expect(built.map((operation) => operation.name)).toEqual([
    'get_memory_candidate_entry',
    'list_memory_candidate_entries',
    'create_memory_candidate_entry',
    'advance_memory_candidate_status',
  ]);
});

test('memory inbox operations are registered with CLI hints', () => {
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const get = operations.find((operation) => operation.name === 'get_memory_candidate_entry');
  const list = operations.find((operation) => operation.name === 'list_memory_candidate_entries');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');

  expect(create?.cliHints?.name).toBe('create-memory-candidate');
  expect(get?.cliHints?.name).toBe('get-memory-candidate');
  expect(list?.cliHints?.name).toBe('list-memory-candidates');
  expect(advance?.cliHints?.name).toBe('advance-memory-candidate-status');
  expect(create?.params.status?.enum).toEqual(['captured', 'candidate', 'staged_for_review']);
  expect(list?.params.status?.enum).toEqual(['captured', 'candidate', 'staged_for_review']);
  expect(advance?.params.next_status?.description).toContain('depends on the current stored status');
});

test('memory inbox operations expose dry-run, direct get, filtered list, and bounded advance behavior', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const get = operations.find((operation) => operation.name === 'get_memory_candidate_entry');
  const list = operations.find((operation) => operation.name === 'list_memory_candidate_entries');
  const advance = operations.find((operation) => operation.name === 'advance_memory_candidate_status');

  if (!create || !get || !list || !advance) {
    throw new Error('memory inbox operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const preview = await create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: true,
    }, {
      candidate_type: 'fact',
      proposed_content: 'Context maps can propose a note update candidate.',
      source_ref: 'User, direct message, 2026-04-22 3:01 PM KST',
    });

    expect((preview as any).dry_run).toBe(true);
    expect((preview as any).action).toBe('create_memory_candidate_entry');
    expect((preview as any).scope_id).toBe('workspace:default');
    expect((preview as any).status).toBe('captured');

    const created = await create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-1',
      candidate_type: 'fact',
      proposed_content: 'Context maps can propose a note update candidate.',
      source_ref: 'User, direct message, 2026-04-22 3:01 PM KST',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/note-manifest',
    });

    expect((created as any).id).toBe('candidate-1');
    expect((created as any).scope_id).toBe('workspace:default');
    expect((created as any).status).toBe('captured');
    expect((created as any).source_refs).toEqual(['User, direct message, 2026-04-22 3:01 PM KST']);

    const loaded = await get.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-1',
    });

    expect((loaded as any).id).toBe('candidate-1');
    expect((loaded as any).candidate_type).toBe('fact');

    const listed = await list.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
      status: 'captured',
      candidate_type: 'fact',
      limit: 10,
    });

    expect((listed as any[]).map((entry) => entry.id)).toEqual(['candidate-1']);

    const advanced = await advance.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-1',
      next_status: 'candidate',
    });

    expect((advanced as any).id).toBe('candidate-1');
    expect((advanced as any).status).toBe('candidate');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox create accepts source_refs arrays and rejects future-only statuses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-op-source-refs-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');

  if (!create) {
    throw new Error('create memory candidate operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const created = await create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-multi-source',
      candidate_type: 'fact',
      proposed_content: 'Multiple provenance strings stay attached to one candidate.',
      source_refs: [
        'User, direct message, 2026-04-23 1:15 PM KST',
        'Meeting notes, Architecture Sync, 2026-04-23 1:20 PM KST',
      ],
    });

    expect((created as any).source_refs).toEqual([
      'User, direct message, 2026-04-23 1:15 PM KST',
      'Meeting notes, Architecture Sync, 2026-04-23 1:20 PM KST',
    ]);

    await expect(create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-invalid-status',
      candidate_type: 'fact',
      proposed_content: 'Future-only statuses should stay hidden in Phase 5.',
      status: 'promoted',
    })).rejects.toBeInstanceOf(OperationError);

    await expect(create.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'candidate-invalid-status',
      candidate_type: 'fact',
      proposed_content: 'Future-only statuses should stay hidden in Phase 5.',
      status: 'promoted',
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory inbox list caps oversized limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-inbox-op-limit-cap-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((operation) => operation.name === 'create_memory_candidate_entry');
  const list = operations.find((operation) => operation.name === 'list_memory_candidate_entries');

  if (!create || !list) {
    throw new Error('memory inbox create/list operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    for (let index = 0; index < 105; index++) {
      await create.handler({
        engine,
        config: {} as any,
        logger: console,
        dryRun: false,
      }, {
        id: `candidate-cap-${index}`,
        candidate_type: 'fact',
        proposed_content: `Candidate ${index}`,
      });
    }

    const listed = await list.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      scope_id: 'workspace:default',
      limit: 999,
    });

    expect((listed as any[])).toHaveLength(100);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
