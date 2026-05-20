/**
 * v0.37.0 — brainstorm + LSD shared judge (D6 — single file, two configs).
 *
 * One `runJudge(config, ideas)` function + two exported configs that flip the
 * threshold and the inversion rule. ~150 LOC vs the 200 LOC of two parallel
 * files (~70 LOC duplication eliminated). The brainstorm vs LSD contrast is
 * visible side-by-side at the config-export site.
 *
 * Rubric adapted from Open Collider's judge.md (CL-ML/open-collider, MIT).
 * Five axes scored 1-5; weighted average; per-config threshold.
 *
 * Brainstorm: standard rubric, threshold 4.0 (Open Collider uses 4.2 on
 * training-data inputs; brain-grounded inputs are inherently more constrained
 * so we relax slightly).
 *
 * LSD: inverted rubric. Rejects ideas with resistance > 4.5 ("too obvious,
 * you would have thought of this without LSD"). The "productive dissonance"
 * axis (cognitive_load) is the only one weighted heavily; everything else
 * permissive. Every output must invert at least one implicit axiom.
 *
 * Provider-neutral via `gateway.chat()`. Hermetically testable via the
 * `chatFn` injection point.
 */

import { chat as defaultChat, type ChatResult, type ChatOpts } from '../ai/gateway.ts';

export const PROMPT_VERSION = 'brainstorm-judge-v1';

/** One idea handed to the judge. The orchestrator builds these from the cross output. */
export interface JudgeIdea {
  /** Stable id within this run (e.g. "01", "02"). */
  id: string;
  /** Free-form idea text (2-4 sentences). */
  text: string;
  /** The (close, far) pair that produced this idea. Surfaces in the prompt for context. */
  close_slug: string;
  far_slug: string;
}

/** Per-axis 1-5 score from the LLM. */
export interface JudgeAxisScores {
  /** Is the underlying thesis genuinely new? */
  originality: number;
  /** Does the core thesis hold up against the strongest counterargument? */
  resistance: number;
  /** Could the idea be formulated as a single testable + refutable thesis? */
  thesis_density: number;
  /** Could the idea rely on a specific fact, figure, or named situation? */
  concrete_grounding: number;
  /** Does the idea force productive dissonance, or is it immediately expected? */
  cognitive_load: number;
}

/** Per-idea verdict the orchestrator consumes. */
export interface JudgeIdeaResult {
  id: string;
  scores: JudgeAxisScores;
  /** Weighted aggregate per the config's axis weights. */
  weighted_score: number;
  /** True iff this idea passes the config's threshold (after inversion rule for LSD). */
  passes: boolean;
  /** One-sentence judge note (main strength or rejection reason). */
  note: string;
}

/** Top-level judge response (one batch). */
export interface JudgeResult {
  ideas: JudgeIdeaResult[];
  /** Number of input ideas that passed the threshold. */
  pass_count: number;
  /** Provider:model that answered (for cost accounting / debugging). */
  model: string;
  usage: ChatResult['usage'];
}

/** Brainstorm vs LSD config delta. */
export interface JudgeConfig {
  /** Stable label — flows into the cache key and the run report. */
  label: 'brainstorm' | 'lsd';
  /** Axis weights — must sum to 1.0 (validated at module load). */
  weights: JudgeAxisScores;
  /** Threshold on the weighted average; ideas below this are filtered. */
  threshold: number;
  /**
   * LSD-only: reject ideas whose `resistance` (coherence) axis exceeds
   * `rejectIfResistanceAbove`. The Open Collider inversion: in LSD mode,
   * "too obvious" is the failure mode, not "too incoherent."
   * Undefined on brainstorm (standard rubric — high resistance is good).
   */
  rejectIfResistanceAbove?: number;
  /** Append to the rubric prompt — e.g. "every output must invert at least one axiom." */
  extraInstructions?: string;
}

/**
 * Brainstorm config. Mirrors Open Collider's judge.md exactly:
 *   originality 0.25, resistance 0.20, thesis_density 0.20,
 *   concrete_grounding 0.20, cognitive_load 0.15
 * Threshold 4.0 (relaxed from Open Collider's 4.2 — brain-grounded ideas
 * carry inherent constraint, so we don't need the extra stringency).
 */
export const BRAINSTORM_JUDGE_CONFIG: JudgeConfig = Object.freeze({
  label: 'brainstorm',
  weights: {
    originality: 0.25,
    resistance: 0.20,
    thesis_density: 0.20,
    concrete_grounding: 0.20,
    cognitive_load: 0.15,
  },
  threshold: 4.0,
});

/**
 * LSD config. The "Lateral Synaptic Drift" inversion:
 *   - cognitive_load (productive dissonance) is the only axis weighted heavily.
 *   - resistance > 4.5 ("too obvious") is an automatic rejection — these are
 *     the ideas you'd have surfaced without LSD mode.
 *   - axiomatic inversions required on every output.
 *   - threshold relaxed to 3.5 so weird-but-defensible ideas survive.
 */
