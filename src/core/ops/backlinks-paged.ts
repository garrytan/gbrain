/**
 * get_backlinks' entity-recall parameters (`type`, `group`). Without
 * `group` the op returns `Link[]` rows paged by `limit` / `cursor`
 * (ops/links.ts readLinkEdges, ops/link-paging.ts). `type` filters by the referring page's type
 * in both modes (a pack-canonical type, or any stored type observed on a
 * referrer; `untyped` for untyped pages). `group: "page"` returns
 * `{rows, total, truncated, cursor, coverage}`: one row per referring page,
 * newest first by `(date DESC, source_id, slug)`, read through the same
 * helper as the entity card's `referenced_by`, so a card group's `next` call
 * continues it exactly.
 */

import { opError, type OperationContext } from './contract.ts';
import type { Link, PageReadPolicy } from '../types.ts';
import { canonicalTypeOf, loadSourcePack, typeAliasPairs } from '../mentions/policy.ts';
import type { LinkReadPage } from '../link-validity.ts';
import {
  canonicalRecordTypes, decodeCursor, readPageStatusByRef, readReferrerPage, referrerTypes, PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT, type ReferenceRow, type ReferrerScope,
} from '../mentions/referrers.ts';
import { mentionCoverageNotice, readMentionCoverage, type MentionCoverage } from '../mentions/coverage.ts';
import { readEntityReferencesConfig, readRowPageStatus } from '../entity-references-config.ts';

export interface BacklinkPage {
  rows: ReferenceRow[];
  total: number;
  truncated: boolean;
  cursor: string | null;
  coverage: MentionCoverage;
}

function parseLimit(p: Record<string, unknown>, fallback: number | undefined): number | undefined {
  if (p.limit === undefined) return fallback;
  const n = typeof p.limit === 'string' ? Number(p.limit) : p.limit;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > PAGE_MAX_LIMIT) {
    throw opError('invalid_params', `get_backlinks: limit must be an integer from 1 to ${PAGE_MAX_LIMIT}.`,
      `Pass limit between 1 and ${PAGE_MAX_LIMIT}; page through the rest with group: "page" and the returned cursor.`);
  }
  return n;
}

