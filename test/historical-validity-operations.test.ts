import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('historical validity operation is registered with a CLI hint', () => {
  const operation = operations.find((entry) => entry.name === 'assess_historical_validity');
  expect(operation?.cliHints?.name).toBe('assess-historical-validity');
});

test('historical validity operation assesses a handed-off candidate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-historical-validity-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const create = operations.find((entry) => entry.name === 'create_memory_candidate_entry');
  const advance = operations.find((entry) => entry.name === 'advance_memory_candidate_status');
  const promote = operations.find((entry) => entry.name === 'promote_memory_candidate_entry');
  const handoff = operations.find((entry) => entry.name === 'record_canonical_handoff');
  const assess = operations.find((entry) => entry.name === 'assess_historical_validity');

  if (!create || !advance || !promote || !handoff || !assess) {
    throw new Error('historical validity prerequisite operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await create.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-validity-op',
      candidate_type: 'fact',
      proposed_content: 'Historical validity stays read-only and explicit.',
      source_ref: 'User, direct message, 2026-04-24 8:30 AM KST',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/historical-validity',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-validity-op',
      next_status: 'candidate',
    });
    await advance.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-validity-op',
      next_status: 'staged_for_review',
      review_reason: 'Prepared for validity operation.',
    });
    await promote.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      id: 'candidate-validity-op',
      reviewed_at: '2026-04-24T00:00:00.000Z',
    });
    await handoff.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      candidate_id: 'candidate-validity-op',
      reviewed_at: '2026-04-24T00:05:00.000Z',
    });

    const result = await assess.handler({ engine, config: {} as any, logger: console, dryRun: false }, {
      candidate_id: 'candidate-validity-op',
      now: '2026-04-25T00:00:00.000Z',
    });

    expect((result as any).decision).toBe('allow');
    expect((result as any).recommended_fallback).toBe('none');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('historical validity operation rejects blank candidate ids', async () => {
  const assess = operations.find((entry) => entry.name === 'assess_historical_validity');
  if (!assess) {
    throw new Error('historical validity operation is missing');
  }

  await expect(assess.handler({ engine: {} as any, config: {} as any, logger: console, dryRun: false }, {
    candidate_id: '',
  })).rejects.toMatchObject({ code: 'invalid_params' });
});
