/**
 * #6191: which role verbs a link target can take. A role verb in a link's
 * context window ("VP of Sales", "founded … after") only types the edge when
 * the target can hold that role:
 *   - `works_at` needs an employer: never a person, a temporal or media page
 *     (meeting, calendar event, media, image, transcript), nor a document
 *     (conversation, email, source, note, inbox);
 *   - `founded` / `invested_in` never point at a temporal or media page
 *     (people found and invest together, so a person target keeps them).
 * With no target type, the slug's directory decides (`people/`, `meetings/`,
 * `calendar/`, `cal/`). Every other target is allowed, so pack-defined
 * organization types keep working.
 */
const TEMPORAL_OR_MEDIA_TYPES = new Set(['meeting', 'calendar', 'calendar-event', 'media', 'image', 'transcript']);
const TEMPORAL_PREFIXES = ['meetings/', 'calendar/', 'cal/'];

/** #6953: never employers. Shared with edge_contradictions' stored-edge admission; custom employer types stay allowed. */
export const NON_EMPLOYER_TYPES: readonly string[] = [
  ...TEMPORAL_OR_MEDIA_TYPES, 'person', 'conversation', 'email', 'source', 'note', 'inbox',
];
export const NON_EMPLOYER_PREFIXES: readonly string[] = [
  ...TEMPORAL_PREFIXES, 'people/', 'conversations/', 'emails/', 'sources/', 'notes/', 'inbox/',
];

export function targetTakesVerb(verb: string, targetSlug?: string, targetType?: string | null): boolean {
  if (verb !== 'works_at' && verb !== 'founded' && verb !== 'invested_in') return true;
  const temporal = targetType ? TEMPORAL_OR_MEDIA_TYPES.has(targetType) : TEMPORAL_PREFIXES.some(p => targetSlug?.startsWith(p));
  if (temporal) return false;
  if (verb !== 'works_at') return true;
  return targetType ? !NON_EMPLOYER_TYPES.includes(targetType) : !NON_EMPLOYER_PREFIXES.some(p => targetSlug?.startsWith(p));
}
