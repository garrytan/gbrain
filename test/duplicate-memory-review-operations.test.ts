import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMemoryInboxOperations } from '../src/core/operations-memory-inbox.ts';
import { OperationError, operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { Operation } from '../src/core/operations.ts';
import type { DuplicateMemoryReviewInput } from '../src/core/services/duplicate-memory-review-service.ts';

function findOperation(name: string, source: Operation[] = operations): Operation {
  const operation = source.find((entry) => entry.name === name);
  if (!operation) {
    throw new Error(`Missing operation: ${name}`);
  }
  return operation;
}

async function withSQLiteEngine<T>(fn: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-duplicate-review-op-'));
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

function operationContext(engine: SQLiteEngine, dryRun = false) {
  return {
    engine,
    config: {} as any,
    logger: console,
    dryRun,
  };
}

const serviceInputWithPageType: DuplicateMemoryReviewInput = {
  subject_kind: 'proposed_memory',
  content: 'Typed service input accepts page type context.',
  page_type: 'project',
};

test('review_duplicate_memory is registered with CLI hints', () => {
  const built = createMemoryInboxOperations({
    defaultScopeId: 'workspace:default',
    OperationError,
  });
  const builtReview = findOperation('review_duplicate_memory', built);
  const globalReview = findOperation('review_duplicate_memory');

  expect(builtReview.cliHints?.name).toBe('review-duplicate-memory');
  expect(globalReview.cliHints?.name).toBe('review-duplicate-memory');
  expect(globalReview.cliHints?.aliases).toEqual({ n: 'limit' });
});

test('review_duplicate_memory returns a likely duplicate page match', async () => {
  await withSQLiteEngine(async (engine) => {
    await engine.putPage('projects/duplicate-review-target', {
      type: 'project',
      title: 'Duplicate Review Target',
      compiled_truth: 'The duplicate review target uses staged updates with reviewer checkpoints.',
    });
    await engine.addTag('projects/duplicate-review-target', 'duplicate-review');

    const review = findOperation('review_duplicate_memory');
    const result = await review.handler(operationContext(engine), {
      subject_kind: 'proposed_memory',
      title: 'Duplicate review target',
      content: 'The duplicate review target uses staged updates with reviewer checkpoints.',
      tags: ['duplicate-review'],
      include_pages: true,
      include_candidates: false,
      limit: 5,
    }) as any;

    expect(result.decision).toBe('likely_duplicate');
    expect(result.matches[0]?.kind).toBe('page');
    expect(result.matches[0]?.id).toBe('projects/duplicate-review-target');
  });
});

test('review_duplicate_memory accepts valid page type and rejects invalid page type', async () => {
  expect(serviceInputWithPageType.page_type).toBe('project');

  await withSQLiteEngine(async (engine) => {
    const review = findOperation('review_duplicate_memory');

    const result = await review.handler(operationContext(engine), {
      subject_kind: 'proposed_memory',
      content: 'Valid page type context should be accepted.',
      page_type: 'project',
      include_pages: false,
      include_candidates: false,
    }) as any;
    expect(result.decision).toBe('no_match');

    await expect(review.handler(operationContext(engine), {
      subject_kind: 'proposed_memory',
      content: 'Invalid page type context should be rejected.',
      page_type: 'invalid-page-type',
    })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

test('review_duplicate_memory rejects non-boolean include flags', async () => {
  await withSQLiteEngine(async (engine) => {
    const review = findOperation('review_duplicate_memory');

    await expect(review.handler(operationContext(engine), {
      subject_kind: 'proposed_memory',
      content: 'Include pages must be boolean when present.',
      include_pages: 'false',
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(review.handler(operationContext(engine), {
      subject_kind: 'proposed_memory',
      content: 'Include candidates must be boolean when present.',
      include_candidates: 1,
    })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

test('review_duplicate_memory rejects invalid subject kind and blank content', async () => {
  await withSQLiteEngine(async (engine) => {
    const review = findOperation('review_duplicate_memory');

    await expect(review.handler(operationContext(engine), {
      subject_kind: 'candidate',
      content: 'Memory review content.',
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(review.handler(operationContext(engine), {
      subject_kind: 'proposed_memory',
      content: '   ',
    })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

test('create_memory_candidate_entry rejects non-boolean include_duplicate_review', async () => {
  await withSQLiteEngine(async (engine) => {
    const create = findOperation('create_memory_candidate_entry');

    await expect(create.handler(operationContext(engine), {
      id: 'candidate-invalid-include-review',
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      proposed_content: 'Include duplicate review must be boolean when present.',
      source_refs: ['User, direct message, 2026-05-09 09:10 KST'],
      include_duplicate_review: 'true',
    })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

test('create_memory_candidate_entry dry-run ignores duplicate review output', async () => {
  await withSQLiteEngine(async (engine) => {
    const create = findOperation('create_memory_candidate_entry');
    const result = await create.handler(operationContext(engine, true), {
      id: 'candidate-dry-run-review',
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      proposed_content: 'Dry-run output shape stays unchanged.',
      source_refs: ['User, direct message, 2026-05-09 09:15 KST'],
      include_duplicate_review: true,
    }) as any;

    expect(result).toEqual({
      dry_run: true,
      action: 'create_memory_candidate_entry',
      id: 'candidate-dry-run-review',
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      status: 'captured',
    });
    expect(result.duplicate_review).toBeUndefined();
  });
});

test('create_memory_candidate_entry duplicate review failure does not leave a candidate behind', async () => {
  await withSQLiteEngine(async (engine) => {
    const create = findOperation('create_memory_candidate_entry');
    (engine as any).listPages = async () => {
      throw new Error('duplicate review failed');
    };

    await expect(create.handler(operationContext(engine), {
      id: 'candidate-review-failure',
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      proposed_content: 'Candidate should not be stored when duplicate review fails.',
      source_refs: ['User, direct message, 2026-05-09 09:20 KST'],
      include_duplicate_review: true,
    })).rejects.toThrow('duplicate review failed');

    expect(await engine.getMemoryCandidateEntry('candidate-review-failure')).toBeNull();
  });
});

test('create_memory_candidate_entry can include duplicate review for same target page update', async () => {
  await withSQLiteEngine(async (engine) => {
    await engine.putPage('projects/same-target-update', {
      type: 'project',
      title: 'Same Target Update',
      compiled_truth: 'The same target update page tracks staged review notes.',
    });

    const create = findOperation('create_memory_candidate_entry');
    const result = await create.handler(operationContext(engine), {
      id: 'candidate-with-review',
      scope_id: 'workspace:default',
      candidate_type: 'note_update',
      proposed_content: 'The same target update page should track staged review notes and reviewer status.',
      source_refs: ['User, direct message, 2026-05-09 09:00 KST'],
      target_object_type: 'curated_note',
      target_object_id: 'projects/same-target-update',
      include_duplicate_review: true,
    }) as any;

    expect(result.candidate.id).toBe('candidate-with-review');
    expect(result.duplicate_review.decision).toBe('same_target_update');
    expect(result.duplicate_review.matches[0]?.kind).toBe('page');
    expect(result.duplicate_review.matches[0]?.id).toBe('projects/same-target-update');
  });
});

test('create_memory_candidate_entry default output remains the direct candidate object', async () => {
  await withSQLiteEngine(async (engine) => {
    const create = findOperation('create_memory_candidate_entry');
    const result = await create.handler(operationContext(engine), {
      id: 'candidate-default-shape',
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      proposed_content: 'Default output shape stays direct.',
      source_refs: ['User, direct message, 2026-05-09 09:05 KST'],
    }) as any;

    expect(result.id).toBe('candidate-default-shape');
    expect(result.candidate).toBeUndefined();
    expect(result.duplicate_review).toBeUndefined();
  });
});
