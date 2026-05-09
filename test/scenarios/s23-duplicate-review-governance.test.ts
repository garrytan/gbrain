/**
 * Scenario S23 - Duplicate review governance.
 *
 * Falsifies governance contracts around duplicate detection, review summaries,
 * and promotion gating when canonical pages, unresolved candidates, and terminal
 * candidates coexist.
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { allocateSqliteBrain, seedMemoryCandidate } from './helpers.ts';
import { OperationError, operations } from '../../src/core/operations.ts';
import { rejectMemoryCandidateEntry } from '../../src/core/services/memory-inbox-service.ts';
import type { Operation, OperationContext } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const scopeId = 'workspace:default';
const sourceRefs = ['User, direct message, 2026-05-09 10:00 KST'];
const duplicateClaim = 'Atlas rollout duplicate review keeps staged verification notes with rollback owner evidence.';

function findOperation(name: string): Operation {
  const operation = operations.find((entry) => entry.name === name);
  if (!operation) {
    throw new Error(`Missing operation: ${name}`);
  }
  return operation;
}

function operationContext(engine: BrainEngine, dryRun = false): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: console,
    dryRun,
  };
}

async function seedSameTargetCandidates(engine: BrainEngine, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await seedMemoryCandidate(engine, {
      id: `same-target-crowding-${index}`,
      status: 'staged_for_review',
      scope_id: scopeId,
      candidate_type: 'note_update',
      proposed_content: duplicateClaim,
      source_refs: sourceRefs,
      target_object_type: 'curated_note',
      target_object_id: 'concepts/review-working-target',
    });
  }
}

describe('S23 - duplicate review governance', () => {
  test('public review path keeps page-type context explicit', async () => {
    const handle = await allocateSqliteBrain('s23-page-type');

    try {
      await handle.engine.putPage('concepts/typed-review-target', {
        type: 'concept',
        title: 'Typed Review Target',
        compiled_truth: 'Typed duplicate review evidence stays bounded to the requested page class.',
      });

      const review = findOperation('review_duplicate_memory');
      const projectScoped = await review.handler(operationContext(handle.engine), {
        subject_kind: 'proposed_memory',
        title: 'Typed Review Target',
        content: 'Typed duplicate review evidence stays bounded to the requested page class.',
        page_type: 'project',
        include_pages: true,
        include_candidates: false,
        limit: 5,
      }) as any;
      const conceptScoped = await review.handler(operationContext(handle.engine), {
        subject_kind: 'proposed_memory',
        title: 'Typed Review Target',
        content: 'Typed duplicate review evidence stays bounded to the requested page class.',
        page_type: 'concept',
        include_pages: true,
        include_candidates: false,
        limit: 5,
      }) as any;

      expect(projectScoped.decision).toBe('no_match');
      expect(projectScoped.matches).toEqual([]);
      expect(conceptScoped.decision).toBe('likely_duplicate');
      expect(conceptScoped.matches[0]?.id).toBe('concepts/typed-review-target');
    } finally {
      await handle.teardown();
    }
  });

  test('candidate capture can opt into review without changing default or dry-run output shape', async () => {
    const handle = await allocateSqliteBrain('s23-capture-shape');

    try {
      await handle.engine.putPage('projects/same-target-capture', {
        type: 'project',
        title: 'Same Target Capture',
        compiled_truth: 'Same target capture pages keep reviewer status and staged rollout notes.',
      });

      const create = findOperation('create_memory_candidate_entry');
      const defaultResult = await create.handler(operationContext(handle.engine), {
        id: 'candidate-default-output',
        scope_id: scopeId,
        candidate_type: 'fact',
        proposed_content: 'Default capture output remains a direct candidate object.',
        source_refs: sourceRefs,
      }) as any;
      const dryRunResult = await create.handler(operationContext(handle.engine, true), {
        id: 'candidate-dry-run-output',
        scope_id: scopeId,
        candidate_type: 'fact',
        proposed_content: 'Dry run duplicate review stays out of the response shape.',
        source_refs: sourceRefs,
        include_duplicate_review: true,
      }) as any;
      const optInResult = await create.handler(operationContext(handle.engine), {
        id: 'candidate-review-output',
        scope_id: scopeId,
        candidate_type: 'note_update',
        proposed_content: 'Same target capture pages keep reviewer status and staged rollout notes.',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'projects/same-target-capture',
        include_duplicate_review: true,
      }) as any;

      expect(defaultResult.id).toBe('candidate-default-output');
      expect(defaultResult.candidate).toBeUndefined();
      expect(defaultResult.duplicate_review).toBeUndefined();
      expect(dryRunResult).toEqual({
        dry_run: true,
        action: 'create_memory_candidate_entry',
        id: 'candidate-dry-run-output',
        scope_id: scopeId,
        candidate_type: 'fact',
        status: 'captured',
      });
      expect(optInResult.candidate.id).toBe('candidate-review-output');
      expect(optInResult.duplicate_review.decision).toBe('same_target_update');
      expect(optInResult.duplicate_review.matches[0]?.id).toBe('projects/same-target-capture');
    } finally {
      await handle.teardown();
    }
  });

  test('preflight reports the blocking duplicate even when same-target candidates crowd visible matches', async () => {
    const handle = await allocateSqliteBrain('s23-crowded-preflight');

    try {
      await handle.engine.putPage('concepts/existing-rollout-atlas', {
        type: 'concept',
        title: 'Atlas Rollout Duplicate Review',
        compiled_truth: duplicateClaim,
        frontmatter: {
          source_refs: sourceRefs,
        },
      });
      await seedSameTargetCandidates(handle.engine, 6);
      await seedMemoryCandidate(handle.engine, {
        id: 'incoming-crowded-review',
        status: 'staged_for_review',
        scope_id: scopeId,
        candidate_type: 'note_update',
        proposed_content: duplicateClaim,
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/review-working-target',
      });

      const review = findOperation('review_duplicate_memory');
      const preflight = findOperation('preflight_promote_memory_candidate');
      const reviewResult = await review.handler(operationContext(handle.engine), {
        scope_id: scopeId,
        subject_kind: 'memory_candidate',
        subject_id: 'incoming-crowded-review',
        content: duplicateClaim,
        source_refs: sourceRefs,
        candidate_type: 'note_update',
        target_object_type: 'curated_note',
        target_object_id: 'concepts/review-working-target',
        include_pages: true,
        include_candidates: true,
        limit: 5,
      }) as any;
      const preflightResult = await preflight.handler(operationContext(handle.engine), {
        id: 'incoming-crowded-review',
      }) as any;

      expect(reviewResult.decision).toBe('likely_duplicate');
      expect(reviewResult.matches).toHaveLength(5);
      expect(reviewResult.matches.map((match: any) => match.id)).not.toContain('concepts/existing-rollout-atlas');
      expect(reviewResult.decision_match?.id).toBe('concepts/existing-rollout-atlas');
      expect(preflightResult.decision).toBe('defer');
      expect(preflightResult.reasons).toContain('candidate_possible_duplicate');
      expect(preflightResult.duplicate_review.top_match?.id).toBe('concepts/existing-rollout-atlas');
    } finally {
      await handle.teardown();
    }
  });

  test('terminal candidate echoes do not block the promotion operation', async () => {
    const handle = await allocateSqliteBrain('s23-terminal-promotion');

    try {
      await seedMemoryCandidate(handle.engine, {
        id: 'terminal-echo-candidate',
        status: 'staged_for_review',
        scope_id: scopeId,
        proposed_content: duplicateClaim,
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/terminal-echo',
      });
      await rejectMemoryCandidateEntry(handle.engine, {
        id: 'terminal-echo-candidate',
        reviewed_at: '2026-05-09T01:00:00.000Z',
        review_reason: 'Rejected echo should not block later promotion.',
      });
      await seedMemoryCandidate(handle.engine, {
        id: 'incoming-after-terminal-echo',
        status: 'staged_for_review',
        scope_id: scopeId,
        proposed_content: duplicateClaim,
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/new-terminal-target',
      });

      const preflight = findOperation('preflight_promote_memory_candidate');
      const promote = findOperation('promote_memory_candidate_entry');
      const preflightResult = await preflight.handler(operationContext(handle.engine), {
        id: 'incoming-after-terminal-echo',
      }) as any;
      const promoted = await promote.handler(operationContext(handle.engine), {
        id: 'incoming-after-terminal-echo',
        reviewed_at: '2026-05-09T02:00:00.000Z',
        review_reason: 'Scenario promotion after terminal echo.',
      }) as any;

      expect(preflightResult.decision).toBe('allow');
      expect(preflightResult.duplicate_review.decision).toBe('no_match');
      expect(promoted.status).toBe('promoted');
      const terminal = await handle.engine.getMemoryCandidateEntry('terminal-echo-candidate');
      expect(terminal?.status).toBe('rejected');
    } finally {
      await handle.teardown();
    }
  });

  test('candidate id and page slug collisions still defer as page duplicates', async () => {
    const handle = await allocateSqliteBrain('s23-id-collision');

    try {
      await handle.engine.putPage('incoming-id-collision', {
        type: 'concept',
        title: 'Incoming Id Collision',
        compiled_truth: 'Incoming id collision review keeps staged rollback owner notes and checkpoint evidence.',
        frontmatter: {
          source_refs: sourceRefs,
        },
      });

      const create = findOperation('create_memory_candidate_entry');
      const preflight = findOperation('preflight_promote_memory_candidate');
      const created = await create.handler(operationContext(handle.engine), {
        id: 'incoming-id-collision',
        scope_id: scopeId,
        candidate_type: 'fact',
        proposed_content: 'Incoming id collision review keeps staged rollback owner notes and checkpoint evidence.',
        source_refs: sourceRefs,
        status: 'staged_for_review',
        target_object_type: 'curated_note',
        target_object_id: 'concepts/new-collision-target',
        include_duplicate_review: true,
      }) as any;
      const preflightResult = await preflight.handler(operationContext(handle.engine), {
        id: 'incoming-id-collision',
      }) as any;

      expect(created.duplicate_review.decision).toBe('likely_duplicate');
      expect(created.duplicate_review.decision_match?.id).toBe('incoming-id-collision');
      expect(preflightResult.decision).toBe('defer');
      expect(preflightResult.duplicate_review.top_match?.id).toBe('incoming-id-collision');
    } finally {
      await handle.teardown();
    }
  });

  test('README registers S23 in the scenario contract table', async () => {
    const readme = await readFile(join(import.meta.dir, 'README.md'), 'utf8');
    expect(readme).toContain('S23');
    expect(readme).toContain('s23-duplicate-review-governance.test.ts');
  });
});
