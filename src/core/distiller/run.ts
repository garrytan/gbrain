/**
 * distiller/run.ts — one distillation pass (Task 1).
 *
 * Pipeline (mirrors the orchestrator's collect → decide → report shape):
 *   1. GUARD: the topic must carry a healthcare role (APPI) — fail-closed.
 *   2. (optional) enrich the topic summary with retrieved brain data.
 *   3. Restrict existing skills to the topic's care lane (never cross lanes).
 *   4. DECIDE: none | exact_match | update | split (injected classifier, else v0).
 *   5. Frame the decision as a proposed create/update/split action + report.
 *
 * Retrieval + skill loading are injected seams, so this file has no DB / LLM
 * dependency yet (per "minus the database"). The create/update/split EXECUTION
 * (skillify scaffold / skillopt / resolver categorize) is a CLI-side concern —
 * this pass returns the PLAN, exactly as the orchestrator returns a report
 * rather than running `gbrain agent run` itself.
 */

import type {
  CandidateTopic,
  DistillDecisionResult,
  DistillReport,
  ExistingSkill,
} from './types.ts';
import { decideDistillation } from './decide.ts';
// Reuse the system-wide healthcare-role policy (single source of truth, shared
// with the orchestrator) so the two task modules can never disagree on what
// counts as a clinical lane.
import { isHealthcareRole } from '../orchestrator/custom-skills.ts';

/** Injected seams so the template runs without the DB / real skill loader / LLM. */
export interface DistillerDeps {
  /** Load all existing skills (real impl: list_skills over the skills dir). */
  loadExistingSkills: () => Promise<ExistingSkill[]>;
  /** Retrieve brain data for this topic (real impl: query/search, role-scoped). */
  retrieveBrainData?: (topic: CandidateTopic) => Promise<string[]>;
  /** Override the decider (real impl: LLM classifier). Defaults to the v0 pass. */
  classify?: (topic: CandidateTopic, sameLane: ExistingSkill[]) => DistillDecisionResult;
}

/** kebab-case slug from a topic title, for a proposed new skill path. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled-skill'
  );
}

/** Human-readable next step for each decision branch. */
function proposedActionFor(
  decision: DistillDecisionResult,
  topic: CandidateTopic,
): string {
  switch (decision.decision) {
    case 'none': {
      const slug = slugify(topic.title);
      return `create: \`gbrain skillify scaffold ${slug}\` (role: ${topic.role}), then author the SKILL.md body from the retrieved brain data`;
    }
    case 'exact_match':
      return `no-op: '${decision.matchedSkill}' already covers this topic`;
    case 'update':
      return `update: fold the new data into '${decision.matchedSkill}' (skillopt or agent-run rewrite), then re-run routing-eval`;
    case 'split':
      return `split: divide '${decision.matchedSkill}' into [${(decision.splitInto ?? []).join(
        ', ',
      )}] — scaffold both, deprecate the original, categorize the new resolver rows`;
  }
}

export async function runDistiller(
  topic: CandidateTopic,
  deps: DistillerDeps,
): Promise<DistillReport> {
  const notes: string[] = [];

  // 1. GUARD — APPI: patient-derived topics only ever become clinical skills.
  if (!isHealthcareRole(topic.role)) {
    throw new Error(
      `distiller: refusing to distill patient-derived data into a non-clinical role '${topic.role}'. ` +
        `Topics must carry a healthcare role (nurse|psychiatrist|general-medicine).`,
    );
  }

  // 2. (optional) enrich the topic summary with retrieved brain data.
  let workingTopic = topic;
  if (deps.retrieveBrainData) {
    const snippets = await deps.retrieveBrainData(topic);
    if (snippets.length > 0) {
      workingTopic = { ...topic, summary: [topic.summary, ...snippets].join('\n') };
      notes.push(`enriched topic with ${snippets.length} retrieved snippet(s)`);
    }
  }

  // 3. restrict to the topic's care lane — never compare across lanes.
  const all = await deps.loadExistingSkills();
  const sameLane = all.filter((s) => s.role === workingTopic.role);
  if (sameLane.length === 0) {
    notes.push(`no existing '${workingTopic.role}' skill yet — first in its lane`);
  }

  // 4. decide (injected LLM classifier, else deterministic v0).
  const decide = deps.classify ?? decideDistillation;
  const result = decide(workingTopic, sameLane);

  // 5. frame + report.
  if (result.decision === 'split' && (!result.splitInto || result.splitInto.length < 2)) {
    notes.push('split decision returned without two target skills — treating as advisory');
  }
  if (workingTopic.sourceIds?.length) {
    notes.push(`provenance: ${workingTopic.sourceIds.join(', ')}`);
  }

  return {
    generated_at: new Date().toISOString(),
    topic: workingTopic.title,
    role: workingTopic.role,
    decision: result.decision,
    matchedSkill: result.matchedSkill,
    splitInto: result.splitInto,
    proposedAction: proposedActionFor(result, workingTopic),
    reason: result.reason,
    confidence: result.confidence,
    notes,
  };
}
