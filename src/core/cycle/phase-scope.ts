import type { CyclePhase } from '../cycle.ts';

/** Canonical Source/global Dream phase taxonomy. */
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
  capture_entities: 'source',
  enrich_thin: 'source',
};

/** Bounded deterministic phases that alone define Source freshness. */
export const SOURCE_FRESHNESS_PHASES: CyclePhase[] = [
  'lint',
  'backlinks',
  'sync',
  'extract',
  'extract_facts',
  'recompute_emotional_weight',
];
