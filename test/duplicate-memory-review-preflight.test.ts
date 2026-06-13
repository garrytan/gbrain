import { expect, test } from 'bun:test';
import { spawnSync } from 'bun';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { preflightPromoteMemoryCandidate } from '../src/core/services/memory-inbox-service.ts';
import { promoteMemoryCandidateEntry } from '../src/core/services/memory-inbox-promotion-service.ts';
import type { MemoryCandidateEntryInput } from '../src/core/types.ts';

async function withEngine<T>(prefix: string, run: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    return await run(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeCandidateInput(
  id: string,
  overrides: Partial<MemoryCandidateEntryInput> = {},
): MemoryCandidateEntryInput {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'fact',
    proposed_content: 'Existing rollout atlas keeps staged verification notes with rollback owner evidence.',
    source_refs: ['User, direct message, 2026-05-09 10:00 KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.9,
    importance_score: 0.7,
    recurrence_score: 0.2,
    sensitivity: 'work',
    status: 'staged_for_review',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/incoming-review',
    reviewed_at: null,
    review_reason: null,
    ...overrides,
  };
}

async function seedCandidate(
  engine: SQLiteEngine,
  id: string,
  overrides: Partial<MemoryCandidateEntryInput> = {},
) {
  return engine.createMemoryCandidateEntry(makeCandidateInput(id, overrides));
}

test('promotion preflight defers likely duplicate against a different canonical page', async () => {
  await withEngine('mbrain-duplicate-preflight-likely-', async (engine) => {
    await engine.putPage('concepts/existing-rollout', {
      type: 'concept',
      title: 'Existing Rollout',
      compiled_truth: 'Existing rollout atlas keeps staged verification notes with rollback owner evidence.',
      frontmatter: {
        source_refs: ['User, direct message, 2026-05-09 10:00 KST'],
      },
    });
    await seedCandidate(engine, 'incoming-likely-duplicate');

    const result = await preflightPromoteMemoryCandidate(engine, {
      id: 'incoming-likely-duplicate',
    });

    expect(result.decision).toBe('defer');
    expect(result.reasons).toContain('candidate_possible_duplicate');
    expect(result.duplicate_review.decision).toBe('likely_duplicate');
    expect(result.duplicate_review.top_match?.kind).toBe('page');
    expect(result.duplicate_review.top_match?.id).toBe('concepts/existing-rollout');
    expect(result.summary_lines).toContain('Duplicate review decision: likely_duplicate.');
  });
});

test('promotion preflight deny reasons win over likely duplicate deferral', async () => {
  await withEngine('mbrain-duplicate-preflight-deny-wins-', async (engine) => {
    await engine.putPage('concepts/existing-rollout', {
      type: 'concept',
      title: 'Existing Rollout',
      compiled_truth: 'Existing rollout atlas keeps staged verification notes with rollback owner evidence.',
      frontmatter: {
        source_refs: ['User, direct message, 2026-05-09 10:00 KST'],
      },
    });
    await seedCandidate(engine, 'incoming-deny-duplicate', {
      sensitivity: 'personal',
    });

    const result = await preflightPromoteMemoryCandidate(engine, {
      id: 'incoming-deny-duplicate',
    });

    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain('candidate_scope_conflict');
    expect(result.reasons).not.toContain('candidate_possible_duplicate');
    expect(result.duplicate_review.decision).toBe('likely_duplicate');
  });
});

test('promotion preflight allows same-target canonical page updates', async () => {
  await withEngine('mbrain-duplicate-preflight-same-target-', async (engine) => {
    await engine.putPage('concepts/incoming-review', {
      type: 'concept',
      title: 'Incoming Review',
      compiled_truth: 'Review notes track the current rollout owner.',
    });
    await seedCandidate(engine, 'incoming-same-target-update', {
      proposed_content: 'Atlas rollout adds staged verification notes.',
      target_object_id: 'concepts/incoming-review',
    });

    const result = await preflightPromoteMemoryCandidate(engine, {
      id: 'incoming-same-target-update',
    });

    expect(result.decision).toBe('allow');
    expect(result.reasons).toEqual(['candidate_ready_for_promotion']);
    expect(result.duplicate_review.decision).toBe('same_target_update');
    expect(result.duplicate_review.top_match?.kind).toBe('page');
    expect(result.duplicate_review.top_match?.id).toBe('concepts/incoming-review');
  });
});

test('promotion preflight does not hide duplicate pages whose slug matches the candidate id', async () => {
  await withEngine('mbrain-duplicate-preflight-id-collision-', async (engine) => {
    await engine.putPage('incoming-id-collision', {
      type: 'concept',
      title: 'Incoming Id Collision',
      compiled_truth: 'Incoming id collision review keeps staged rollback owner notes and checkpoint evidence.',
      frontmatter: {
        source_refs: ['User, direct message, 2026-05-09 10:00 KST'],
      },
    });
    await seedCandidate(engine, 'incoming-id-collision', {
      proposed_content: 'Incoming id collision review keeps staged rollback owner notes and checkpoint evidence.',
      target_object_id: 'concepts/new-collision-target',
    });

    const result = await preflightPromoteMemoryCandidate(engine, {
      id: 'incoming-id-collision',
    });

    expect(result.decision).toBe('defer');
    expect(result.reasons).toContain('candidate_possible_duplicate');
    expect(result.duplicate_review.top_match?.id).toBe('incoming-id-collision');
  });
});

test('promotion preflight ignores terminal duplicate candidates', async () => {
  await withEngine('mbrain-duplicate-preflight-terminal-candidate-', async (engine) => {
    await seedCandidate(engine, 'terminal-duplicate-candidate');
    await engine.updateMemoryCandidateEntryStatus('terminal-duplicate-candidate', {
      status: 'rejected',
      reviewed_at: new Date('2026-05-09T01:00:00.000Z'),
      review_reason: 'Rejected duplicate no longer blocks promotion.',
    });
    await seedCandidate(engine, 'incoming-terminal-candidate-check', {
      target_object_id: 'concepts/new-terminal-candidate-check',
    });

    const result = await preflightPromoteMemoryCandidate(engine, {
      id: 'incoming-terminal-candidate-check',
    });

    expect(result.decision).toBe('allow');
    expect(result.reasons).toEqual(['candidate_ready_for_promotion']);
    expect(result.duplicate_review.decision).toBe('no_match');
  });
});

test('promotion service fails closed for likely duplicate candidates', async () => {
  await withEngine('mbrain-duplicate-preflight-promote-', async (engine) => {
    await engine.putPage('concepts/existing-rollout', {
      type: 'concept',
      title: 'Existing Rollout',
      compiled_truth: 'Existing rollout atlas keeps staged verification notes with rollback owner evidence.',
      frontmatter: {
        source_refs: ['User, direct message, 2026-05-09 10:00 KST'],
      },
    });
    await seedCandidate(engine, 'incoming-promotion-duplicate');

    await expect(promoteMemoryCandidateEntry(engine, {
      id: 'incoming-promotion-duplicate',
      review_reason: 'Attempt promotion with duplicate review.',
    })).rejects.toMatchObject({
      code: 'promotion_preflight_failed',
    });

    const stored = await engine.getMemoryCandidateEntry('incoming-promotion-duplicate');
    expect(stored?.status).toBe('staged_for_review');
  });
});

test('promotion service fails closed when duplicate review inputs change before promotion', async () => {
  await withEngine('mbrain-duplicate-preflight-stale-', async (engine) => {
    await seedCandidate(engine, 'incoming-stale-preflight', {
      proposed_content: 'Routing checks preserve stable review context.',
      source_refs: ['User, direct message, 2026-05-09 12:00 KST'],
      target_object_id: 'concepts/stale-preflight',
    });

    const originalListPages = engine.listPages.bind(engine);
    const originalPutPage = engine.putPage.bind(engine);
    let listPagesCalls = 0;
    engine.listPages = async (filters) => {
      listPagesCalls += 1;
      if (listPagesCalls === 3) {
        await originalPutPage('concepts/unrelated-change', {
          type: 'concept',
          title: 'Unrelated Change',
          compiled_truth: 'An unrelated page changed during duplicate review.',
        });
      }
      return originalListPages(filters);
    };

    await expect(promoteMemoryCandidateEntry(engine, {
      id: 'incoming-stale-preflight',
      review_reason: 'Attempt promotion with stale duplicate review inputs.',
    })).rejects.toMatchObject({
      code: 'promotion_preflight_failed',
      message: expect.stringContaining('pages added: concepts/unrelated-change'),
    });

    const stored = await engine.getMemoryCandidateEntry('incoming-stale-preflight');
    expect(stored?.status).toBe('staged_for_review');
  });
});

test('promotion service retries once when duplicate review inputs change and retry_on_stale is enabled', async () => {
  await withEngine('mbrain-duplicate-preflight-stale-retry-', async (engine) => {
    await seedCandidate(engine, 'incoming-stale-preflight-retry', {
      proposed_content: 'Routing checks preserve stable review context.',
      source_refs: ['User, direct message, 2026-05-09 12:00 KST'],
      target_object_id: 'concepts/stale-preflight-retry',
    });

    const originalListPages = engine.listPages.bind(engine);
    const originalPutPage = engine.putPage.bind(engine);
    let listPagesCalls = 0;
    engine.listPages = async (filters) => {
      listPagesCalls += 1;
      if (listPagesCalls === 3) {
        await originalPutPage('concepts/unrelated-change-retry', {
          type: 'concept',
          title: 'Unrelated Change Retry',
          compiled_truth: 'An unrelated page changed between duplicate review and promotion.',
        });
      }
      return originalListPages(filters);
    };

    const promoted = await promoteMemoryCandidateEntry(engine, {
      id: 'incoming-stale-preflight-retry',
      review_reason: 'Retry promotion after stale duplicate review inputs.',
      retry_on_stale: true,
    });

    expect(promoted.status).toBe('promoted');
    expect(promoted.review_reason).toBe('Retry promotion after stale duplicate review inputs.');
    expect(await engine.listMemoryCandidateStatusEvents({
      candidate_id: 'incoming-stale-preflight-retry',
      event_kind: 'promoted',
      limit: 10,
    })).toHaveLength(1);
    expect(listPagesCalls).toBeGreaterThan(3);
  });
});

test('promotion service retries transaction-side duplicate review freshness changes', async () => {
  await withEngine('mbrain-duplicate-preflight-write-stale-retry-', async (engine) => {
    await seedCandidate(engine, 'incoming-write-stale-preflight-retry', {
      proposed_content: 'Routing checks preserve stable review context inside the write transaction.',
      source_refs: ['User, direct message, 2026-05-09 12:10 KST'],
      target_object_id: 'concepts/write-stale-preflight-retry',
    });

    const originalPutPage = engine.putPage.bind(engine);
    const originalTransaction = engine.transaction.bind(engine);
    let transactionCalls = 0;
    engine.transaction = async (fn) => {
      transactionCalls += 1;
      if (transactionCalls === 1) {
        await originalPutPage('concepts/transaction-side-change-retry', {
          type: 'concept',
          title: 'Transaction Side Change Retry',
          compiled_truth: 'A page changed after preflight and before the transactional promotion write.',
        });
      }
      return originalTransaction(fn);
    };

    const promoted = await promoteMemoryCandidateEntry(engine, {
      id: 'incoming-write-stale-preflight-retry',
      review_reason: 'Retry promotion after transaction-side stale duplicate review inputs.',
      retry_on_stale: true,
    });

    expect(promoted.status).toBe('promoted');
    expect(promoted.review_reason).toBe('Retry promotion after transaction-side stale duplicate review inputs.');
    expect(await engine.listMemoryCandidateStatusEvents({
      candidate_id: 'incoming-write-stale-preflight-retry',
      event_kind: 'promoted',
      limit: 10,
    })).toHaveLength(1);
    expect(transactionCalls).toBe(2);
  });
});

test('promote-memory-candidate CLI help exposes retry-on-stale', () => {
  const proc = spawnSync(['bun', 'run', 'src/cli.ts', 'promote-memory-candidate', '--help'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(proc.exitCode).toBe(0);
  expect(new TextDecoder().decode(proc.stdout)).toContain('--retry-on-stale');
});

test('promotion preflight allow path includes no-match duplicate review', async () => {
  await withEngine('mbrain-duplicate-preflight-no-match-', async (engine) => {
    await seedCandidate(engine, 'incoming-no-match', {
      proposed_content: 'Signal routing prefers bounded lookup context for operator prompts.',
      source_refs: ['User, direct message, 2026-05-09 11:00 KST'],
      target_object_id: 'concepts/signal-routing',
    });

    const result = await preflightPromoteMemoryCandidate(engine, {
      id: 'incoming-no-match',
    });

    expect(result.decision).toBe('allow');
    expect(result.reasons).toEqual(['candidate_ready_for_promotion']);
    expect(result.duplicate_review.decision).toBe('no_match');
    expect(result.duplicate_review.top_match).toBeUndefined();
    expect(result.summary_lines).toContain('Duplicate review decision: no_match.');
  });
});
