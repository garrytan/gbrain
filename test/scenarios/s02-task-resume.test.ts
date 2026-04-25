/**
 * Scenario S2 — Task resume after restart surfaces the working set first.
 *
 * Falsifies I3 (durable canonical home for active work) and L7 (read the
 * active working set before scanning raw files).
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { allocateSqliteBrain, seedWorkTaskThread } from './helpers.ts';
import { selectRetrievalRoute } from '../../src/core/services/retrieval-route-selector-service.ts';

describe('S2 — task resume surfaces working-set state', () => {
  test('resume returns working-set data and resolves scope via task thread', async () => {
    const handle = await allocateSqliteBrain('s02');

    try {
      const repoPath = join(handle.rootDir, 'repo');
      mkdirSync(join(repoPath, 'src/core/services'), { recursive: true });
      writeFileSync(
        join(repoPath, 'src/core/services/memory-inbox-service.ts'),
        'export function advanceMemoryCandidateStatus() { return true; }\n',
      );
      await seedWorkTaskThread(handle.engine, 'task-X', {
        repoPath,
        branchName: 'scenario-branch',
        workingSet: {
          active_paths: ['src/core/services/memory-inbox-service.ts'],
          active_symbols: ['advanceMemoryCandidateStatus'],
          blockers: ['Waiting on provenance design review'],
          open_questions: ['Does rejection need to support staged+candidate?'],
          next_steps: ['Re-read the governance spec before promoting'],
        },
      });

      await handle.engine.recordTaskAttempt({
        id: 'attempt-1',
        task_id: 'task-X',
        summary: 'First stab at the FSM',
        outcome: 'failed',
        applicability_context: {},
        evidence: ['Compile error in memory-inbox-service.ts'],
      });
      await handle.engine.putRetrievalTrace({
        id: 'trace-code-claim-source',
        task_id: 'task-X',
        scope: 'work',
        route: ['task_resume'],
        source_refs: ['task-thread:task-X'],
        verification: ['code_claim:src/core/services/memory-inbox-service.ts:advanceMemoryCandidateStatus'],
        outcome: 'resume path assembled',
      });
      await handle.engine.recordTaskDecision({
        id: 'decision-1',
        task_id: 'task-X',
        summary: 'Narrow MemoryCandidateStatus type for Phase 5 release',
        rationale: 'Matches the governance doc partial-FSM guidance',
        consequences: [],
        validity_context: {},
      });

      const result = await selectRetrievalRoute(handle.engine, {
        intent: 'task_resume',
        task_id: 'task-X',
      });

      expect(result.selected_intent).toBe('task_resume');
      expect(result.selection_reason).toBe('direct_task_match');
      expect(result.candidate_count).toBe(1);
      expect(result.route).not.toBeNull();
      expect(result.route!.route_kind).toBe('task_resume');

      const card = result.route!.payload as {
        task_id: string;
        active_paths: string[];
        next_steps: string[];
        blockers: string[];
        open_questions: string[];
        active_symbols: string[];
        failed_attempts: string[];
        active_decisions: string[];
      };

      // L7: working set must be present and populated in the resume card.
      expect(card.task_id).toBe('task-X');
      expect(card.active_paths).toContain('src/core/services/memory-inbox-service.ts');
      expect(card.active_symbols).toContain('advanceMemoryCandidateStatus');
      expect(card.blockers.length).toBeGreaterThan(0);
      expect(card.open_questions.length).toBeGreaterThan(0);
      expect(card.next_steps.length).toBeGreaterThan(0);
      expect(card.failed_attempts).toContain('First stab at the FSM');
      expect(card.active_decisions.length).toBeGreaterThan(0);
    } finally {
      await handle.teardown();
    }
  });

  test('resume with unknown task_id returns a no-match result without crashing', async () => {
    const handle = await allocateSqliteBrain('s02-missing');
    try {
      const result = await selectRetrievalRoute(handle.engine, {
        intent: 'task_resume',
        task_id: 'does-not-exist',
      });
      expect(result.route).toBeNull();
      expect(result.selection_reason).toBe('task_not_found');
    } finally {
      await handle.teardown();
    }
  });
});
