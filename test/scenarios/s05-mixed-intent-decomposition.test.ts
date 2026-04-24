/**
 * Scenario S5 — Mixed-scope bridge route is decomposed, not flattened.
 *
 * Falsifies L1 and I5 at the bridge boundary.
 *
 * Known gaps with current code are recorded below as `test.todo` markers
 * so future PRs that add the missing classifier flip them into real tests.
 */

import { describe, expect, test } from 'bun:test';
import { allocateSqliteBrain } from './helpers.ts';
import { selectRetrievalRoute } from '../../src/core/services/retrieval-route-selector-service.ts';

describe('S5 — mixed-scope bridge decomposition', () => {
  test('mixed_scope_bridge with requested_scope=work is denied by the scope gate', async () => {
    const handle = await allocateSqliteBrain('s05-wrong-scope');

    try {
      const result = await selectRetrievalRoute(handle.engine, {
        intent: 'mixed_scope_bridge',
        requested_scope: 'work',
        query: 'Tell me about alex',
        subject: 'alex',
        personal_route_kind: 'profile',
      });

      expect(result.route).toBeNull();
      // The bridge evaluates scope gate internally; the gate must deny a
      // non-mixed scope even when the intent is mixed_scope_bridge.
      if (result.scope_gate) {
        expect(result.scope_gate.policy).toBe('deny');
      }
    } finally {
      await handle.teardown();
    }
  });

  test('mixed_scope_bridge with scope=mixed on an empty brain reports work_route_no_match explicitly', async () => {
    // Contract check: degradation is explicit. The bridge must report WHICH
    // side failed, not silently return null.
    const handle = await allocateSqliteBrain('s05-empty-work');

    try {
      await handle.engine.upsertProfileMemoryEntry({
        id: 'profile-isolated',
        scope_id: 'personal:default',
        profile_type: 'stable_fact',
        subject: 'alex',
        content: 'Alex description.',
        source_refs: ['User, 2026-04-23 KST'],
        sensitivity: 'personal',
        export_status: 'exportable',
        last_confirmed_at: null,
        superseded_by: null,
      });

      const result = await selectRetrievalRoute(handle.engine, {
        intent: 'mixed_scope_bridge',
        requested_scope: 'mixed',
        query: 'Tell me about alex',
        subject: 'alex',
        personal_route_kind: 'profile',
      });

      // With no context map, the work half cannot produce a route.
      // The bridge must degrade explicitly (selection_reason) rather than
      // collapsing the intent to a personal-only route.
      expect(result.selection_reason).toBe('work_route_no_match');
      expect(result.route).toBeNull();
    } finally {
      await handle.teardown();
    }
  });

  // L1 gap: the system today only expresses one mixed-intent pattern —
  // broad_synthesis + personal. Other combinations (task_resume + synthesis,
  // precision_lookup + personal) have no decomposer. See spec §5, fix direction:
  // add classifyIntents() that emits a list of sub-intents for one natural
  // request.
  test.todo('S5 gap — general request-level intent classifier (resume + synthesis, etc.)', () => {});
});
