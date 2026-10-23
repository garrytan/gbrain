/**
 * Speaker attribution compatibility: the one rule every fact dedup path
 * applies before candidate limits and similarity decisions.
 *
 * `attributed_to` records WHO asserted a claim (user, assistant, a named
 * other party), never whether it is true or accepted. Two facts asserted by
 * different known speakers are never duplicates of each other: "Assistant
 * recommended the Lisbon hostel" must not collapse into, supersede, or be
 * swallowed by the user's own claim. NULL (attribution unavailable: older
 * facts, non-conversation text) is compatible with either speaker, so
 * brains without attribution keep their existing dedup behavior.
 */
import type { FactAttribution } from '../engine.ts';

/**
 * #7270: whether relink may attach a fact to an entity page. Only the user's
 * own claim, or one with no recorded speaker, is linked; an assistant's or a
 * named third party's claim stays where it was saved and is still recalled.
 */
export const entityLinkable = (a: FactAttribution | null | undefined): boolean => !a || a === 'user';
/** `entityLinkable` as a SQL predicate on the facts alias `f`. */
export const ENTITY_LINKABLE_SQL = `(f.attributed_to IS NULL OR f.attributed_to = 'user')`;

export function attributionCompatible(a: FactAttribution | null | undefined, b: FactAttribution | null | undefined): boolean {
  return !a || !b || a === b;
}
