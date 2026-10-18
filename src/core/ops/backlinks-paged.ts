/**
 * get_backlinks' entity-recall parameters (`type`, `group`, `limit`,
 * `cursor`). With none of them the op is today's bare `Link[]` read
 * (ops/links.ts readLinkEdges). `type` filters by the referring page's type
 * in both modes (a pack-canonical type, or any stored type observed on a
 * referrer; `untyped` for untyped pages). `group: "page"` returns
 * `{rows, total, truncated, cursor, coverage}`: one row per referring page,
 * newest first by `(date DESC, source_id, slug)`, read through the same
 * helper as the entity card's `referenced_by`, so a card group's `next` call
 * continues it exactly.
 */

import { opError, type OperationContext } from './contract.ts';
import type { Link, PageReadPolicy } from '../types.ts';
import type { Notice } from '../agent-output.ts';
import { canonicalTypeOf, loadSourcePack } from '../mentions/policy.ts';
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

/** True when the call uses any entity-recall parameter. */
export function wantsPagedBacklinks(p: Record<string, unknown>): boolean {
  return p.type !== undefined || p.group !== undefined || p.limit !== undefined || p.cursor !== undefined;
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
 * Array mode with `type` and/or `limit`: today's link rows, filtered by the
 * referring page's type and cut at `limit` (a cut is reported with a
 * `listing_truncated` notice naming the paged call).
 */
export async function filterBacklinkRows(ctx: OperationContext, p: Record<string, unknown>, policy: PageReadPolicy, links: Link[]): Promise<Link[]> {
  if (p.cursor !== undefined) {
    throw opError('invalid_params', 'get_backlinks: cursor needs group: "page".', 'Pass group: "page" with the cursor, or omit cursor.');
  }
  const limit = parseLimit(p, undefined);
  let rows = links;
  const type = typeof p.type === 'string' && p.type ? p.type : undefined;
  if (type) {
    const resolved = await referrerScope(ctx, String(p.slug), policy);
    if (resolved) await assertKnownType(ctx, resolved.scope, type);
    const keys = [...new Set(links.map(l => `${l.from_source_id}\0${l.from_slug}`))];
    const types = new Map((await ctx.engine.executeRaw<{ source_id: string; slug: string; type: string | null }>(
      `SELECT p.source_id, p.slug, p.type FROM pages p JOIN unnest($1::text[], $2::text[]) AS k(s, g) ON p.source_id = k.s AND p.slug = k.g`,
      [keys.map(k => k.split('\0')[0]), keys.map(k => k.split('\0')[1])])).map(r => [`${r.source_id}\0${r.slug}`, r.type]));
    const packs = new Map<string, Awaited<ReturnType<typeof loadSourcePack>>>();
    const filtered: Link[] = [];
    for (const l of links) {
      if (!packs.has(l.from_source_id)) packs.set(l.from_source_id, await loadSourcePack(ctx.engine, l.from_source_id));
      const stored = types.get(`${l.from_source_id}\0${l.from_slug}`) ?? null;
      if (stored === type || canonicalTypeOf(stored, packs.get(l.from_source_id) ?? null) === type) filtered.push(l);
    }
    rows = filtered;
  }
  if (limit !== undefined && rows.length > limit) {
    const notice: Notice = {
      code: 'listing_truncated', kind: 'info',
      why: `${rows.length} link rows match; ${limit} were returned. For one row per referring page with a cursor, use group: "page".`,
      fix: { mcp: { tool: 'get_backlinks', arguments: { slug: p.slug, ...(p.source_id !== undefined ? { source_id: p.source_id } : {}),
        ...(type ? { type } : {}), group: 'page', limit } }, consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Pages through every referring page, newest first, without dropping rows.' },
    };
    ctx.emitNotice?.(notice);
    rows = rows.slice(0, limit);
  }
  return rows;
}