export const LSD_JUDGE_CONFIG: JudgeConfig = Object.freeze({
  label: 'lsd',
  weights: {
    // The "productive dissonance" axis dominates the average.
    originality: 0.20,
    resistance: 0.05,
    thesis_density: 0.15,
    concrete_grounding: 0.10,
    cognitive_load: 0.50,
  },
  threshold: 3.5,
  rejectIfResistanceAbove: 4.5,
  extraInstructions:
    'Every kept idea MUST invert at least one implicit axiom (X is good → X is the problem; everyone does Y → the opposite; dominant narrative says Z → the hidden cause).',
});

// ---------------------------------------------------------------------------
// Module-load validation: each config's axis weights must sum to 1.0.
// ---------------------------------------------------------------------------

function validateConfig(config: JudgeConfig): void {
  const sum =
    config.weights.originality +
    config.weights.resistance +
    config.weights.thesis_density +
    config.weights.concrete_grounding +
    config.weights.cognitive_load;
  // Allow tiny floating-point tolerance.
  if (Math.abs(sum - 1.0) > 1e-9) {
    throw new Error(
      `[brainstorm/judges] ${config.label} axis weights must sum to 1.0 (got ${sum.toFixed(6)})`
    );
  }
}
validateConfig(BRAINSTORM_JUDGE_CONFIG);
validateConfig(LSD_JUDGE_CONFIG);

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)```/i;

function buildJudgePrompt(config: JudgeConfig, ideas: JudgeIdea[]): string {
  const w = config.weights;
  const ideasBlock = ideas
    .map(
      (idea) =>
        `## Idea ${idea.id}\n(close=${idea.close_slug} × far=${idea.far_slug})\n${idea.text}`
    )
    .join('\n\n');

  const inversionRule = config.rejectIfResistanceAbove !== undefined
    ? `\n\n## LSD INVERSION RULE\nAny idea with resistance > ${config.rejectIfResistanceAbove.toFixed(1)} is REJECTED regardless of weighted score — these are the ideas the user would surface without LSD. "Too obvious" is the failure mode here.`
    : '';

  const extras = config.extraInstructions ? `\n\n## ADDITIONAL CONSTRAINT\n${config.extraInstructions}` : '';

  return `You are a structural evaluator filtering brainstorm ideas. Score each idea on the underlying potential, not the current wording.

## AXES (each scored 1-5)

**Originality (weight ${w.originality.toFixed(2)})** — Is the underlying thesis genuinely new?
  5: thesis never seen formulated this way
  3: known angle with new packaging
  1: reformulation of standard advice

**Resistance (weight ${w.resistance.toFixed(2)})** — Does the core thesis hold up against the strongest possible objection?
  5: holds up even against the strongest counterargument
  3: substance recoverable, current wording doesn't resist
  1: a single objection collapses the entire idea

**Thesis density (weight ${w.thesis_density.toFixed(2)})** — Could it be formulated as a single testable + refutable thesis?
  5: precise thesis identifiable, directly attackable
  3: implicit thesis, recoverable with reformulation
  1: observation or anecdote from which no thesis can be extracted

**Concrete grounding (weight ${w.concrete_grounding.toFixed(2)})** — Could the idea rely on a specific fact, figure, or named situation?
  5: grounding already present, or obvious + immediately findable evidence
  3: grounding possible but requires non-trivial research
  1: pure abstraction, no real data could support it

**Cognitive load (weight ${w.cognitive_load.toFixed(2)})** — Does the idea force reconstruction, or is it immediately expected?
  5: productive dissonance — the reader must stop and think
  3: slightly counter-intuitive
  1: expected information, no friction${inversionRule}${extras}

## IDEAS TO EVALUATE

${ideasBlock}

## OUTPUT FORMAT (strict JSON, no prose outside the JSON)

\`\`\`json
{
  "ideas": [
    {
      "id": "<idea id>",
      "scores": {
        "originality": <1-5>,
        "resistance": <1-5>,
        "thesis_density": <1-5>,
        "concrete_grounding": <1-5>,
        "cognitive_load": <1-5>
      },
      "note": "<one sentence — main strength if passing, rejection reason if not>"
    }
  ]
}
\`\`\`

Respond with ONLY the JSON block, nothing before or after.`;
}

// ---------------------------------------------------------------------------
// JSON parsing — 3-strategy fallback. Throws on unparseable rather than
// fabricating a verdict.
// ---------------------------------------------------------------------------

export function parseJudgeJSON(text: string): unknown {
  if (!text) throw new Error('parseJudgeJSON: empty response');
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  const fenceMatch = text.match(FENCE_RE);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }
  // Common-repairs pass.
  const cleaned = text
    .replace(FENCE_RE, (_, inner) => inner)
    .replace(/,(\s*[}\]])/g, '$1')
    .trim();
  const braceMatch = cleaned.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      // fall through
    }
  }
  throw new Error('parseJudgeJSON: no strategy produced valid JSON');
}

// ---------------------------------------------------------------------------
// Score-shape validation
// ---------------------------------------------------------------------------

function isAxisScoreInRange(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 5;
}

