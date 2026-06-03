/**
 * Scenario S33 - agent session memory loop.
 *
 * Agent-session capture may make personal memory useful for future sessions,
 * but unreviewed candidates remain non-authoritative and recurrence only raises
 * review priority.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { planAgentSessionActivation } from '../../src/core/services/agent-session-activation-planner-service.ts';
import { buildAgentSessionMaintenanceReview } from '../../src/core/services/agent-session-maintenance-service.ts';
import { allocateSqliteBrain } from './helpers.ts';

function opContext(engine: OperationContext['engine']): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun: false,
  };
}

describe('S33 - agent session memory loop', () => {
  test('captures explicit preference, activates profile memory, and keeps candidates non-authoritative', async () => {
    const handle = await allocateSqliteBrain('s33-preference');
    try {
      const ctx = opContext(handle.engine);

      const capture = await operationsByName.capture_agent_session_memory.handler(ctx, {
        source_kind: 'codex_session',
        session_id: 's33-session',
        client_name: 'codex',
        events: [{
          event_kind: 'explicit_memory_note',
          text: 'Remember that the user prefers concise implementation checkpoints.',
        }],
        write_mode: 'direct_personal_when_allowed',
        apply: true,
        now: '2026-06-04T01:00:00.000Z',
      }) as any;

      expect(capture.routes[0].direct_write?.kind).toBe('profile_memory');

      const activation = await planAgentSessionActivation(handle.engine, {
        query: 'implementation checkpoints',
        requested_scope: 'personal',
        scenario: 'personal_recall',
        limit: 5,
      });

      expect(activation.policy.decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          decision: 'answer_ground',
          authority: 'profile_memory',
        }),
      ]));
    } finally {
      await handle.teardown();
    }
  });

  test('session-derived inferred candidates enter maintenance without truth promotion', async () => {
    const handle = await allocateSqliteBrain('s33-inferred');
    try {
      const ctx = opContext(handle.engine);

      await operationsByName.capture_agent_session_memory.handler(ctx, {
        source_kind: 'codex_session',
        session_id: 's33-inferred-session',
        events: [{
          event_kind: 'assistant_response',
          actor: 'assistant',
          text: 'The user prefers concise implementation checkpoints.',
        }],
        write_mode: 'direct_personal_when_allowed',
        apply: true,
      });

      const candidates = await handle.engine.listMemoryCandidateEntries({
        scope_id: 'personal:default',
        limit: 10,
      });
      const review = buildAgentSessionMaintenanceReview(candidates);

      expect(candidates).toHaveLength(1);
      expect(review.authority_warning).toBe('recurrence_increases_review_priority_not_truth');
      expect(review.auto_promote_handoff_candidates).toHaveLength(0);
    } finally {
      await handle.teardown();
    }
  });

  test('README registers S33 in the scenario contract table', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf-8');
    expect(readme).toContain('| S33 | `s33-agent-session-memory-loop.test.ts` | G1, L6, L7 | ✅ green |');
  });
});
