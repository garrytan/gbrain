/**
 * recall's config keys and their values (#2941, #2953). `config set` refuses
 * any other value (commands/config.ts), so a typo never reads as "on".
 *
 *   recall.confidence_weighting  on | off (default off): question ranking weighs facts by recallConfidence (facts/decay.ts)
 *   recall.group_by_entity       on | off (default off): a question with no entity returns its facts grouped by entity
 *   recall.question_admission    reserve (default) | facts_arm
 */
import type { BrainEngine } from '../engine.ts';
import { QUESTION_ADMISSION_RULES } from '../search/fact-relevance.ts';

export const CONFIDENCE_WEIGHTING_KEY = 'recall.confidence_weighting';
export const GROUP_BY_ENTITY_KEY = 'recall.group_by_entity';
const SWITCH_KEYS: readonly string[] = [CONFIDENCE_WEIGHTING_KEY, GROUP_BY_ENTITY_KEY];
const ON = ['on', 'true', '1', 'yes'];
const OFF = ['off', 'false', '0', 'no'];

/** Whether a stored switch value is on; unset and unknown values are off. */
export const recallSwitchOn = (raw: string | null | undefined): boolean => ON.includes(raw?.trim().toLowerCase() ?? '');

/** The two switches, read once per call; an unreadable config reads as off. */
export async function readRecallSwitches(engine: BrainEngine): Promise<{ weighting: boolean; grouping: boolean }> {
  const [weighting, grouping] = await Promise.all([
    engine.getConfig(CONFIDENCE_WEIGHTING_KEY).catch(() => null),
    engine.getConfig(GROUP_BY_ENTITY_KEY).catch(() => null),
  ]);
  return { weighting: recallSwitchOn(weighting), grouping: recallSwitchOn(grouping) };
}

/** Why `value` is not a valid value for a recall key, or null when it is (or the key is not one of these). */
export function recallConfigValueRefusal(key: string, value: string): string | null {
  const v = value.trim().toLowerCase();
  if (SWITCH_KEYS.includes(key)) {
    return ON.includes(v) || OFF.includes(v) ? null : `${key} must be on or off; got ${JSON.stringify(value)}. Nothing was written.`;
  }
  if (key === 'recall.question_admission') {
    return (QUESTION_ADMISSION_RULES as readonly string[]).includes(v) ? null
      : `recall.question_admission must be one of ${QUESTION_ADMISSION_RULES.join(', ')}; got ${JSON.stringify(value)}. Nothing was written.`;
  }
  return null;
}
