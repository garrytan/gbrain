/**
 * #6191: which role verbs a link target can take. A role verb in a link's
 * context window ("VP of Sales", "founded … after") only types the edge when
 * the target can hold that role:
 *   - `works_at` needs an employer: never a person, a temporal or media page
 *     (meeting, calendar event, media, image, transcript), nor a document
 *     (conversation, email, source, note, inbox);
 *   - `founded` / `invested_in` / `advises` never point at a temporal or
 *     media page nor a document (#9727; people found, invest and advise
 *     together, so a person target keeps them).
 * With no target type, the slug's directory decides (`people/`, `meetings/`,
 * `calendar/`, `cal/`, `emails/`, ...). Every other target is allowed, so
 * pack-defined organization types keep working.
 */
const TEMPORAL_OR_MEDIA_TYPES = new Set(['meeting', 'calendar', 'calendar-event', 'media', 'image', 'transcript']);
const TEMPORAL_PREFIXES = ['meetings/', 'calendar/', 'cal/'];
const DOCUMENT_TYPES = ['conversation', 'email', 'source', 'note', 'inbox'];
const DOCUMENT_PREFIXES = ['conversations/', 'emails/', 'sources/', 'notes/', 'inbox/'];
const ROLE_VERBS = new Set(['works_at', 'founded', 'invested_in', 'advises']);

/** #6953: never employers. Shared with edge_contradictions' stored-edge admission; custom employer types stay allowed. */
export const NON_EMPLOYER_TYPES: readonly string[] = [...TEMPORAL_OR_MEDIA_TYPES, 'person', ...DOCUMENT_TYPES];
export const NON_EMPLOYER_PREFIXES: readonly string[] = [...TEMPORAL_PREFIXES, 'people/', ...DOCUMENT_PREFIXES];

export function targetTakesVerb(verb: string, targetSlug?: string, targetType?: string | null): boolean {
  if (!ROLE_VERBS.has(verb)) return true;
  const [types, prefixes] = verb === 'works_at'
    ? [NON_EMPLOYER_TYPES, NON_EMPLOYER_PREFIXES]
    : [[...TEMPORAL_OR_MEDIA_TYPES, ...DOCUMENT_TYPES], [...TEMPORAL_PREFIXES, ...DOCUMENT_PREFIXES]];
  return targetType ? !types.includes(targetType) : !prefixes.some(p => targetSlug?.startsWith(p));
}
