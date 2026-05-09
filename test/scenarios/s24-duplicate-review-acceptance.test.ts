/**
 * Scenario S24 - Duplicate review acceptance.
 *
 * This scenario is derived from the duplicate-review design goals, not from the
 * implementation shape:
 *
 * - Operators can run a local/offline review scan and see the full decision
 *   vocabulary with ranked evidence.
 * - Governed writes that request duplicate evidence must not silently write an
 *   unreviewed candidate if the review cannot be produced.
 * - Promotion must fail closed for unresolved likely duplicates and stale
 *   review inputs.
 * - Same-target updates may be promoted, but duplicate review must not rewrite
 *   canonical pages or create canonical handoff records by itself.
 * - Candidate duplicate checks are scoped to the candidate's review scope.
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { allocateSqliteBrain, seedMemoryCandidate } from './helpers.ts';
import { createMemoryInboxOperations } from '../../src/core/operations-memory-inbox.ts';
import { OperationError, operations } from '../../src/core/operations.ts';
import { promoteMemoryCandidateEntry } from '../../src/core/services/memory-inbox-promotion-service.ts';
import { supersedeMemoryCandidateEntry } from '../../src/core/services/memory-inbox-supersession-service.ts';
import { handleToolCall } from '../../src/mcp/server.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { Operation, OperationContext } from '../../src/core/operations.ts';

const defaultScope = 'workspace:default';
const otherScope = 'workspace:other';
const sourceRefs = ['User, direct message, 2026-05-09 10:00 KST'];
const canonicalDuplicateClaim = 'Release readiness ledger keeps rollback owner checkpoint evidence and staged approval notes.';
const candidateDuplicateClaim = 'Candidate grouping signal stores rollback owner checkpoint evidence and staged approval notes.';

function findOperation(name: string, source: Operation[] = operations): Operation {
  const operation = source.find((entry) => entry.name === name);
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

describe('S24 - duplicate review acceptance', () => {
  test('operator scan exposes all review decisions with ranked evidence and remains read-only', async () => {
    const handle = await allocateSqliteBrain('s24-decision-taxonomy');

    try {
      await handle.engine.putPage('concepts/likely-review-match', {
        type: 'concept',
        title: 'Release Readiness Ledger Rollback Owner',
        compiled_truth: canonicalDuplicateClaim,
        frontmatter: {
          source_refs: sourceRefs,
        },
      });
      await handle.engine.putPage('concepts/possible-review-match', {
        type: 'concept',
        title: 'Deployment Calendar',
        compiled_truth: 'Deployment calendar tracks operator review window checklist guardrails.',
      });
      await handle.engine.putPage('concepts/same-target-review', {
        type: 'concept',
        title: 'Same Target Review',
        compiled_truth: 'Same target review keeps concise canonical notes.',
      });
      await seedMemoryCandidate(handle.engine, {
        id: 'read-only-review-candidate',
        status: 'staged_for_review',
        scope_id: defaultScope,
        candidate_type: 'note_update',
        proposed_content: candidateDuplicateClaim,
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/read-only-review-target',
      });

      const beforePage = await handle.engine.getPage('concepts/same-target-review');
      const beforeCandidate = await handle.engine.getMemoryCandidateEntry('read-only-review-candidate');
      const beforeEvents = await handle.engine.listMemoryCandidateStatusEvents({
        candidate_id: 'read-only-review-candidate',
      });
      const review = findOperation('review_duplicate_memory');

      const noMatch = await review.handler(operationContext(handle.engine), {
        subject_kind: 'proposed_memory',
        content: 'Coffee grinder calibration prefers water temperature notes and brew recipes.',
        include_pages: true,
        include_candidates: false,
        limit: 5,
      }) as any;
      const possibleDuplicate = await review.handler(operationContext(handle.engine), {
        subject_kind: 'proposed_memory',
        content: 'Deployment calendar tracks operator review window and checklist approval guardrails.',
        include_pages: true,
        include_candidates: false,
        limit: 5,
      }) as any;
      const likelyDuplicate = await review.handler(operationContext(handle.engine), {
        subject_kind: 'proposed_memory',
        title: 'Release Readiness Ledger',
        content: canonicalDuplicateClaim,
        source_refs: sourceRefs,
        include_pages: true,
        include_candidates: false,
        limit: 5,
      }) as any;
      const sameTargetUpdate = await review.handler(operationContext(handle.engine), {
        subject_kind: 'proposed_memory',
        content: 'Same target review adds one new operational checkpoint.',
        target_object_id: 'concepts/same-target-review',
        include_pages: true,
        include_candidates: false,
        limit: 5,
      }) as any;

      expect(noMatch.decision).toBe('no_match');
      expect(noMatch.matches).toEqual([]);
      expect(possibleDuplicate.decision).toBe('possible_duplicate');
      expect(possibleDuplicate.matches[0]?.id).toBe('concepts/possible-review-match');
      expect(possibleDuplicate.matches[0]?.score).toBeGreaterThanOrEqual(
        possibleDuplicate.thresholds.possible_duplicate,
      );
      expect(possibleDuplicate.matches[0]?.score).toBeLessThan(
        possibleDuplicate.thresholds.likely_duplicate,
      );
      expect(possibleDuplicate.matches[0]?.reasons).toContain('content overlap');
      expect(likelyDuplicate.decision).toBe('likely_duplicate');
      expect(likelyDuplicate.matches[0]?.id).toBe('concepts/likely-review-match');
      expect(likelyDuplicate.matches[0]?.reasons.length).toBeGreaterThan(0);
      expect(sameTargetUpdate.decision).toBe('same_target_update');
      expect(sameTargetUpdate.matches[0]?.reasons).toContain('same target object');

      const afterPage = await handle.engine.getPage('concepts/same-target-review');
      const afterCandidate = await handle.engine.getMemoryCandidateEntry('read-only-review-candidate');
      const afterEvents = await handle.engine.listMemoryCandidateStatusEvents({
        candidate_id: 'read-only-review-candidate',
      });
      expect(afterPage?.compiled_truth).toBe(beforePage?.compiled_truth);
      expect(afterCandidate?.status).toBe(beforeCandidate?.status);
      expect(afterCandidate?.recurrence_score).toBe(beforeCandidate?.recurrence_score);
      expect(afterEvents).toHaveLength(beforeEvents.length);
    } finally {
      await handle.teardown();
    }
  });

  test('operation registry exposes duplicate review through domain and global entry points', () => {
    const domainOperations = createMemoryInboxOperations({
      defaultScopeId: defaultScope,
      OperationError,
    });

    expect(findOperation('review_duplicate_memory', domainOperations).cliHints?.name).toBe(
      'review-duplicate-memory',
    );
    expect(findOperation('review_duplicate_memory').cliHints?.name).toBe('review-duplicate-memory');
  });

  test('MCP-compatible tool dispatch exposes duplicate review without mutation authority', async () => {
    const handle = await allocateSqliteBrain('s24-tool-dispatch');

    try {
      await handle.engine.putPage('concepts/tool-dispatch-match', {
        type: 'concept',
        title: 'Tool Dispatch Review',
        compiled_truth: 'Tool dispatch review keeps rollback evidence and reviewer checkpoint notes.',
        frontmatter: {
          source_refs: sourceRefs,
        },
      });
      const beforePage = await handle.engine.getPage('concepts/tool-dispatch-match');
      const result = await handleToolCall(handle.engine, 'review_duplicate_memory', {
        subject_kind: 'proposed_memory',
        title: 'Tool Dispatch Review',
        content: 'Tool dispatch review keeps rollback evidence and reviewer checkpoint notes.',
        source_refs: sourceRefs,
        include_pages: true,
        include_candidates: false,
        limit: 5,
      }) as any;

      const afterPage = await handle.engine.getPage('concepts/tool-dispatch-match');
      expect(result.decision).toBe('likely_duplicate');
      expect(result.matches[0]?.id).toBe('concepts/tool-dispatch-match');
      expect(afterPage?.compiled_truth).toBe(beforePage?.compiled_truth);
      expect(afterPage?.updated_at.toISOString()).toBe(beforePage?.updated_at.toISOString());
    } finally {
      await handle.teardown();
    }
  });

  test('opt-in candidate creation is atomic when duplicate evidence cannot be produced', async () => {
    const handle = await allocateSqliteBrain('s24-create-atomic');

    try {
      const create = findOperation('create_memory_candidate_entry');
      const originalListPages = handle.engine.listPages.bind(handle.engine);
      handle.engine.listPages = async () => {
        throw new Error('simulated duplicate review outage');
      };

      await expect(create.handler(operationContext(handle.engine), {
        id: 'candidate-review-outage',
        scope_id: defaultScope,
        candidate_type: 'fact',
        proposed_content: 'Candidate must not be stored without requested duplicate evidence.',
        source_refs: sourceRefs,
        include_duplicate_review: true,
      })).rejects.toThrow('simulated duplicate review outage');

      handle.engine.listPages = originalListPages;
      expect(await handle.engine.getMemoryCandidateEntry('candidate-review-outage')).toBeNull();
      expect(await handle.engine.listMemoryCandidateStatusEvents({
        candidate_id: 'candidate-review-outage',
      })).toEqual([]);
    } finally {
      await handle.teardown();
    }
  });

  test('promotion fail-closed leaves candidate status, canonical page, and handoff records unchanged', async () => {
    const handle = await allocateSqliteBrain('s24-promotion-fail-closed');

    try {
      await handle.engine.putPage('concepts/existing-canonical-duplicate', {
        type: 'concept',
        title: 'Release Readiness Ledger Rollback Owner',
        compiled_truth: canonicalDuplicateClaim,
        frontmatter: {
          source_refs: sourceRefs,
        },
      });
      await seedMemoryCandidate(handle.engine, {
        id: 'incoming-blocked-promotion',
        status: 'staged_for_review',
        scope_id: defaultScope,
        candidate_type: 'fact',
        proposed_content: canonicalDuplicateClaim,
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/new-duplicate-target',
      });

      const beforePage = await handle.engine.getPage('concepts/existing-canonical-duplicate');
      const beforeEvents = await handle.engine.listMemoryCandidateStatusEvents({
        candidate_id: 'incoming-blocked-promotion',
      });
      const beforeHandoffs = await handle.engine.listCanonicalHandoffEntries({
        scope_id: defaultScope,
      });
      const promote = findOperation('promote_memory_candidate_entry');

      await expect(promote.handler(operationContext(handle.engine), {
        id: 'incoming-blocked-promotion',
        reviewed_at: '2026-05-09T03:00:00.000Z',
        review_reason: 'Attempt blocked duplicate promotion.',
      })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(promoteMemoryCandidateEntry(handle.engine, {
        id: 'incoming-blocked-promotion',
        reviewed_at: '2026-05-09T03:01:00.000Z',
        review_reason: 'Direct service attempt must still run preflight.',
      })).rejects.toMatchObject({ code: 'promotion_preflight_failed' });

      const afterCandidate = await handle.engine.getMemoryCandidateEntry('incoming-blocked-promotion');
      const afterPage = await handle.engine.getPage('concepts/existing-canonical-duplicate');
      const afterEvents = await handle.engine.listMemoryCandidateStatusEvents({
        candidate_id: 'incoming-blocked-promotion',
      });
      const afterHandoffs = await handle.engine.listCanonicalHandoffEntries({
        scope_id: defaultScope,
      });
      expect(afterCandidate?.status).toBe('staged_for_review');
      expect(afterPage?.compiled_truth).toBe(beforePage?.compiled_truth);
      expect(afterEvents).toHaveLength(beforeEvents.length);
      expect(afterHandoffs).toHaveLength(beforeHandoffs.length);
    } finally {
      await handle.teardown();
    }
  });

  test('possible duplicates are advisory and do not block otherwise valid promotion', async () => {
    const handle = await allocateSqliteBrain('s24-possible-advisory');

    try {
      await handle.engine.putPage('concepts/possible-advisory-match', {
        type: 'concept',
        title: 'Deployment Calendar',
        compiled_truth: 'Deployment calendar tracks operator review window checklist guardrails.',
      });
      await seedMemoryCandidate(handle.engine, {
        id: 'incoming-possible-advisory',
        status: 'staged_for_review',
        scope_id: defaultScope,
        candidate_type: 'fact',
        proposed_content: 'Deployment calendar tracks operator review window and checklist approval guardrails.',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/new-advisory-target',
      });

      const preflight = findOperation('preflight_promote_memory_candidate');
      const promote = findOperation('promote_memory_candidate_entry');
      const preflightResult = await preflight.handler(operationContext(handle.engine), {
        id: 'incoming-possible-advisory',
      }) as any;
      const promoted = await promote.handler(operationContext(handle.engine), {
        id: 'incoming-possible-advisory',
        reviewed_at: '2026-05-09T03:30:00.000Z',
        review_reason: 'Possible duplicate is advisory.',
      }) as any;

      expect(preflightResult.decision).toBe('allow');
      expect(preflightResult.reasons).toEqual(['candidate_ready_for_promotion']);
      expect(preflightResult.duplicate_review.decision).toBe('possible_duplicate');
      expect(promoted.status).toBe('promoted');
    } finally {
      await handle.teardown();
    }
  });

  test('same-target promotion does not rewrite canonical truth or create handoff records by itself', async () => {
    const handle = await allocateSqliteBrain('s24-same-target-boundary');

    try {
      await handle.engine.putPage('concepts/stable-same-target', {
        type: 'concept',
        title: 'Stable Same Target',
        compiled_truth: 'Stable same target canonical truth remains reviewer-owned.',
      });
      const beforePage = await handle.engine.getPage('concepts/stable-same-target');
      await seedMemoryCandidate(handle.engine, {
        id: 'incoming-same-target-promotion',
        status: 'staged_for_review',
        scope_id: defaultScope,
        candidate_type: 'note_update',
        proposed_content: 'Stable same target adds one reviewer checkpoint.',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/stable-same-target',
      });

      const preflight = findOperation('preflight_promote_memory_candidate');
      const promote = findOperation('promote_memory_candidate_entry');
      const preflightResult = await preflight.handler(operationContext(handle.engine), {
        id: 'incoming-same-target-promotion',
      }) as any;
      const promoted = await promote.handler(operationContext(handle.engine), {
        id: 'incoming-same-target-promotion',
        reviewed_at: '2026-05-09T04:00:00.000Z',
        review_reason: 'Same target scenario promotion.',
      }) as any;

      const afterPage = await handle.engine.getPage('concepts/stable-same-target');
      const handoffs = await handle.engine.listCanonicalHandoffEntries({
        scope_id: defaultScope,
      });
      expect(preflightResult.decision).toBe('allow');
      expect(preflightResult.duplicate_review.decision).toBe('same_target_update');
      expect(promoted.status).toBe('promoted');
      expect(afterPage?.compiled_truth).toBe(beforePage?.compiled_truth);
      expect(handoffs).toEqual([]);
    } finally {
      await handle.teardown();
    }
  });

  test('promoted and superseded terminal candidate echoes do not block promotion', async () => {
    const handle = await allocateSqliteBrain('s24-terminal-statuses');

    try {
      await seedMemoryCandidate(handle.engine, {
        id: 'terminal-promoted-echo',
        status: 'staged_for_review',
        scope_id: defaultScope,
        candidate_type: 'fact',
        proposed_content: candidateDuplicateClaim,
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/promoted-terminal-target',
      });
      await handle.engine.promoteMemoryCandidateEntry('terminal-promoted-echo', {
        expected_current_status: 'staged_for_review',
        reviewed_at: new Date('2026-05-09T04:10:00.000Z'),
        review_reason: 'Seed promoted terminal echo.',
      });

      await seedMemoryCandidate(handle.engine, {
        id: 'terminal-superseded-echo',
        status: 'staged_for_review',
        scope_id: defaultScope,
        candidate_type: 'fact',
        proposed_content: candidateDuplicateClaim,
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/superseded-terminal-target',
      });
      await seedMemoryCandidate(handle.engine, {
        id: 'terminal-replacement',
        status: 'staged_for_review',
        scope_id: defaultScope,
        candidate_type: 'fact',
        proposed_content: 'Replacement terminal record tracks a separate reviewed outcome.',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/terminal-replacement-target',
      });
      await handle.engine.promoteMemoryCandidateEntry('terminal-replacement', {
        expected_current_status: 'staged_for_review',
        reviewed_at: new Date('2026-05-09T04:11:00.000Z'),
        review_reason: 'Seed promoted replacement.',
      });
      await supersedeMemoryCandidateEntry(handle.engine, {
        superseded_candidate_id: 'terminal-superseded-echo',
        replacement_candidate_id: 'terminal-replacement',
        reviewed_at: '2026-05-09T04:12:00.000Z',
        review_reason: 'Seed superseded terminal echo.',
      });
      await seedMemoryCandidate(handle.engine, {
        id: 'incoming-after-terminal-statuses',
        status: 'staged_for_review',
        scope_id: defaultScope,
        candidate_type: 'fact',
        proposed_content: candidateDuplicateClaim,
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/new-terminal-status-target',
      });

      const preflight = findOperation('preflight_promote_memory_candidate');
      const promote = findOperation('promote_memory_candidate_entry');
      const preflightResult = await preflight.handler(operationContext(handle.engine), {
        id: 'incoming-after-terminal-statuses',
      }) as any;
      const promoted = await promote.handler(operationContext(handle.engine), {
        id: 'incoming-after-terminal-statuses',
        reviewed_at: '2026-05-09T04:13:00.000Z',
        review_reason: 'Terminal statuses are historical evidence only.',
      }) as any;

      expect(preflightResult.decision).toBe('allow');
      expect(preflightResult.duplicate_review.decision).toBe('no_match');
      expect(promoted.status).toBe('promoted');
      expect((await handle.engine.getMemoryCandidateEntry('terminal-promoted-echo'))?.status).toBe('promoted');
      expect((await handle.engine.getMemoryCandidateEntry('terminal-superseded-echo'))?.status).toBe('superseded');
    } finally {
      await handle.teardown();
    }
  });

  test('unresolved candidate duplicates are scoped to the incoming candidate review scope', async () => {
    const handle = await allocateSqliteBrain('s24-scope-isolation');

    try {
      await seedMemoryCandidate(handle.engine, {
        id: 'other-scope-duplicate-candidate',
        status: 'staged_for_review',
        scope_id: otherScope,
        candidate_type: 'fact',
        proposed_content: candidateDuplicateClaim,
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/other-scope-target',
      });
      await seedMemoryCandidate(handle.engine, {
        id: 'incoming-scope-isolated',
        status: 'staged_for_review',
        scope_id: defaultScope,
        candidate_type: 'fact',
        proposed_content: candidateDuplicateClaim,
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/default-scope-target',
      });

      const preflight = findOperation('preflight_promote_memory_candidate');
      const isolatedResult = await preflight.handler(operationContext(handle.engine), {
        id: 'incoming-scope-isolated',
      }) as any;
      expect(isolatedResult.decision).toBe('allow');
      expect(isolatedResult.duplicate_review.decision).toBe('no_match');

      await seedMemoryCandidate(handle.engine, {
        id: 'default-scope-duplicate-candidate',
        status: 'staged_for_review',
        scope_id: defaultScope,
        candidate_type: 'fact',
        proposed_content: candidateDuplicateClaim,
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/default-scope-peer-target',
      });
      const blockedResult = await preflight.handler(operationContext(handle.engine), {
        id: 'incoming-scope-isolated',
      }) as any;

      expect(blockedResult.decision).toBe('defer');
      expect(blockedResult.reasons).toContain('candidate_possible_duplicate');
      expect(blockedResult.duplicate_review.top_match?.id).toBe('default-scope-duplicate-candidate');
    } finally {
      await handle.teardown();
    }
  });

  test('promotion retries are required when duplicate-review inputs change mid-flight', async () => {
    const handle = await allocateSqliteBrain('s24-stale-fail-closed');

    try {
      await seedMemoryCandidate(handle.engine, {
        id: 'incoming-stale-window',
        status: 'staged_for_review',
        scope_id: defaultScope,
        candidate_type: 'fact',
        proposed_content: 'Stale window promotion must retry when review inputs change.',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/stale-window-target',
      });

      const originalListPages = handle.engine.listPages.bind(handle.engine);
      const originalPutPage = handle.engine.putPage.bind(handle.engine);
      let listPagesCalls = 0;
      handle.engine.listPages = async (filters) => {
        listPagesCalls += 1;
        if (listPagesCalls === 2) {
          await originalPutPage('concepts/concurrent-review-input', {
            type: 'concept',
            title: 'Concurrent Review Input',
            compiled_truth: 'A concurrent canonical page changed the duplicate review input set.',
          });
        }
        return originalListPages(filters);
      };

      const promote = findOperation('promote_memory_candidate_entry');
      await expect(promote.handler(operationContext(handle.engine), {
        id: 'incoming-stale-window',
        reviewed_at: '2026-05-09T05:00:00.000Z',
        review_reason: 'Attempt promotion across stale duplicate review window.',
      })).rejects.toMatchObject({ code: 'invalid_params' });

      const stored = await handle.engine.getMemoryCandidateEntry('incoming-stale-window');
      const handoffs = await handle.engine.listCanonicalHandoffEntries({
        scope_id: defaultScope,
      });
      expect(stored?.status).toBe('staged_for_review');
      expect(handoffs).toEqual([]);
    } finally {
      await handle.teardown();
    }
  });

  test('README registers S24 in the scenario contract table', async () => {
    const readme = await readFile(join(import.meta.dir, 'README.md'), 'utf8');
    expect(readme).toContain('S24');
    expect(readme).toContain('s24-duplicate-review-acceptance.test.ts');
  });
});
