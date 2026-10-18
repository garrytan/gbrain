/**
 * The exact-match ladder shared by the `entity` card and the volunteer title
 * arm (#6725): among pages that match a name exactly in one source, an
 * explicit exact slug ranks first, then a linkable entity type (the source
 * pack's set, mentions/policy.ts), then any other page (meeting, transcript
 * or note containers). Lower is better.
 */
export function exactMatchPreference(
  row: { slug: string; type?: string | null },
  exactSlugs: readonly string[],
  entityTypes: ReadonlySet<string>,
): number {
  if (exactSlugs.includes(row.slug)) return 0;
  return entityTypes.has(row.type ?? '') ? 1 : 2;
}
