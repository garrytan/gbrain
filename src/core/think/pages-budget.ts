/**
 * #5461: the think / synthesize pages-block budget, as configuration.
 *
 * `renderThinkPages` renders every gathered page as one excerpt. The per-page
 * excerpt length is `min(ceiling, floor(total / pageCount))` but never below
 * the 600-character floor (`pagesBlockExcerptLen` in gather.ts), so the total
 * is a SOFT bound: 40 pages at the 12 000 default render 40 × 600 = 24 000
 * characters. Raising `think.pages_budget_chars` alone does not deliver whole
 * pages either: `think.excerpt_ceiling_chars` (2 400 by default) still caps
 * each excerpt. A caller who wants whole pages raises both.
 *
 * Both keys are DB-plane (`gbrain config set`). A value outside its range, or
 * not an integer, is ignored for that call: the default applies and the
 * result warns `THINK_BUDGET_CONFIG_IGNORED:<key>`, so a typo never silently
 * changes what the model sees.
 */
import type { BrainEngine } from '../engine.ts';

export const THINK_PAGES_BUDGET_KEY = 'think.pages_budget_chars';
export const THINK_EXCERPT_CEILING_KEY = 'think.excerpt_ceiling_chars';

export const PAGES_BLOCK_TOTAL_BUDGET_CHARS = 12_000;
export const PAGES_BLOCK_EXCERPT_CEILING_CHARS = 2_400;
/** The per-page minimum a big gather never collapses below (#4510). */
export const PAGES_BLOCK_EXCERPT_FLOOR_CHARS = 600;

export const THINK_PAGES_BUDGET_BOUNDS = {
  [THINK_PAGES_BUDGET_KEY]: { min: 4_000, max: 200_000, fallback: PAGES_BLOCK_TOTAL_BUDGET_CHARS },
  [THINK_EXCERPT_CEILING_KEY]: { min: PAGES_BLOCK_EXCERPT_FLOOR_CHARS, max: 200_000, fallback: PAGES_BLOCK_EXCERPT_CEILING_CHARS },
} as const;

export interface PagesBudget {
  totalChars: number;
  ceilingChars: number;
}

export const DEFAULT_PAGES_BUDGET: PagesBudget = {
  totalChars: PAGES_BLOCK_TOTAL_BUDGET_CHARS,
  ceilingChars: PAGES_BLOCK_EXCERPT_CEILING_CHARS,
};

/** Parse one budget value: a base-10 integer inside the key's range, else null. */
export function parsePagesBudgetValue(key: keyof typeof THINK_PAGES_BUDGET_BOUNDS, raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  if (!/^\s*\d+\s*$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  const { min, max } = THINK_PAGES_BUDGET_BOUNDS[key];
  return n >= min && n <= max ? n : null;
}

/**
 * The budget for one synthesize call: two config reads, each falling back to
 * its default (with a warning on an explicit bad value; a read failure keeps
 * the default silently so a config-plane blip never changes the evidence).
 */
export async function readThinkPagesBudget(engine: Pick<BrainEngine, 'getConfig'>, warnings: string[]): Promise<PagesBudget> {
  const read = async (key: keyof typeof THINK_PAGES_BUDGET_BOUNDS): Promise<number> => {
    const raw = await engine.getConfig(key).catch(() => null);
    if (raw == null || raw.trim() === '') return THINK_PAGES_BUDGET_BOUNDS[key].fallback;
    const value = parsePagesBudgetValue(key, raw);
    if (value === null) {
      warnings.push(`THINK_BUDGET_CONFIG_IGNORED:${key}`);
      return THINK_PAGES_BUDGET_BOUNDS[key].fallback;
    }
    return value;
  };
  const [totalChars, ceilingChars] = await Promise.all([read(THINK_PAGES_BUDGET_KEY), read(THINK_EXCERPT_CEILING_KEY)]);
  return { totalChars, ceilingChars };
}

/** `gbrain config set` validation: the refusal text for a bad value, or null when it is acceptable. */
export function pagesBudgetConfigError(key: keyof typeof THINK_PAGES_BUDGET_BOUNDS, value: string): string | null {
  if (parsePagesBudgetValue(key, value) !== null) return null;
  const { min, max } = THINK_PAGES_BUDGET_BOUNDS[key];
  return `${key} must be an integer between ${min} and ${max} (characters); got ${JSON.stringify(value)}`;
}
