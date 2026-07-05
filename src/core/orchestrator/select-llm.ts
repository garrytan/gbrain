/**
 * orchestrator/select-llm.ts — the real skill selector (LLM ranker).
 *
 * Given (patient input + retrieved history + prior skill outputs) and the set of
 * ELIGIBLE custom clinical skills, ask the model to rank which skills should run.
 * This is the production replacement for select.ts's v0 trigger-overlap placeholder,
 * and the seat the unimplemented `routing-eval --llm` placeholder was left for.
 *
 * The `chat` function is INJECTED (not imported) so this module has no runtime
 * dependency on the AI gateway — deps-live.ts passes the real `chat`, tests pass a
 * fake. Only gateway TYPES are imported (erased at build).
 *
 * Safety: the model is only ever handed the already-gated custom skills, and its
 * output is re-validated against that set by exact name AND re-checked for a
 * clinical role before it becomes a recommendation. A hallucinated or non-clinical
 * skill name is dropped, never routed to. run.ts's assertAllCustom is the final
 * fail-closed backstop.
 */

import type { ChatOpts, ChatResult, ChatToolDef } from '../ai/gateway.ts';
import type { CandidateSkill, OrchestratorContext, SkillRecommendation } from './types.ts';
import { isHealthcareRole } from './custom-skills.ts';

/** The single gateway capability this selector needs. */
export type ChatFn = (opts: ChatOpts) => Promise<ChatResult>;

const SELECT_SYSTEM = [
  'You are a clinical skill router for a healthcare knowledge brain.',
  'Given a new patient input (plus current state, retrieved history, and any prior',
  'skill outputs), choose which of the CANDIDATE clinical skills should run, ranked',
  'most-relevant first.',
  '',
  'Rules:',
  '- Choose ONLY from candidate_skills, by their EXACT name. Never invent a skill.',
  '- Each candidate has a care-team `role` (nurse | psychiatrist | general-medicine);',
  '  weigh the input against the role and the description/triggers.',
  '- Omit skills that do not apply. Returning fewer, well-justified skills is better',
  '  than routing to everything.',
  '- confidence is 0..1. reason is one short clause.',
  'Return your answer via the rank_skills tool.',
].join('\n');

const RANK_TOOL: ChatToolDef = {
  name: 'rank_skills',
  description: 'Return the clinical skills to run for this patient input, ranked most-relevant first.',
  inputSchema: {
    type: 'object',
    properties: {
      ranked: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: 'Exact candidate skill name.' },
            confidence: { type: 'number', description: 'Relevance, 0..1.' },
            reason: { type: 'string', description: 'One short clause: why this skill.' },
          },
          required: ['skill', 'confidence', 'reason'],
        },
      },
    },
    required: ['ranked'],
  },
};

interface RankedRow {
  skill: string;
  confidence: number;
  reason: string;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Tolerant JSON: strip ``` fences, start at the first `{`, parse. */
function tolerantJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return undefined;
  try {
    return JSON.parse(cleaned.slice(start));
  } catch {
    return undefined;
  }
}

/** Extract ranked rows: prefer the tool-call's parsed input, fall back to JSON text. */
function extractRanked(result: ChatResult): RankedRow[] {
  const call = result.blocks?.find((b) => (b as { type?: string }).type === 'tool-call');
  const source = call ? (call as { input?: unknown }).input : tolerantJson(result.text);
  const ranked = (source as { ranked?: unknown } | undefined)?.ranked;
  if (!Array.isArray(ranked)) return [];
  return ranked
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      skill: String(r.skill ?? ''),
      confidence: clamp01(Number(r.confidence)),
      reason: String(r.reason ?? ''),
    }));
}

export async function selectSkillsLLM(
  ctx: OrchestratorContext,
  custom: CandidateSkill[],
  chatFn: ChatFn,
): Promise<SkillRecommendation[]> {
  if (custom.length === 0) return []; // nothing eligible — don't spend a model call

  const payload = {
    input: ctx.input.text,
    state: ctx.input.state ?? {},
    history: ctx.history.slice(0, 10).map((h) => h.snippet),
    prior_skill_outputs: (ctx.priorSkillOutputs ?? []).map((o) => `${o.skill}: ${o.summary}`),
    candidate_skills: custom.map((s) => ({
      name: s.name,
      role: s.role,
      description: s.description,
      triggers: s.triggers,
    })),
  };

  const result = await chatFn({
    system: SELECT_SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
    tools: [RANK_TOOL],
    maxTokens: 1500,
  });

  // Re-validate every row against the eligible set. Drop anything not a known
  // custom clinical skill — the model never widens the gate.
  const byName = new Map(custom.map((s) => [s.name, s] as const));
  const seen = new Set<string>();
  const out: SkillRecommendation[] = [];
  for (const row of extractRanked(result)) {
    const s = byName.get(row.skill);
    if (!s) continue; // hallucinated / non-candidate
    if (!isHealthcareRole(s.role)) continue; // defense-in-depth (should be impossible post-gate)
    if (seen.has(s.name)) continue; // dedupe
    seen.add(s.name);
    out.push({ skill: s.name, role: s.role, reason: row.reason, confidence: row.confidence });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
