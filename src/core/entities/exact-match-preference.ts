/** Shared exact-match precedence: explicit identity, then a source-pack entity, then a container. */
export function exactMatchPreference(
  row: { slug: string; type?: string | null },
  exactSlugs: readonly string[],
  entityTypes: ReadonlySet<string>,
): number {
  if (exactSlugs.includes(row.slug)) return 0;
  return entityTypes.has(row.type ?? '') ? 1 : 2;
}
