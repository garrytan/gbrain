/**
 * GBRA-108: slug handles in keyword search. A person page slugged
 * `people/dan-example` and titled "Dan Example" holds its handle only in the
 * slug, and `websearch_to_tsquery` turns `dan-example` (quoted or bare) into
 * a phrase that needs the compound lexeme `dan-exampl`, which only text
 * holding the literal hyphenated handle has. So `"dan-example" OR
 * "erin-example"` matched the pages that mention the handles and never the
 * pages they name, and with `--types '["person"]'` it matched nothing.
 *
 * A handle is a hyphenated slug-leaf token with a letter in it (`dan-example`,
 * `acme-example-2`), bare or quoted on its own; each quoted handle of an OR is
 * resolved on its own, and a negated one (`-dan-example`) or one inside a
 * longer quoted phrase is not resolved. Resolution is an exact match of the
 * slug's basename (the part after the last `/`, the whole slug for a root
 * page), served by idx_pages_slug_basename like `whois`. The match is a second
 * arm of the keyword statement (search/keyword-statement.ts) under the same
 * filters, scope and visibility, so `--types`, remote scope, private pages and
 * quarantine apply as for any text match. Queries without a handle build
 * exactly the statements they built before.
 */

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const EDGE_PUNCTUATION = /^[(\[{<'\u2018\u201c]+|[)\]}>'\u2019\u201d.,;:!?]+$/gu;

/** At most this many handles per query (a pasted list of slugs stays one bounded index probe). */
export const MAX_SLUG_HANDLES = 16;

/** The query's slug handles, lowercased, or null when it has none. */
export function slugHandles(query: string): string[] | null {
  const handles = new Set<string>();
  for (const m of query.normalize('NFKC').matchAll(/"([^"]*)"|(\S+)/g)) {
    const bare = m[2];
    if (bare?.startsWith('-')) continue;
    const token = (bare === undefined ? m[1]!.trim() : bare.replace(EDGE_PUNCTUATION, '')).toLowerCase();
    if (token.length > 128 || !HANDLE_RE.test(token) || !/[a-z]/.test(token)) continue;
    handles.add(token);
    if (handles.size === MAX_SLUG_HANDLES) break;
  }
  return handles.size ? [...handles] : null;
}

/** The pages whose slug basename is one of the handles in `param` (a text[] bind). */
export function handleMatchSql(pageAlias: string, param: string): string {
  return `regexp_replace(${pageAlias}.slug, '^.*/', '') = ANY(${param}::text[])`;
}
