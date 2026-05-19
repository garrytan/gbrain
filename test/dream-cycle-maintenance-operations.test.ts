import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('dream-cycle maintenance operation is registered with CLI hints', () => {
  const operation = operations.find((entry) => entry.name === 'run_dream_cycle_maintenance');
  expect(operation?.cliHints?.name).toBe('run-dream-cycle-maintenance');
  expect(operation?.params.write_candidates.type).toBe('boolean');
  expect(operation?.params.include_derived_freshness.type).toBe('boolean');
  expect(operation?.params.derived_freshness_limit.type).toBe('number');
});

test('dream-cycle maintenance operation supports dry-run without writing candidates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-dream-cycle-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((entry) => entry.name === 'create_memory_candidate_entry');
  const operation = operations.find((entry) => entry.name === 'run_dream_cycle_maintenance');

  if (!create || !operation) {
    throw new Error('dream-cycle operation prerequisites are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await create.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'dream-op-source',
      candidate_type: 'note_update',
      proposed_content: 'Operation dry-run source candidate.',
      source_refs: ['operation'],
      generated_by: 'manual',
      extraction_kind: 'manual',
      confidence_score: 0.7,
      importance_score: 0.6,
      recurrence_score: 0.1,
      target_object_type: 'curated_note',
      target_object_id: 'concepts/dream-cycle-op',
    });

    const result = await operation.handler({ engine, config: {} as any, logger: console, dryRun: true }, {
      scope_id: 'workspace:default',
      now: '2026-04-23T12:00:00.000Z',
      limit: 1,
    }) as any;

    expect(result.write_candidates).toBe(false);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].candidate_id).toBeNull();

    const entries = await engine.listMemoryCandidateEntries({
      scope_id: 'workspace:default',
      limit: 100,
      offset: 0,
    });
    expect(entries.map((entry) => entry.id)).toEqual(['dream-op-source']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dream-cycle maintenance operation defaults to report-only even outside dry-run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-dream-cycle-op-default-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((entry) => entry.name === 'create_memory_candidate_entry');
  const operation = operations.find((entry) => entry.name === 'run_dream_cycle_maintenance');

  if (!create || !operation) {
    throw new Error('dream-cycle operation prerequisites are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await create.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'dream-op-default-source',
      candidate_type: 'note_update',
      proposed_content: 'Operation default source candidate.',
      source_refs: ['operation'],
      generated_by: 'manual',
      extraction_kind: 'manual',
      confidence_score: 0.7,
      importance_score: 0.6,
      recurrence_score: 0.1,
      target_object_type: 'curated_note',
      target_object_id: 'concepts/dream-cycle-op-default',
    });

    const result = await operation.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      scope_id: 'workspace:default',
      now: '2026-04-23T12:00:00.000Z',
      limit: 1,
    }) as any;

    expect(result.write_candidates).toBe(false);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].candidate_id).toBeNull();

    const entries = await engine.listMemoryCandidateEntries({
      scope_id: 'workspace:default',
      limit: 100,
      offset: 0,
    });
    expect(entries.map((entry) => entry.id)).toEqual(['dream-op-default-source']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dream-cycle maintenance operation rejects invalid now strings', async () => {
  const engine = new SQLiteEngine();
  const operation = operations.find((entry) => entry.name === 'run_dream_cycle_maintenance');

  if (!operation) {
    throw new Error('dream-cycle operation is missing');
  }

  await expect(operation.handler({ engine, config: {} as any, logger: console, dryRun: true }, {
    scope_id: 'workspace:default',
    now: 'not-a-date',
  })).rejects.toMatchObject({ code: 'invalid_params' });
});
