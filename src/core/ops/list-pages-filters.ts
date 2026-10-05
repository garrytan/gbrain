/**
 * list_pages `updated_before` and `slug_prefix`. Each maps onto a PageFilters
 * field that engine-sql/pages.ts:listPages already reads, so it is one more
 * AND predicate beside source scope, the untrusted-caller private-page filter,
 * soft-delete visibility, type/tag and the updated_after bound or keyset.
 * Full MCP surface only: the starter tool list sits at its size budget.
 */
import type { PageFilters } from '../types.ts';
import type { OperationContext, ParamDef } from './contract.ts';
import { invalidParam } from './op-fix.ts';

export const LIST_PAGES_FILTER_PARAMS: Record<'updated_before' | 'slug_prefix', ParamDef> = {
  updated_before: { type: 'string', description: 'Only pages updated before this ISO time.', fullSurfaceOnly: true },
  slug_prefix: { type: 'string', description: "Literal slug prefix, e.g. 'people/'.", fullSurfaceOnly: true },
};

// What validateSlug refuses to store anywhere in a slug, plus a leading '/'.
const NEVER_IN_SLUG = /^\/|[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\\]/;

export function listPagesFilters(ctx: OperationContext, p: Record<string, unknown>): Pick<PageFilters, 'updated_before' | 'slugPrefix'> {
  // Raw string like updated_after: the engine casts ::text::timestamptz, keeping microsecond cursors exact.
  const updatedBefore = typeof p.updated_before === 'string' ? p.updated_before : undefined;
  const raw = p.slug_prefix;
  if (raw === undefined || raw === null) return { updated_before: updatedBefore };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 255 || NEVER_IN_SLUG.test(raw)) {
    throw invalidParam(ctx, 'list_pages', 'slug_prefix',
      `list_pages: slug_prefix ${JSON.stringify(String(raw).slice(0, 60))} cannot start any slug (1-255 characters; no leading '/', backslash or control characters).`,
      { def: LIST_PAGES_FILTER_PARAMS.slug_prefix, example: 'people/' });
  }
  // Slugs are stored lowercased (validateSlug), so match the canonical form. The engine escapes LIKE metacharacters.
  return { updated_before: updatedBefore, slugPrefix: raw.toLowerCase() };
}

/**
 * Postgres parses updated_after / updated_before (so both accept exactly what
 * a timestamptz accepts); one it cannot parse (SQLSTATE 22007 / 22008) is the
 * caller's mistake, reported as invalid_params rather than internal_error.
 */
export function rethrowUnparsedTimestamp(ctx: OperationContext, p: Record<string, unknown>, err: unknown): never {
  const code = (err as { code?: unknown } | null)?.code;
  const given = (['updated_after', 'updated_before'] as const).filter(k => typeof p[k] === 'string');
  if ((code !== '22007' && code !== '22008') || given.length === 0) throw err;
  const param = given.find(k => Number.isNaN(Date.parse(p[k] as string))) ?? given[0];
  throw invalidParam(ctx, 'list_pages', param,
    `list_pages: ${param} ${JSON.stringify((p[param] as string).slice(0, 60))} is not a date or timestamp.`,
    { def: { type: 'string', description: 'ISO date or timestamp' }, example: '2026-08-11T00:00:00Z' });
}
