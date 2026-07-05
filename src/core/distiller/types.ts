/**
 * distiller/types.ts — shared types for the data→skills distiller (Task 1).
 *
 * The distiller takes a CANDIDATE TOPIC pulled from stored brain data and
 * decides what to do with the skill library: create a new skill, leave an
 * existing one as-is, update it with the new data, or split it in two. It then
 * keeps the orchestrator (RESOLVER) in sync.
 *
 * Deliberately mirrors the orchestrator's shape (src/core/orchestrator/): a
 * pure decision pass with injected seams, so it runs with no DB / no LLM yet.
 * Where the orchestrator answers "given THIS patient input, which skills run?",
 * the distiller answers "given THIS topic from the data, how should the skill
 * library change?".
 *
 * IRON RULE (APPI 要配慮個人情報): patient-derived content is distilled ONLY
 * into our own role-tagged clinical skills. A topic must carry a healthcare
 * role (nurse | psychiatrist | general-medicine); run.ts fail-closes otherwise.
 * The role set is the frozen contract in skill-frontmatter.ts (SKILL_ROLES).
 */

// Single source of truth for the role set is the frozen contract; re-export so
// the rest of the distiller imports it locally.
import type { SkillRole } from '../skill-frontmatter.ts';
export type { SkillRole };

/**
 * A candidate topic distilled from brain data — the unit the decider reasons
 * over. `role` scopes it to a care lane so it is only ever compared against
 * skills in that same lane.
 */
export interface CandidateTopic {
  /** Human-readable topic title (also the basis for a new skill's slug). */
  title: string;
  /** What the topic is about — text distilled from the retrieved brain data. */
  summary: string;
  /** Care lane this topic belongs to. Must be a healthcare role (APPI). */
  role: SkillRole;
  /** Candidate trigger phrases for a new/updated skill, if already proposed. */
  triggers?: string[];
  /** Provenance: brain source/page ids this topic was distilled from (audit). */
  sourceIds?: string[];
}

/**
 * An existing skill the decider compares against — the fields projected by
 * `list_skills` (SkillCatalogEntry). `role` is undefined for generic GBrain
 * skills (which are never in a clinical lane).
 */
export interface ExistingSkill {
  name: string;
  description: string;
  triggers: string[];
  /** Frontmatter `role:`; undefined ⇒ generic GBrain skill. */
  role?: string;
}

/** The four-way decision the distiller makes for a candidate topic. */
export type DistillDecision =
  | 'none' // Q1: no suitable skill exists → create one.
  | 'exact_match' // A skill already covers this topic with no new info → no-op.
  | 'update' // A skill exists but this topic adds new information → update it.
  | 'split'; // One skill now carries enough distinct nuance to split in two.

/** The decider's verdict for one topic (before proposed-action framing). */
export interface DistillDecisionResult {
  decision: DistillDecision;
  /** For exact_match / update / split: the existing skill this topic hit. */
  matchedSkill?: string;
  /** For split: proposed names of the two skills to split into. */
  splitInto?: string[];
  /** One-line rationale. */
  reason: string;
  /** 0..1 decider confidence. */
  confidence: number;
}

/** Full distiller output for one topic, ready for audit + a follow-up action. */
export interface DistillReport {
  generated_at: string;
  /** Echo of the topic title, for auditability. */
  topic: string;
  role: SkillRole;
  decision: DistillDecision;
  matchedSkill?: string;
  splitInto?: string[];
  /** Human-readable next step the create/update/split path should take. */
  proposedAction: string;
  reason: string;
  confidence: number;
  /** Free-form notes (guardrail warnings, provenance, empty-library, …). */
  notes: string[];
}
