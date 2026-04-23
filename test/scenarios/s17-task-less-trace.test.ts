/**
 * Scenario S17 — Task-less trace is persisted with fallback scope.
 *
 * Falsifies Sprint 1.0 goal: `retrieval_traces.id` is the canonical
 * agent-turn identifier. Task is not required.
 */

import { describe, expect, test } from 'bun:test';
import { allocateSqliteBrain } from './helpers.ts';
import { selectRetrievalRoute } from '../../src/core/services/retrieval-route-selector-service.ts';

describe('S17 — task-less trace persistence', () => {
  test('selectRetrievalRoute without task_id persists a trace with scope unknown when no signals', async () => {
    const handle = await allocateSqliteBrain('s17-no-task');

    try {
      const result = await selectRetrievalRoute(handle.engine, {
        intent: 'broad_synthesis',
        query: 'something',
        persist_trace: true,
      });

      expect(result.trace).toBeDefined();
      expect(result.trace!.task_id).toBeNull();
      expect(result.trace!.scope).toBe('unknown');
    } finally {
      await handle.teardown();
    }
  });

  test('selectRetrievalRoute without task_id inherits scope from scope_gate when signals resolve', async () => {
    const handle = await allocateSqliteBrain('s17-signal');

    try {
      const result = await selectRetrievalRoute(handle.engine, {
        intent: 'broad_synthesis',
        query: 'show me the repository architecture docs',  // EN work signals
        persist_trace: true,
      });

      expect(result.trace).toBeDefined();
      expect(result.trace!.task_id).toBeNull();
      expect(result.trace!.scope).toBe('work');
    } finally {
      await handle.teardown();
    }
  });

  test('selectRetrievalRoute with unknown task_id does not throw; persists with task_id null', async () => {
    const handle = await allocateSqliteBrain('s17-bad-task');

    try {
      const result = await selectRetrievalRoute(handle.engine, {
        intent: 'broad_synthesis',
        query: 'test',
        task_id: 'does-not-exist',
        persist_trace: true,
      });

      expect(result.trace).toBeDefined();
      expect(result.trace!.task_id).toBeNull();
      expect(result.trace!.verification.some((v) => v.startsWith('task_id_not_found:'))).toBe(true);
    } finally {
      await handle.teardown();
    }
  });
});
