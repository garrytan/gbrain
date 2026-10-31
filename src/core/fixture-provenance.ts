/** Producer opt-in: only a boolean marker excludes a page from entity evidence.
 * Content, titles, deployment names and truthy strings are never classifiers.
 * Source ingestion and ordinary retrieval remain unchanged.
 */
export function isSyntheticFixture(page: { frontmatter?: Record<string, unknown> } | null | undefined): boolean {
  return page?.frontmatter?.synthetic === true;
}