async function scopeSources(ctx: OperationContext, policy: PageReadPolicy): Promise<string[]> {
  if (policy.sourceIds?.length) return policy.sourceIds;
  if (policy.sourceId) return [policy.sourceId];
  return (await ctx.engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id')).map(r => r.id);
}

/** The entity page's source: the first source in scope holding a live page with this slug. */
async function targetSource(ctx: OperationContext, slug: string, sources: string[]): Promise<string | null> {
  const rows = await ctx.engine.executeRaw<{ source_id: string }>(
    'SELECT source_id FROM pages WHERE slug = $1 AND source_id = ANY($2::text[]) AND deleted_at IS NULL', [slug, sources]);
  const found = new Set(rows.map(r => r.source_id));
  return sources.find(s => found.has(s)) ?? null;
}

async function referrerScope(ctx: OperationContext, slug: string, policy: PageReadPolicy): Promise<{ scope: ReferrerScope; sources: string[] } | null> {
  const sources = await scopeSources(ctx, policy);
  const sourceId = await targetSource(ctx, slug, sources);
  if (!sourceId) return null;
  const pack = await loadSourcePack(ctx.engine, sourceId);
  const excludePrivate = policy.excludePrivate === true;
  return { sources, scope: { slug, sourceId, referrerSources: sources, excludePrivate, pack, keepVisibility: excludePrivate ? ['world'] : ['private', 'world'] } };
}

async function assertKnownType(ctx: OperationContext, scope: ReferrerScope, type: string): Promise<void> {
  const declared = (scope.pack?.page_types ?? []).flatMap(pt => [pt.name, ...(pt.aliases ?? [])]);
  if (declared.includes(type) || type === 'untyped') return;
  const observed = await referrerTypes(ctx.engine, scope);
  if (observed.includes(type)) return;
  const canonical = (scope.pack?.page_types ?? []).map(pt => pt.name);
  const valid = [...new Set([...observed, ...canonical, 'untyped'])].sort();
  throw opError('invalid_params', `get_backlinks: unknown type "${type}".`,
    `Use a type this page's referrers have (${observed.join(', ') || 'none yet'}), a schema-pack type or untyped; valid values: ${valid.join(', ')}.`,
    { detail: JSON.stringify({ valid_types: valid, referrer_types: observed }) });
}

/**
 * `group: "page"`: one page of referring pages. A slug with no live page in
 * scope answers like an empty read (no rows, total 0).
 */
export async function readBacklinkPage(ctx: OperationContext, p: Record<string, unknown>, policy: PageReadPolicy): Promise<BacklinkPage> {
  if (p.group !== 'page') {
    throw opError('invalid_params', `get_backlinks: group must be "page".`, 'Pass group: "page" for one row per referring page, or omit group for link rows.');
  }
  const limit = parseLimit(p, PAGE_DEFAULT_LIMIT)!;
  const cursor = p.cursor === undefined ? null : decodeCursor(String(p.cursor));
  if (p.cursor !== undefined && !cursor) {
    throw opError('invalid_params', 'get_backlinks: cursor is not one this tool returned.', 'Pass the cursor from the previous get_backlinks response unchanged, or omit it to start from the newest page.');
  }
  const resolved = await referrerScope(ctx, String(p.slug), policy);
  const coverage = await readMentionCoverage(ctx.engine, resolved?.sources ?? await scopeSources(ctx, policy));
  const notice = mentionCoverageNotice(coverage);
  if (notice) ctx.emitNotice?.(notice);
  if (!resolved) return { rows: [], total: 0, truncated: false, cursor: null, coverage };
  const type = typeof p.type === 'string' && p.type ? p.type : undefined;
  if (type) await assertKnownType(ctx, resolved.scope, type);
  // F1: a record type's continuation rows carry the same record metadata as the record view (membership unchanged).
  const recordMetadata = type !== undefined && canonicalRecordTypes((await readEntityReferencesConfig(ctx.engine)).recordTypes, resolved.scope.pack)
    .includes(canonicalTypeOf(type, resolved.scope.pack));
  const pageStatus = !recordMetadata && await readRowPageStatus(ctx.engine);
  return { ...await readReferrerPage(ctx.engine, resolved.scope, { type, limit, cursor, recordMetadata, pageStatus }), coverage };
}

/**
 * F3 (`entity.row_page_status`, default on): each link row carries its
 * referring page's frontmatter `status` as `page_status` when set. The link's
 * own `status` (the relationship's temporal state) and the `status` input
 * filter are unchanged.
 */
export async function withLinkPageStatus(ctx: OperationContext, policy: () => Promise<PageReadPolicy>, links: Link[]): Promise<Array<Link & { page_status?: string }>> {
  if (!links.length || !(await readRowPageStatus(ctx.engine))) return links;
  const excludePrivate = (await policy()).excludePrivate === true;
  const status = await readPageStatusByRef(ctx.engine, links.map(l => ({ source_id: l.from_source_id, slug: l.from_slug })), { excludePrivate })
    .catch(() => new Map<string, string>());
  return links.map(l => {
    const value = status.get(`${l.from_source_id}:${l.from_slug}`);
    return value ? { ...l, page_status: value } : l;
  });
}

/**
 * Array mode with `type`: the referring-page type filter for the keyset page
 * SQL (ops/links.ts, #6876), so LIMIT counts only rows of that type. A row is
 * kept when its referrer's stored type is `type` (`untyped` for none) or a
 * stored alias its own source's pack maps to `type`.
 */
export async function backlinkTypeFilter(ctx: OperationContext, p: Record<string, unknown>, policy: PageReadPolicy): Promise<LinkReadPage['fromType']> {
  const type = typeof p.type === 'string' && p.type ? p.type : undefined;
  if (!type) return undefined;
  const resolved = await referrerScope(ctx, String(p.slug), policy);
  if (resolved) await assertKnownType(ctx, resolved.scope, type);
  const aliasSources: string[] = [];
  const aliases: string[] = [];
  for (const { id } of await ctx.engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id')) {
    const pairs = typeAliasPairs(await loadSourcePack(ctx.engine, id));
    pairs.stored.forEach((stored, i) => {
      if (pairs.canonical[i] !== type) return;
      aliasSources.push(id);
      aliases.push(stored);
    });
  }
  return { type, aliasSources, aliases };
}
