/**
 * #7191: `find_pages` (CLI `gbrain find <pattern>`): find pages by name or
 * path in one indexed read, instead of `ls` / `find` on a checkout. Pattern
 * forms and matching rules: src/core/page-find.ts; SQL and index use:
 * src/core/engine-sql/page-lookup.ts.
 *
 * Scope follows `list_pages`: `federatedSearchScope` (an explicit `source_id`,
 * `'__all__'` included, is checked against the grant and must name a live
 * source). Every caller sees live pages in unarchived sources; a remote
 * caller's `readPolicyOpts` policy goes through `pageReadFilter` (private
 * pages, trust floor, quarantine). Like ranked search, find hides the
 * `resolveHardExcludes` prefixes unless the pattern targets one; the result
 * names the prefixes it hid.
 *
 * The result says whether it is complete: `total` counts every match in
 * scope, and `complete: false` means the limit cut the list.
 */
import { clampSearchLimit } from '../engine.ts';
import { hiddenPrefixesFor, parseFindPattern, type FindPattern } from '../page-find.ts';
import { resolveHardExcludes } from '../search/source-boost.ts';
import type { Operation, OperationContext } from './contract.ts';
import { assertExplicitSourceLive, federatedSearchScope, parseSourceIdParam, readPolicyOpts } from './context.ts';
import { invalidParam, paramUse } from './op-fix.ts';

export const FIND_PAGES_DEFAULT_LIMIT = 50;
/** Hard caps: a find is a lookup, not an export (`list_pages` pages through everything). */
export const FIND_PAGES_LOCAL_MAX_LIMIT = 500;
export const FIND_PAGES_REMOTE_MAX_LIMIT = 100;

function parseTypes(ctx: OperationContext, p: Record<string, unknown>): string[] | undefined {
  const raw: unknown[] = [];
  for (const key of ['type', 'types'] as const) {
    const value = p[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) raw.push(...value);
    else if (typeof value === 'string') raw.push(...value.split(','));
    else raw.push(value);
  }
  if (raw.some((type) => typeof type !== 'string')) {
    throw invalidParam(ctx, 'find_pages', 'types', 'find_pages: types must be page-type strings.', { example: ctx.remote === false ? '["person","company"]' : ['person', 'company'] });
  }
  const types = [...new Set((raw as string[]).map((type) => type.trim()).filter(Boolean))];
  return types.length > 0 ? types : undefined;
}

const find_pages: Operation = {
  name: 'find_pages',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description:
    "Find pages by name or path (what ls/find would answer), sorted by slug. pattern: a glob ('people/*acme*') matched against slug or source path, " +
    "a slug prefix ('companies/acme'), or a plain name ('acme', a case-insensitive substring of the title or the slug's last segment). " +
    'Returns slug, source_id, type, title, source_path and updated_at per page, total matches in scope, and complete (false when limit cut the list).',
  params: {
    pattern: { type: 'string', required: true, description: "Glob, slug prefix or name." },
    type: { type: 'string', description: 'Page type, or several comma-separated.' },
    types: { type: 'array', items: { type: 'string' }, description: "Page types, e.g. ['person']." },
    limit: { type: 'number', description: `Max rows (default ${FIND_PAGES_DEFAULT_LIMIT}; max ${FIND_PAGES_LOCAL_MAX_LIMIT}, remote ${FIND_PAGES_REMOTE_MAX_LIMIT}).` },
    source_id: { type: 'string', description: "One source, or '__all__'." },
  },
  handler: async (ctx, p) => {
    let pattern: FindPattern;
    try {
      pattern = parseFindPattern(typeof p.pattern === 'string' ? p.pattern : '');
    } catch {
      throw invalidParam(ctx, 'find_pages', 'pattern', `find_pages: pattern is required (e.g. ${paramUse(ctx, 'pattern', 'people/*acme*')}).`, { example: 'people/*acme*' });
    }
    const types = parseTypes(ctx, p);
    const sourceIdParam = parseSourceIdParam(p.source_id, 'find_pages', { allowAll: true });
    const scope = federatedSearchScope(ctx, sourceIdParam);
    await assertExplicitSourceLive(ctx, sourceIdParam);
    const requested = typeof p.limit === 'number' ? p.limit : undefined;
    const cap = ctx.remote === false ? FIND_PAGES_LOCAL_MAX_LIMIT : FIND_PAGES_REMOTE_MAX_LIMIT;
    const limit = clampSearchLimit(requested, FIND_PAGES_DEFAULT_LIMIT, cap);
    const policy = ctx.remote === false ? undefined : await readPolicyOpts(ctx, scope);
    const hiddenPrefixes = hiddenPrefixesFor(pattern, resolveHardExcludes());
    const found = await ctx.engine.findPages({
      pattern,
      types,
      limit,
      ...scope,
      untrusted: policy && { excludePrivate: policy.excludePrivate, minTrust: policy.minTrust, suppressFlagged: policy.suppressFlagged },
      excludeSlugPrefixes: hiddenPrefixes,
    });
    return {
      pattern: p.pattern,
      match: pattern.kind,
      pages: found.rows,
      total: found.total,
      complete: found.total <= found.rows.length,
      limit,
      hidden_prefixes: hiddenPrefixes,
      ...(requested !== undefined && Number.isFinite(requested) && requested > limit ? { limit_clamped_from: requested } : {}),
    };
  },
  scope: 'read',
  cliHints: { name: 'find', positional: ['pattern'] },
};

export const findPagesOperations: Operation[] = [find_pages];
