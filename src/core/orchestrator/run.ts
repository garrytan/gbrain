/**
 * orchestrator/run.ts — one routing pass of the patient orchestrator.
 *
 * Pipeline (mirrors the advisor's collect → rank → report shape):
 *   1. Take candidate skills (from list_skills; injected so this stays testable).
 *   2. GATE: keep only our custom clinical skills; refuse patient data → generic
 *      GBrain skills (custom-skills.ts). Generic matches are recorded, not run.
 *   3. Select + rank the eligible skills against input + history + prior outputs.
 *   4. Fail-closed assert, then return a ranked report.
 *
 * Retrieval (history) is a black box upstream — injected via deps so this file
 * has no DB dependency yet (per "minus the database").
 *
 * The feedback loop is realised by CALLING this again with the previous pass's
 * skill outputs in ctx.priorSkillOutputs; the selector re-ranks with the new
 * evidence. Stop when recommendations stabilise / go empty.
 */

import type {
  CandidateSkill,
  OrchestratorContext,
  OrchestratorReport,
  SkillRecommendation,
} from './types.ts';
import { assertAllCustom, partitionSkills, GENERIC_GBRAIN_SKILLS } from './custom-skills.ts';
import { selectSkills } from './select.ts';

/** Injected seams so the template runs without the DB / real skill loader. */
export interface OrchestratorDeps {
  /** Load all candidate skills (real impl: list_skills over the skills dir). */
  loadCandidateSkills: () => Promise<CandidateSkill[]>;
  /** Retrieve historical info for this input (real impl: query/volunteer_context). */
  retrieveHistory?: (ctx: OrchestratorContext) => Promise<OrchestratorContext['history']>;
  /** Override the selector (real impl: LLM ranker). Defaults to the v0 placeholder.
   *  May be sync (the v0 placeholder) or async (the LLM ranker). */
  select?: (
    ctx: OrchestratorContext,
    custom: CandidateSkill[],
  ) => SkillRecommendation[] | Promise<SkillRecommendation[]>;
}

function summarise(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export async function runOrchestrator(
  ctx: OrchestratorContext,
  deps: OrchestratorDeps,
): Promise<OrchestratorReport> {
  const notes: string[] = [];

  // 1. candidates
  const candidates = await deps.loadCandidateSkills();

  // (optional) enrich context with retrieved history before selection
  if (deps.retrieveHistory) {
    ctx = { ...ctx, history: await deps.retrieveHistory(ctx) };
  }

  // 2. GATE — custom clinical skills only.
  const { custom, generic } = partitionSkills(candidates);
  if (custom.length === 0) {
    notes.push(
      'No custom clinical (nurse/psychiatrist) skill available — patient data will NOT be ' +
        'routed to generic GBrain skills. A skill likely needs authoring (Task 1).',
    );
  }

  // Record generic skills that WOULD have matched, for the audit trail. We do not
  // run them; we just make the refusal explicit and reviewable (APPI).
  const genericNames = new Set<string>([...GENERIC_GBRAIN_SKILLS, ...generic.map((g) => g.name)]);
  const excluded_generic = [...genericNames].sort();

  // 3. select + rank (custom only)
  const select = deps.select ?? selectSkills;
  const recommendations = await select(ctx, custom);

  // 4. fail-closed: every recommended skill must be a custom clinical skill.
  const recSet = new Map(custom.map((s) => [s.name, s] as const));
  assertAllCustom(recommendations.map((r) => recSet.get(r.skill)).filter((s): s is CandidateSkill => !!s));

  if (recommendations.length === 0 && custom.length > 0) {
    notes.push('Custom skills exist but none matched this input (placeholder selector).');
  }

  return {
    generated_at: ctx.now.toISOString(),
    input_summary: summarise(ctx.input.text),
    recommendations,
    excluded_generic,
    notes,
  };
}
