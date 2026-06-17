/**
 * v0.29 — Emotional weight: deterministic 0..1 score for each page, computed
 * from tags + active takes during the dream cycle's recompute_emotional_weight
 * phase. Feeds the salience query (`get_recent_salience`) so pages with high
 * emotional weight outrank busy-but-shallow ones in "what's been going on?"
 * style queries.
 *
 * Pure function, no DB. The cycle phase loads inputs in batch via
 * `engine.batchLoadEmotionalInputs` and writes results in batch via
 * `engine.setEmotionalWeightBatch`.
 *
 * Tunable: the `HIGH_EMOTION_TAGS` seed list below is the default. Users
 * override via the `emotional_weight.high_tags` config key (array of strings).
 * See `loadHighEmotionTags` for the resolution path.
 */

/**
 * Default high-emotion tag seed list. Pages with any tag in this set get the
 * tag-emotion boost in the formula below. Override via config key
 * `emotional_weight.high_tags` to add domain-specific tags (e.g. health
 * conditions, family member names, project names tied to grief / loss).
 *
 * Anglocentric and personal-life-biased on purpose: this is the v1 default
 * for someone who keeps a personal brain. Override unconditionally at install
 * time if your brain is mostly work-life.
 */
export const HIGH_EMOTION_TAGS: ReadonlySet<string> = new Set([
  'family',
  'marriage',
  'wedding',
  'loss',
  'death',
  'grief',
  'relationship',
  'love',
  'mental-health',
  'health',
  'illness',
  'birth',
  'children',
  'kids',
  'parents',
]);

/**
 * Holder name treated as "the user" for the Garry-as-holder ratio. Configurable
 * via the `emotional_weight.user_holder` config key (defaults to 'garry' to
 * match the v0.28 schema's takes table convention).
 */
export const DEFAULT_USER_HOLDER = 'garry';

export interface EmotionalWeightTake {
  holder: string;
  weight: number;
  kind: string;
  active: boolean;
}

export interface EmotionalWeightInput {
  tags: readonly string[];
  takes: readonly EmotionalWeightTake[];
}

export interface EmotionalWeightOpts {
  /** Override the default HIGH_EMOTION_TAGS set. Tag matching is case-insensitive. */
  highEmotionTags?: ReadonlySet<string>;
  /** Override the default user holder name (used in the Garry-as-holder ratio). */
  userHolder?: string;
}

/**
 * Compute emotional weight in [0..1] from a page's tags + active takes.
 *
 * Formula (sum capped at 1.0):
 *   1) Tag emotion boost      max 0.5  (any matching high-emotion tag)
 *   2) Take density           max 0.3  (0.1 per active take, capped)
 *   3) Take avg weight        max 0.1  (avg of take.weight, scaled)
 *   4) User-holder ratio      max 0.1  (active takes by user / total active)
 *
 * Why these numbers:
 * - Tag emotion is the strongest signal (0.5 cap) because tags are an explicit
 *   user act of categorization. A page tagged `wedding` is *about* something
 *   emotionally weighty by construction.
 * - Take density (0.3) covers the case of pages with no emotion-tag but lots
 *   of opinions / hot-take attention (Garry's "I have a bunch of takes about
 *   this person/company" signal).
 * - Avg weight (0.1) captures take confidence; high-confidence takes amplify
 *   density.
 * - User-holder ratio (0.1) preserves the personal-vs-other distinction.
 *   A page where Garry has takes outweighs one where only third-party holders
 *   are recorded.
 *
 * Returns exactly 0.0 for empty inputs (no tags, no takes) so default-row
 * behavior survives the formula.
 */
export function computeEmotionalWeight(
  input: EmotionalWeightInput,
  opts: EmotionalWeightOpts = {},
): number {
  const tagSet = opts.highEmotionTags ?? HIGH_EMOTION_TAGS;
  const userHolder = (opts.userHolder ?? DEFAULT_USER_HOLDER).toLowerCase();

  const tags = input.tags ?? [];
  const allTakes = input.takes ?? [];
  const takes = allTakes.filter((t) => t.active);

  // 1) Tag emotion boost — case-insensitive match.
  let tagBoost = 0;
  for (const t of tags) {
    if (tagSet.has(t.toLowerCase())) {
      tagBoost = 0.5;
      break;
    }
  }

  // 2) Take density: 0.1 per active take, capped at 0.3.
  const takeDensity = Math.min(takes.length * 0.1, 0.3);

  // 3) Take avg weight, scaled into 0..0.1.
  let takeAvgWeight = 0;
  if (takes.length > 0) {
    const sum = takes.reduce((acc, t) => acc + clamp01(t.weight), 0);
    takeAvgWeight = (sum / takes.length) * 0.1;
  }

  // 4) User-holder ratio over active takes, scaled into 0..0.1.
  let userHolderRatio = 0;
  if (takes.length > 0) {
    const userTakes = takes.filter((t) => t.holder?.toLowerCase() === userHolder).length;
    userHolderRatio = (userTakes / takes.length) * 0.1;
  }

  const total = tagBoost + takeDensity + takeAvgWeight + userHolderRatio;
  return Math.max(0, Math.min(1, total));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
