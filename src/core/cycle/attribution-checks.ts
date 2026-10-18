/**
 * #5425 [UC4]: the one switch for the two mechanical attribution checks that
 * wave 14 ships off by default, `dream.attribution_checks`:
 *
 * - `propose-takes-attribution.ts`: a proposal held by a person whose numbers,
 *   dates and quoted phrases only assistant turns of the page state is held by
 *   `brain` instead (a turn the user explicitly accepted still counts as the
 *   user's).
 * - `synthesize-verify.ts` `superseded_in_source`: a synthesized sentence whose
 *   grounded quote a later user turn negates on the same number or date is
 *   quarantined to `unverified_claims`.
 *
 * Both change recall and attribution the way the opt-in prompt rules
 * (`dream.synthesize.attribution_rules`, `dream.propose_takes.attribution_rules`)
 * do, so the default flips only on a held-out gbrain-evals receipt. Off, every
 * output is byte-identical to the release before the checks existed.
 */
import { isConfigTruthy } from '../config.ts';

export const ATTRIBUTION_CHECKS_KEY = 'dream.attribution_checks';

const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/** `config set` validation: the boolean a value means, or null when it means neither. */
export function parseAttributionChecks(raw: string): boolean | null {
  if (isConfigTruthy(raw)) return true;
  return FALSE_WORDS.has(raw.trim().toLowerCase()) ? false : null;
}

/** Unset, unreadable or not a true word: off. A config lookup never stops a phase. */
export async function attributionChecksEnabled(engine: { getConfig?(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    return isConfigTruthy(await engine.getConfig?.(ATTRIBUTION_CHECKS_KEY));
  } catch {
    return false;
  }
}
