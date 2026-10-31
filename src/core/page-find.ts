/**
 * #7191: `gbrain find` / `find_pages`: find pages by name or path, the
 * lookups agents otherwise do with `ls` and `find`.
 *
 * One pattern, three forms, decided by its shape:
 *
 *   glob    contains `*` or `?`   matched whole against the slug or the
 *                                 source path (`people/*acme*`, `*.md`)
 *   prefix  contains `/`          a slug or source-path prefix
 *                                 (`companies/acme`)
 *   name    anything else         a substring of the title or of the slug's
 *                                 last segment (`acme`)
 *
 * Every form is case-insensitive and compiles to one ILIKE pattern, so the
 * trigram indexes on `pages.slug` and `pages.title` can serve it on both
 * engines (pg_trgm reads the default `\` escape and needs a literal run of
 * three characters). LIKE metacharacters in the user text are escaped: `%`
 * and `_` match themselves.
 */

import { escapeLikePattern } from './search/sql-ranking.ts';
import type { PageReadScope } from './types.ts';

/**
 * The read policy of an untrusted (remote) caller, applied through
 * `pageReadFilter(..., live = true)`: private pages, the trust floor,
 * quarantine, soft deletes and archived sources. Absent for the trusted local
 * CLI, which sees every live page in an unarchived source.
 */
export type UntrustedReadPolicy = Pick<PageReadScope, 'excludePrivate' | 'minTrust' | 'suppressFlagged'>;

export type FindPatternKind = 'glob' | 'prefix' | 'name';

export interface FindPattern {
  kind: FindPatternKind;
  /** ILIKE pattern with `\` escapes. */
  like: string;
  /** The literal text before the first wildcard (empty for a name). */
  lead: string;
}

/**
 * The ranked-search hard-exclude prefixes (`resolveHardExcludes`: `test/`,
 * `attachments/`, `.raw/` and GBRAIN_SEARCH_EXCLUDE) that a find hides. A
 * pattern whose literal lead is inside one of them asks for it, so that
 * prefix stays visible (`gbrain find 'attachments/*'`).
 */
export function hiddenPrefixesFor(pattern: FindPattern, excluded: readonly string[]): string[] {
  const lead = pattern.lead.toLowerCase();
  return excluded.filter((prefix) => !lead.startsWith(prefix.toLowerCase()));
}

export interface FindPagesQuery {
  pattern: FindPattern;
  types?: string[];
  limit: number;
  sourceId?: string;
  sourceIds?: string[];
  untrusted?: UntrustedReadPolicy;
  /** Hidden slug prefixes (`resolveHardExcludes`, as ranked search). */
  excludeSlugPrefixes: string[];
}

export interface FoundPage {
  slug: string;
  source_id: string;
  type: string;
  title: string;
  source_path: string | null;
  updated_at: string;
}

export interface FoundPages {
  rows: FoundPage[];
  /** Every page the pattern matched in scope, before the limit. */
  total: number;
}

/** Classify and compile a find pattern; throws on an empty one. */
export function parseFindPattern(raw: string): FindPattern {
  const text = raw.trim().replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (!text) throw new Error('find pattern is empty');
  if (/[*?]/.test(text)) {
    const like = [...text].map((c) => (c === '*' ? '%' : c === '?' ? '_' : escapeLikePattern(c))).join('');
    return { kind: 'glob', like, lead: text.split(/[*?]/)[0]! };
  }
  if (text.includes('/')) return { kind: 'prefix', like: `${escapeLikePattern(text)}%`, lead: text };
  return { kind: 'name', like: `%${escapeLikePattern(text)}%`, lead: '' };
}
