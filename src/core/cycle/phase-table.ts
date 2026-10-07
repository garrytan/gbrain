/**
 * Managed-brain phase table (fix wave 3, CEO managed-brain phase matrix /
 * Eng E-D15). Every phase in `ALL_PHASES` is classified by what it does on a
 * managed brain (persistence enabled):
 *
 * - `writes`: publishes canonical rows or files through the coordinator.
 * - `no_coordinated_write`: writes nothing coordinated by design (derived
 *   projections, side tables, reports outside the brain), with the reason.
 * - `managed_skip`: deliberately skipped on managed brains, with the reason
 *   the cycle report shows.
 *
 * `test/managed-phase-matrix.test.ts` fails for a phase missing here and runs
 * each classified phase once on a managed PGLite and Postgres brain.
 */
import type { BrainEngine } from '../engine.ts';
import type { CyclePhase } from '../cycle.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';

export type ManagedPhaseClass = 'writes' | 'no_coordinated_write' | 'managed_skip';
export interface ManagedPhaseEntry { class: ManagedPhaseClass; reason: string }

export const MANAGED_PHASE_TABLE: Readonly<Record<CyclePhase, ManagedPhaseEntry>> = {
  lint: { class: 'writes', reason: 'Lint repairs publish through the maintenance coordinator, one page per repair; a file with no indexed page is reported and left for the next cycle.' },
  backlinks: { class: 'no_coordinated_write', reason: 'Audit-only: counts missing back-links and never writes files.' },
  sync: { class: 'writes', reason: 'Managed sync admits each changed file through the coordinator.' },
  fence_repair: { class: 'writes', reason: 'Fence repairs publish through managed_file_repair (managed sources), a revision-bound put_page (database-only pages) or the legacy confined write, one coordinated write per repaired file or page.' },
  synthesize: { class: 'writes', reason: 'Dream synthesis publishes pages through the maintenance coordinator.' },
  extract: { class: 'writes', reason: 'Derived links and unrecorded timeline rows commit inside revision-bound coordinated transactions.' },
  extract_facts: { class: 'writes', reason: 'Fence facts are re-projected through coordinated maintenance writes.' },
  extract_atoms: { class: 'writes', reason: 'Atom pages publish through the maintenance coordinator.' },
  resolve_symbol_edges: { class: 'no_coordinated_write', reason: 'Resolves code-edge metadata on chunks, a derived projection outside the canonical tables.' },
  patterns: { class: 'writes', reason: 'Pattern pages publish through the maintenance coordinator.' },
  synthesize_concepts: { class: 'writes', reason: 'Concept pages publish through publishMaintenancePage: private first, provenance, then promotion.' },
  recompute_emotional_weight: { class: 'no_coordinated_write', reason: 'Writes the derived emotional_weight column, which the canonical writer guard does not cover.' },
  consolidate: { class: 'writes', reason: 'Consolidated takes, facts and pages commit through the maintenance coordinator.' },
  propose_takes: { class: 'no_coordinated_write', reason: 'Writes the take_proposals review queue; managed brains skip the legacy receipt page.' },
  grade_takes: { class: 'no_coordinated_write', reason: 'The cycle runs it with auto-resolve off, so it only caches verdicts in take_grade_cache; opt-in auto-applied resolutions go through the coordinated takes_resolve mutation.' },
  calibration_profile: { class: 'no_coordinated_write', reason: 'Writes the calibration_profiles side table only.' },
  edge_contradictions: { class: 'writes', reason: 'Applied closures append a timeline line through the coordinated add_timeline_entry mutation; proposals live in the link_edge_proposals side table.' },
  drift: { class: 'writes', reason: 'The drift report page publishes through the maintenance coordinator.' },
  chronicle: { class: 'writes', reason: 'Life Chronicle event pages and their projections publish through the maintenance coordinator, re-validated against the judged depth revision.' },
  facts_drain: { class: 'writes', reason: 'Queued facts-absorb jobs publish facts through the same coordinated write path as the job worker.' },
  conversation_facts_backfill: { class: 'writes', reason: 'Backfilled conversation facts publish through coordinated writes.' },
  enrich_thin: { class: 'writes', reason: 'Enriched pages publish through the maintenance coordinator.' },
  skillopt: { class: 'no_coordinated_write', reason: 'Writes skill files and proposals outside the brain database.' },
  embed: { class: 'no_coordinated_write', reason: 'Embeddings are a physical projection the canonical writer guard does not cover.' },
  orphans: { class: 'no_coordinated_write', reason: 'Read-only orphan report.' },
  'schema-suggest': { class: 'no_coordinated_write', reason: 'Writes schema suggestions outside the canonical tables.' },
  purge: { class: 'writes', reason: 'Expired tombstones are purged one by one through coordinated delete_page purges.' },
};

export async function isManagedBrain(engine: BrainEngine): Promise<boolean> {
  return managedPersistenceEnabled(engine);
}
