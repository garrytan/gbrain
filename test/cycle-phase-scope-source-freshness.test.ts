/**
 * Second-batch product contract: named Sources finish a deterministic
 * freshness pass first; brain-wide synthesis remains a separate maintenance
 * pass. Explicit operator phase choices are never rewritten.
 */

import { describe, expect, test } from 'bun:test';
import {
  ALL_PHASES, DEFAULT_PHASES,
  MAINTENANCE_PHASES,
  normalizeQueuedSourcePhases,
  SOURCE_BACKGROUND_PHASES,
  SOURCE_FRESHNESS_PHASES,
  resolveCyclePhases,
} from '../src/core/cycle.ts';

describe('two-stage Dream organization', () => {
  test('implicit named-Source cycle is the bounded freshness stage', () => {
    expect(resolveCyclePhases(undefined, 'project-a')).toEqual(SOURCE_FRESHNESS_PHASES);
    expect(SOURCE_FRESHNESS_PHASES).toEqual([
      'lint',
      'backlinks',
      'sync',
      'extract',
      'extract_facts',
      'recompute_emotional_weight',
    ]);
    expect(SOURCE_FRESHNESS_PHASES).not.toContain('synthesize');
    expect(SOURCE_FRESHNESS_PHASES).not.toContain('patterns');
    expect(SOURCE_FRESHNESS_PHASES).not.toContain('extract_atoms');
  });

  test('default Source keeps the full maintenance-capable cycle', () => {
    expect(resolveCyclePhases(undefined, undefined)).toEqual(DEFAULT_PHASES);
    expect(resolveCyclePhases(undefined, 'default')).toEqual(DEFAULT_PHASES);
    expect(MAINTENANCE_PHASES).toContain('synthesize');
    expect(MAINTENANCE_PHASES).toContain('patterns');
    expect(MAINTENANCE_PHASES).toContain('synthesize_concepts');
  });

  test('explicit operator phases remain authoritative', () => {
    expect(resolveCyclePhases(['synthesize', 'patterns'], 'project-a')).toEqual([
      'synthesize',
      'patterns',
    ]);
    expect(SOURCE_BACKGROUND_PHASES).toContain('extract_atoms');
    expect(SOURCE_BACKGROUND_PHASES).toContain('conversation_facts_backfill');
  });

  test('queued per-Source jobs reject maintenance phases instead of repeating them for every Source', () => {
    expect(normalizeQueuedSourcePhases(
      ['sync', 'synthesize', 'extract', 'patterns', 'embed'],
      'project-a',
    )).toEqual({
      phases: ['sync', 'extract'],
      rejected: ['synthesize', 'patterns', 'embed'],
    });
    expect(normalizeQueuedSourcePhases(['synthesize'], undefined)).toEqual({
      phases: ['synthesize'],
      rejected: [],
    });
  });
});
