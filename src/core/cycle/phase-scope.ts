import type { CyclePhase } from '../cycle.ts';

/**
 * Phase-scope taxonomy. `runCycle` enforces it for explicit non-default
 * sources: only source phases run there; mixed and global phases run once in
 * the default/global-maintenance lane.
 *
 * - source: safe to parallelize per source.
 * - global: must serialize across the brain.
 * - mixed: reads brain-wide input while writing pages, so it stays in the
 *   default/global-maintenance lane until decomposed.
 */
export type PhaseScope = 'source' | 'global' | 'mixed';

export const PHASE_SCOPE: Record<CyclePhase, PhaseScope> = {
  lint: 'source',
  backlinks: 'source',
  sync: 'source',
  synthesize: 'mixed',
  extract: 'source',
  extract_facts: 'source',
  resolve_symbol_edges: 'global',
  patterns: 'mixed',
  recompute_emotional_weight: 'source',
  consolidate: 'source',
  propose_takes: 'source',
  grade_takes: 'global',
  calibration_profile: 'global',
  drift: 'global',
  embed: 'global',
  orphans: 'global',
  purge: 'global',
  'schema-suggest': 'source',
  extract_atoms: 'source',
  synthesize_concepts: 'global',
  conversation_facts_backfill: 'source',
  enrich_thin: 'source',
  skillopt: 'global',
};

/** Bounded deterministic phases that alone define source freshness. */
export const SOURCE_FRESHNESS_PHASES: CyclePhase[] = [
  'lint', 'backlinks', 'sync', 'extract', 'extract_facts',
  'recompute_emotional_weight',
];
