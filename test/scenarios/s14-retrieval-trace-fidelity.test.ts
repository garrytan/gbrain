/**
 * Scenario S14 — Retrieval trace captures the full loop-6 record.
 *
 * Falsifies L6: "Each trace must capture the active scope and intent route,
 * which canonical artifacts were read, which derived artifacts were consulted
 * for orientation or ranking, where verification occurred, and whether the
 * interaction produced operational writes, candidates, promotions,
 * rejections, or no durable write at all."
 *
 * Current retrieval_traces schema has:
 *   id, task_id, scope, route, source_refs, verification, outcome, created_at
 *
 * What's present: scope, route, source_refs, verification, outcome.
 * What's missing: an explicit distinction between CANONICAL reads and
 * DERIVED consultations. Broad-synthesis consults context maps (derived) and
 * curated notes (canonical); the current trace lumps them into one
 * source_refs array and loses that distinction.
 */

import { describe, expect, test } from 'bun:test';
import { allocateSqliteBrain, seedWorkTaskThread } from './helpers.ts';
import { selectRetrievalRoute } from '../../src/core/services/retrieval-route-selector-service.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../../src/core/services/context-map-service.ts';

describe('S14 — retrieval trace fidelity', () => {
  test('a persisted task_resume trace records scope, route, verification, and outcome', async () => {
    const handle = await allocateSqliteBrain('s14-basic');

    try {
      await seedWorkTaskThread(handle.engine, 'task-trace');

      const result = await selectRetrievalRoute(handle.engine, {
        intent: 'task_resume',
        task_id: 'task-trace',
        persist_trace: true,
      });

      expect(result.route).not.toBeNull();
      expect(result.trace).toBeDefined();

      const traces = await handle.engine.listRetrievalTraces('task-trace', { limit: 5 });
      expect(traces.length).toBe(1);
      const trace = traces[0]!;
      expect(trace.scope).toBe('work');
      // route is an array of stages (tags).
      expect(Array.isArray(trace.route)).toBe(true);
      // verification must include at minimum the intent and selection reason.
      expect(trace.verification.some((entry) => entry.startsWith('intent:'))).toBe(true);
      expect(trace.verification.some((entry) => entry.startsWith('selection_reason:'))).toBe(true);
      expect(trace.outcome).toContain('task_resume');
    } finally {
      await handle.teardown();
    }
  });

  test('a persisted broad_synthesis trace separates canonical reads from derived consultations', async () => {
    const handle = await allocateSqliteBrain('s14-derived');

    try {
      await seedWorkTaskThread(handle.engine, 'task-derived');
      await importFromContent(handle.engine, 'systems/mbrain', [
        '---',
        'type: system',
        'title: MBrain',
        '---',
        '# Overview',
        'See [[concepts/note-manifest]].',
      ].join('\n'), { path: 'systems/mbrain.md' });
      await importFromContent(handle.engine, 'concepts/note-manifest', [
        '---',
        'type: concept',
        'title: Note Manifest',
        '---',
        '# Purpose',
        'Indexes [[systems/mbrain]].',
      ].join('\n'), { path: 'concepts/note-manifest.md' });
      await buildStructuralContextMapEntry(handle.engine);

      const result = await selectRetrievalRoute(handle.engine, {
        intent: 'broad_synthesis',
        task_id: 'task-derived',
        query: 'mbrain',
        persist_trace: true,
      });

      expect(result.route).not.toBeNull();
      const traces = await handle.engine.listRetrievalTraces('task-derived', { limit: 5 });
      expect(traces.length).toBe(1);
      const trace = traces[0]!;
      const mapId = (result.route?.payload as { map_id?: string } | undefined)?.map_id;
      expect(typeof mapId).toBe('string');
      expect(trace.source_refs).toContain('page:systems/mbrain');
      expect(trace.source_refs.some((ref) => ref.startsWith('section:concepts/note-manifest#'))).toBe(true);
      expect(trace.source_refs).not.toContain(mapId!);
      expect(trace.derived_consulted).toEqual([mapId]);
    } finally {
      await handle.teardown();
    }
  });

  // L6 also requires `outcome` to reflect whether the interaction produced
  // writes. Current code uses `${intent} route selected` as a free-form
  // string. Test: no durable write → outcome says so.
  test('an intent that produces no durable write reports a route-only outcome string', async () => {
    const handle = await allocateSqliteBrain('s14-outcome');

    try {
      await seedWorkTaskThread(handle.engine, 'task-outcome');

      await selectRetrievalRoute(handle.engine, {
        intent: 'task_resume',
        task_id: 'task-outcome',
        persist_trace: true,
      });

      const traces = await handle.engine.listRetrievalTraces('task-outcome', { limit: 5 });
      expect(traces.length).toBe(1);
      const outcome = traces[0]!.outcome;
      // Current schema: outcome is a free-form string. This test pins the
      // current behavior; if the contract tightens to a controlled vocabulary
      // (e.g., `no_durable_write`, `operational_write`, `candidate_created`),
      // update the assertion and the producer together.
      expect(outcome.length).toBeGreaterThan(0);
      expect(outcome).toContain('task_resume');
    } finally {
      await handle.teardown();
    }
  });
});