function validateIdeaShape(raw: unknown): { id: string; scores: JudgeAxisScores; note: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const note = typeof r.note === 'string' ? r.note : '';
  const s = r.scores;
  if (typeof s !== 'object' || s === null) return null;
  const sr = s as Record<string, unknown>;
  if (
    !isAxisScoreInRange(sr.originality)
    || !isAxisScoreInRange(sr.resistance)
    || !isAxisScoreInRange(sr.thesis_density)
    || !isAxisScoreInRange(sr.concrete_grounding)
    || !isAxisScoreInRange(sr.cognitive_load)
  ) return null;
  return {
    id: r.id,
    scores: {
      originality: sr.originality,
      resistance: sr.resistance,
      thesis_density: sr.thesis_density,
      concrete_grounding: sr.concrete_grounding,
      cognitive_load: sr.cognitive_load,
    },
    note,
  };
}

// ---------------------------------------------------------------------------
// Weighted score computation
// ---------------------------------------------------------------------------

export function weightedScore(scores: JudgeAxisScores, weights: JudgeAxisScores): number {
  return (
    scores.originality * weights.originality
    + scores.resistance * weights.resistance
    + scores.thesis_density * weights.thesis_density
    + scores.concrete_grounding * weights.concrete_grounding
    + scores.cognitive_load * weights.cognitive_load
  );
}

/** Per-config passing rule. LSD additionally enforces the inversion-rule resistance ceiling. */
export function ideaPasses(idea: JudgeIdeaResult, config: JudgeConfig): boolean {
  if (idea.weighted_score < config.threshold) return false;
  if (
    config.rejectIfResistanceAbove !== undefined
    && idea.scores.resistance > config.rejectIfResistanceAbove
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public orchestrator
// ---------------------------------------------------------------------------

/** Test seam — swap the chat call without touching the real gateway. */
export type ChatFn = (opts: ChatOpts) => Promise<ChatResult>;

export interface RunJudgeOptions {
  /** Override the gateway's default chat model (e.g. for `gbrain models doctor` probes). */
  modelOverride?: string;
  /** Hermetic test seam. Production callers MUST NOT pass this. */
  chatFn?: ChatFn;
  /** Anti-bias context from the user's calibration profile (D4 + codex #8). */
  activeBiasTags?: string[];
  /** AbortSignal for Ctrl-C / shutdown propagation. */
  abortSignal?: AbortSignal;
}

/**
 * Single batch — caller chunks large idea sets to keep prompt size bounded.
 * Throws on parse failure (caller maps to judge_failed:true + saves unscored,
 * per D12).
 */
export async function runJudge(
  config: JudgeConfig,
  ideas: JudgeIdea[],
  options: RunJudgeOptions = {}
): Promise<JudgeResult> {
  if (ideas.length === 0) {
    // Empty input is a no-op success; callers can short-circuit too but
    // returning a well-formed empty result is more ergonomic.
    return { ideas: [], pass_count: 0, model: 'noop', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } };
  }
  const chat = options.chatFn ?? defaultChat;
  const prompt = buildJudgePrompt(config, ideas);

  // Anti-bias context (D4 + codex #8): inject the user's known biases so
  // the judge penalizes ideas that play to them. Cold-start (empty array)
  // falls through with no anti-bias context — orchestrator stderr-warns.
  const system = (options.activeBiasTags && options.activeBiasTags.length > 0)
    ? `You are scoring ideas for a user with the following known biases: ${options.activeBiasTags.join(', ')}. Penalize the originality axis when an idea closely matches a known bias pattern.`
    : undefined;

  const result = await chat({
    model: options.modelOverride,
    system,
    messages: [{ role: 'user', content: prompt }],
    // Judge runs cold (T=0.1) for consistency; the gateway's temperature
    // knob isn't on ChatOpts (it's set per-provider in instantiateChat),
    // so we rely on the default. If we ever need temperature control here
    // we'd extend ChatOpts.
    maxTokens: 4000,
    abortSignal: options.abortSignal,
  });

  const parsed = parseJudgeJSON(result.text);
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { ideas?: unknown }).ideas)) {
    throw new Error(`runJudge: response missing 'ideas' array. Got: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  const rawIdeas = (parsed as { ideas: unknown[] }).ideas;

  const ideaResults: JudgeIdeaResult[] = [];
  for (const raw of rawIdeas) {
    const validated = validateIdeaShape(raw);
    if (!validated) {
      // Skip malformed rows — the orchestrator surfaces a stderr warning if
      // fewer ideas come back than were submitted.
      continue;
    }
    const weighted_score = weightedScore(validated.scores, config.weights);
    const result: JudgeIdeaResult = {
      id: validated.id,
      scores: validated.scores,
      weighted_score,
      passes: false, // filled below
      note: validated.note,
    };
    result.passes = ideaPasses(result, config);
    ideaResults.push(result);
  }

  return {
    ideas: ideaResults,
    pass_count: ideaResults.filter((i) => i.passes).length,
    model: result.model,
    usage: result.usage,
  };
}
