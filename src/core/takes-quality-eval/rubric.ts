/**
 * takes-quality-eval/rubric — single source of truth for what "takes
 * quality" means in v0.32.
 *
 * Five dimensions distilled from the cross-modal eval over 100K production
 * takes (2026-05-10). Bumping any field here changes `rubricSha8()`, which
 * receipt-name binds into the filename so trend graphs segregate by rubric
 * version (codex review #3 — locks one-way-door schema_version=1 contract
 * on the FIRST receipt).
 *
 * Promotion path: dimension definitions and pass thresholds may evolve.
 * Bump `RUBRIC_VERSION` whenever a load-bearing field changes; trend graphs
 * group by version so v1 and v2 receipts coexist without lying about each
 * other's quality.
 */
import { createHash } from 'node:crypto';

export const RUBRIC_VERSION = 'v1.0' as const;

/** The 5 dimensions a model must score for its result to count toward verdict. */
export const RUBRIC_DIMENSIONS = [
  'accuracy',
  'attribution',
  'weight_calibration',
  'kind_classification',
  'signal_density',
] as const;

export type RubricDimension = typeof RUBRIC_DIMENSIONS[number];

/**
 * Per-dimension definitions. The judge prompt embeds these so models score
 * the same shape every time; receipts persist this object's sha so trend
 * mode can detect rubric drift across runs.
 */
export const RUBRIC_DIMENSION_DEFS: Record<RubricDimension, { description: string; rubric_1_to_10: string }> = {
  accuracy: {
    description:
      'Does the claim faithfully represent the source page? No invented facts, ' +
      'no misattributed quotes, no over-extrapolations.',
    rubric_1_to_10:
      '10 = every claim verifiable from the page text; 7 = mostly faithful with minor ' +
      'paraphrase drift; 4 = recognizable extrapolation; 1 = invented or hallucinated.',
  },
  attribution: {
    description:
      'Holder column reflects WHO HOLDS the belief, not who it is ABOUT. ' +
      'Self-reported claims attribute to the speaker, not world.',
    rubric_1_to_10:
      '10 = every holder is the actual claimant; 7 = clear holders with occasional ' +
      'analysis-vs-belief slips; 4 = systematic holder/subject confusion; 1 = wrong by default.',
  },
  weight_calibration: {
    description:
      'Weights are on the 0.05 grid and reflect actual confidence. No false precision ' +
      '(0.74, 0.82). Self-reports cap below world-fact weights.',
    rubric_1_to_10:
      '10 = grid-aligned and well-calibrated; 7 = grid-aligned, calibration sometimes loose; ' +
      '4 = false precision or systematic over-confidence; 1 = arbitrary numbers.',
  },
  kind_classification: {
    description:
      'fact / take / bet / hunch chosen correctly. Predictions are bets, ' +
      'verifiable assertions are facts, opinions are takes, intuitions are hunches.',
    rubric_1_to_10:
      '10 = every kind matches the documented contract; 7 = correct most of the time; ' +
      '4 = systematic kind drift; 1 = arbitrary kind assignment.',
  },
  signal_density: {
    description:
      'Each take is load-bearing for some future query. Skip Twitter handles, follower ' +
      'counts, restated bio fields, generic praise.',
    rubric_1_to_10:
      '10 = every take pays its rent; 7 = mostly substantial with occasional metadata ' +
      'creep; 4 = significant trivia content; 1 = mostly noise.',
  },
};

export const PASS_MEAN_THRESHOLD = 7;
export const PASS_FLOOR_THRESHOLD = 5;
export const MIN_SUCCESSES_FOR_VERDICT = 2;

/**
 * Render the judge prompt for a corpus of takes. Returns `{prompt, sha8}`
 * where sha8 is the 8-character prefix bound into the receipt name. Two
 * runs over the same corpus + same rubric produce the same sha8.
 */
export function renderJudgePrompt(takesText: string): { prompt: string; sha8: string } {
  const dimsBlock = RUBRIC_DIMENSIONS.map(d => {
    const def = RUBRIC_DIMENSION_DEFS[d];
    return `### ${d}\n${def.description}\nScale 1-10: ${def.rubric_1_to_10}`;
  }).join('\n\n');

  const prompt = `You are evaluating a sample of "takes" — typed, weighted, attributed ` +
    `claims pulled from a personal knowledge base. Score the sample on the 5 ` +
    `dimensions below. Return STRICT JSON shaped exactly like this:\n\n` +
    `{\n  "scores": {\n    "accuracy": {"score": <1-10>, "feedback": "<one short sentence>"},\n` +
    `    "attribution": {"score": <1-10>, "feedback": "..."},\n` +
    `    "weight_calibration": {"score": <1-10>, "feedback": "..."},\n` +
    `    "kind_classification": {"score": <1-10>, "feedback": "..."},\n` +
    `    "signal_density": {"score": <1-10>, "feedback": "..."}\n  },\n` +
    `  "overall": <1-10>,\n  "improvements": ["one specific suggestion", ...]\n}\n\n` +
    `All five dimensions are required. Missing dimensions disqualify your ` +
    `contribution to the verdict.\n\n` +
    `# Dimensions\n\n${dimsBlock}\n\n` +
    `# The takes sample\n\n${takesText}\n`;

  const sha8 = createHash('sha256').update(prompt).digest('hex').slice(0, 8);
  return { prompt, sha8 };
}

/**
 * Stable 8-char fingerprint over the rubric definition. Receipt-name binds
 * this so two runs with the same rubric produce the same receipt key,
 * while a future rubric tweak segregates trend rows cleanly.
 */
export function rubricSha8(): string {
  const canonical = JSON.stringify({
    version: RUBRIC_VERSION,
    dimensions: RUBRIC_DIMENSIONS,
    defs: RUBRIC_DIMENSION_DEFS,
    pass_mean: PASS_MEAN_THRESHOLD,
    pass_floor: PASS_FLOOR_THRESHOLD,
    min_successes: MIN_SUCCESSES_FOR_VERDICT,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}
