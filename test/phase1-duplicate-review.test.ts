import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { Operation } from '../src/core/operations.ts';

function findOperation(name: string): Operation {
  const operation = operations.find((entry) => entry.name === name);
  if (!operation) {
    throw new Error(`Missing operation: ${name}`);
  }
  return operation;
}

async function withSQLiteEngine<T>(fn: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-phase1-duplicate-review-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    return await fn(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function operationContext(engine: SQLiteEngine) {
  return {
    engine,
    config: {} as any,
    logger: console,
    dryRun: false,
  };
}

test('phase 1 duplicate review defers promotion for likely duplicate candidate', async () => {
  await withSQLiteEngine(async (engine) => {
    await engine.putPage('concepts/phase1-review-target', {
      type: 'concept',
      title: 'Phase 1 Review Target',
      compiled_truth: 'Phase 1 duplicate review keeps staged verification notes with reviewer checkpoint evidence.',
      frontmatter: {
        source_refs: ['User, direct message, 2026-05-09 13:00 KST'],
      },
    });

    const create = findOperation('create_memory_candidate_entry');
    const createResult = await create.handler(operationContext(engine), {
      id: 'candidate-phase1-likely-duplicate',
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      proposed_content: 'Phase 1 Review Target. Phase 1 duplicate review keeps staged verification notes with reviewer checkpoint evidence.',
      source_refs: ['User, direct message, 2026-05-09 13:00 KST'],
      status: 'staged_for_review',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/phase1-incoming',
      include_duplicate_review: true,
    }) as any;

    expect(Object.keys(createResult).sort()).toEqual(['candidate', 'duplicate_review']);
    expect(createResult.candidate.id).toBe('candidate-phase1-likely-duplicate');
    expect(createResult.duplicate_review.decision).toBe('likely_duplicate');

    const preflight = findOperation('preflight_promote_memory_candidate');
    const preflightResult = await preflight.handler(operationContext(engine), {
      id: createResult.candidate.id,
    }) as any;

    expect(preflightResult.decision).toBe('defer');
    expect(preflightResult.reasons).toContain('candidate_possible_duplicate');
    expect(preflightResult.duplicate_review.top_match?.id).toBe('concepts/phase1-review-target');
  });
});
