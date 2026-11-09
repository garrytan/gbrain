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
 * resolved on its own. A query with a negation (`-dan-example`, `-draft`) or
 * a longer quoted phrase resolves no handle, so a handle never returns a page
 * the query excludes or a phrase it does not hold, and a strict keyword match
 * (`match: "keyword"` and its count) resolves handles only when every term is
 * one (a standalone handle or an OR list of them), so it keeps the AND of the
 * query's other words. Resolution is an exact match of the
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

const isHandle = (token: string): boolean => token.length <= 128 && HANDLE_RE.test(token) && /[a-z]/.test(token);

/**
 * The query's slug handles, lowercased, or null when it has none. With `standalone`, only when every term is a handle
 * or OR (the strict keyword match). A negation or a quoted phrase that is not a handle resolves none.
 */
export function slugHandles(query: string, standalone = false): string[] | null {
  const handles = new Set<string>();
  for (const m of query.normalize('NFKC').matchAll(/"([^"]*)"|(\S+)/g)) {
    const bare = m[2];
    if (bare?.startsWith('-')) return null;
    const token = (bare === undefined ? m[1]!.trim() : bare.replace(EDGE_PUNCTUATION, '')).toLowerCase();
    if (isHandle(token)) {
      if (handles.size < MAX_SLUG_HANDLES) handles.add(token);
    } else if (bare === undefined || (standalone && token !== 'or')) return null;
  }
  return handles.size ? [...handles] : null;
}

/** The pages whose slug basename is one of the handles in `param` (a text[] bind). */
export function handleMatchSql(pageAlias: string, param: string): string {
  return `regexp_replace(${pageAlias}.slug, '^.*/', '') = ANY(${param}::text[])`;
}
