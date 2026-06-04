/**
 * v0.38 PHASE_SCOPE coverage regression.
 *
 * The phase-scope taxonomy in `src/core/cycle.ts` is documentation, not
 * runtime enforcement (deferred TODO per plan). This test guards the
 * static contract:
 *
 *   1. Every `ALL_PHASES` entry has a `PHASE_SCOPE` entry. New phases
 *      added without taxonomy declaration fail this test.
 *   2. No extra `PHASE_SCOPE` entries beyond `ALL_PHASES`. Stale entries
 *      from removed phases fail this test.
 *   3. Every value is one of 'source' | 'global' | 'mixed' (type check).
 *
 * Future fan-out wave consumes PHASE_SCOPE directly; this test makes
 * the contract enforceable at the unit-test layer.
 */
import { describe, test, expect } from 'bun:test';
import { ALL_PHASES, PHASE_SCOPE, type PhaseScope } from '../src/core/cycle.ts';

const VALID_SCOPES: ReadonlyArray<PhaseScope> = ['source', 'global', 'mixed'];

describe('PHASE_SCOPE coverage', () => {
  test('every ALL_PHASES entry has a PHASE_SCOPE entry', () => {
    const missing = ALL_PHASES.filter(p => !(p in PHASE_SCOPE));
    expect(missing).toEqual([]);
  });

  test('no extra PHASE_SCOPE entries beyond ALL_PHASES', () => {
    const all = new Set<string>(ALL_PHASES);
    const extra = Object.keys(PHASE_SCOPE).filter(p => !all.has(p));
    expect(extra).toEqual([]);
  });

  test('every PHASE_SCOPE value is source | global | mixed', () => {
    const invalid: string[] = [];
    for (const [phase, scope] of Object.entries(PHASE_SCOPE)) {
      if (!VALID_SCOPES.includes(scope)) {
        invalid.push(`${phase}: ${scope}`);
      }
    }
    expect(invalid).toEqual([]);
  });

  test('all 22 phases covered (regression on accidental omission)', () => {
    // Pin the count so a future PR that adds a phase to ALL_PHASES
    // without updating PHASE_SCOPE notices here too. The v0.39.1.0
    // master merge brought in the 17th phase (`schema-suggest`); v0.41
    // adds 'extract_atoms' + 'synthesize_concepts' (T9 lens packs) +
    // 'conversation_facts_backfill' (v0.41.11.0) for 20; v0.41.39 (#1700)
    // adds 'enrich_thin' and v0.42.0.0 adds 'skillopt' for a total of 22.
    expect(ALL_PHASES.length).toBe(22);
    expect(Object.keys(PHASE_SCOPE).length).toBe(22);
  });

  test('embed remains global (the headline brain-wide phase)', () => {
    // Pin embed specifically — codex r1 P0-1 called this out as the
    // canonical reason per-source locks aren't sufficient for true
    // fan-out. If future code makes embed source-scopable, this fails
    // and forces a corresponding lift in the fan-out wave.
    expect(PHASE_SCOPE.embed).toBe('global');
  });

  test('sync remains source-scoped (the headline per-source phase)', () => {
    expect(PHASE_SCOPE.sync).toBe('source');
  });
});
