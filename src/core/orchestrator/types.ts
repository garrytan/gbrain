/**
 * orchestrator/types.ts — shared types for the patient orchestrator (Task 2).
 *
 * The orchestrator takes a new patient input + current state, weighs it against
 * retrieved historical information, and returns a RANKED list of skills to run.
 * Deliberately mirrors the advisor's shape (collect → rank → report), but where
 * the advisor answers "what's wrong with this brain?", the orchestrator answers
 * "given THIS patient input, which skills should run?".
 *
 * IRON RULE (see custom-skills.ts): patient/healthcare data may only be routed
 * to our OWN custom clinical skills (role: nurse | psychiatrist | general-medicine).
 * It is never routed to generic bundled GBrain skills (query, ingest, maintain, …).
 */

// The care-team role a skill declares in frontmatter. Single source of truth is
// the frozen contract in skill-frontmatter.ts; re-exported so the rest of the
// orchestrator imports it locally.
import type { SkillRole } from '../skill-frontmatter.ts';
export type { SkillRole };

/** A new patient input the orchestrator must route. */
export interface PatientInput {
  /** The new free-text input / observed state (chief complaint, note, message). */
  text: string;
  /** Optional patient identifier, used to scope history retrieval. */
  patientId?: string;
  /** Optional structured current state (vitals, flags, meds, …). */
  state?: Record<string, unknown>;
}

/** A skill that COULD be selected. `role` undefined ⇒ generic GBrain skill. */
export interface CandidateSkill {
  name: string;
  path: string;
  description: string;
  /** Raw SKILL.md frontmatter `role:` value. Undefined for generic GBrain skills. */
  role?: string;
  triggers: string[];
}

/** A retrieved historical record (retrieval is a black box upstream). */
export interface HistoryItem {
  id: string;
  snippet: string;
  /** Relevance score from the retrieval layer, if available. */
  score?: number;
}

/** Output of a previously-run skill, fed back in for the next routing pass. */
export interface SkillOutput {
  skill: string;
  summary: string;
}

/** Everything the orchestrator reasons over for one routing pass. */
export interface OrchestratorContext {
  input: PatientInput;
  /** Historical information pulled for this input (query/volunteer_context). */
  history: HistoryItem[];
  /** Feedback loop: outputs from earlier skills in this session, if any. */
  priorSkillOutputs?: SkillOutput[];
  now: Date;
  /** True over MCP (untrusted). Tightens what may be auto-run. */
  remote: boolean;
}

/** A single skill the orchestrator recommends running, with its rationale. */
export interface SkillRecommendation {
  skill: string;
  role: SkillRole;
  /** One-line why-this-skill. */
  reason: string;
  /** 0..1 selector confidence. */
  confidence: number;
}

export interface OrchestratorReport {
  generated_at: string;
  /** Short echo of the input, for auditability. */
  input_summary: string;
  /** Ranked custom skills to run, highest confidence first. */
  recommendations: SkillRecommendation[];
  /**
   * Generic GBrain skills that matched on triggers but were REFUSED because
   * patient data must not be routed to generic skills. Surfaced for the audit
   * trail (APPI) — never silently dropped.
   */
  excluded_generic: string[];
  /** Free-form notes (e.g. "no custom skill matched — needs authoring"). */
  notes: string[];
}

/**
 * Runs ONE recommended skill and returns its output, for the feedback loop
 * (loop.ts). Injected so the loop stays testable and so wiring real execution
 * (`gbrain agent run`) — and the auto-run boundary that gates it — is a separate,
 * deliberate decision, not something the read-scope orchestrator does implicitly.
 */
export type SkillExecutor = (
  rec: SkillRecommendation,
  ctx: OrchestratorContext,
) => Promise<SkillOutput>;
