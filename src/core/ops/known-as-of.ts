/**
 * W2 page-at-time on the op surface: `get_page {known_as_of}` and
 * `get_versions {known_as_of, diff}` (docs/designs/BELIEF_LEDGER.md section
 * 10). Recorded time, read from the belief ledger's publication events
 * (`belief/page-at-time.ts`); `as_of` elsewhere is valid time.
 */
import type { OperationContext, ParamDef } from './contract.ts';
import { opError } from './contract.ts';
import { assertExplicitSourceLive, federatedSearchScope, pageNotFoundError, parseSourceIdParam } from './context.ts';
import { inlineBodyBytes } from './get-page-body.ts';
import { pageTrustForRead } from './get-page-projection.ts';
import { parseKnownAsOf, readPageAtTime, remoteMayRead, type PageAtTime, type PageInterval } from '../belief/page-at-time.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { unifiedDiff } from '../skillpack/diff-text.ts';

export const KNOWN_AS_OF_PARAM: ParamDef = { type: 'string', fullSurfaceOnly: true,
  description: 'Recorded time: the page as this brain had recorded it at this ISO 8601 instant (2026-10-01T12:00:00Z), from the belief ledger. Not as_of, which is valid time (a date).' };
export const VERSIONS_DIFF_PARAM: ParamDef = { type: 'boolean', fullSurfaceOnly: true, description: 'With known_as_of: each version also carries a unified diff from the version before it.' };

/** get_page parameters that select a body window, a fuzzy match or an edit view, none of which a historical read serves. */
const GET_PAGE_UNSUPPORTED = ['fuzzy', 'include_content', 'content_only', 'include_timeline_entries', 'grammar_diagnostics', 'include_quarantined',
  'lines', 'bytes', 'around_chunk_id', 'context_lines', 'cursor', 'max_bytes', 'view', 'outline_from'] as const;

/**
 * The one source a recorded-time read targets: the explicit or ambient source, else the only granted source whose
 * ledger names the slug. A remote caller's search counts only world-visible events of a page it can see now, and
 * finding none across several sources is `page_not_found`, so which source is picked never reveals a private page.
 */
async function targetSource(ctx: OperationContext, p: Record<string, unknown>, op: string): Promise<string> {
  const sourceIdParam = parseSourceIdParam(p.source_id, op, { allowAll: true });
  const scope = federatedSearchScope(ctx, sourceIdParam);
  await assertExplicitSourceLive(ctx, sourceIdParam);
  if (scope.sourceId) return scope.sourceId;
  const visible = ctx.remote === false ? '' : `AND e.visibility = 'world' AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = e.source_id AND p.slug = e.slug
      AND p.deleted_at IS NULL AND ${privatePagesFilterFragment('p')})`;
  const rows = await ctx.engine.executeRaw<{ source_id: string }>(`SELECT DISTINCT e.source_id FROM belief_events e
    JOIN sources s ON s.id = e.source_id AND s.incarnation = e.source_incarnation
    WHERE e.slug = $1 AND e.subject_kind = 'page' AND ($2::text[] IS NULL OR e.source_id = ANY($2::text[])) ${visible} ORDER BY e.source_id`, [p.slug, scope.sourceIds ?? null]);
  if (rows.length === 1) return rows[0]!.source_id;
  if (rows.length > 1) {
    throw opError('invalid_params', `${op}: ${String(p.slug)} has recorded history in several sources (${rows.map(r => r.source_id).join(', ')}).`, 'Pass source_id to name one.');
  }
  if (scope.sourceIds?.length === 1) return scope.sourceIds[0]!;
  if (ctx.remote !== false) throw pageNotFoundError(ctx, String(p.slug), { includeDeleted: p.include_deleted === true });
  return 'default';
}

const PAGE_REFUSALS = new Set(['coverage_from', 'coverage_gap', 'known_as_of_unproven']);

/** Reads the page as recorded; a remote caller that cannot see the page now gets `page_not_found` instead of a coverage or proof refusal about it. */
async function readAsCaller(ctx: OperationContext, q: Parameters<typeof readPageAtTime>[1], includeDeleted: boolean): Promise<PageAtTime> {
  try {
    return await readPageAtTime(ctx.engine, q);
  } catch (error) {
    if (ctx.remote === false || !PAGE_REFUSALS.has(String((error as { code?: unknown }).code))) throw error;
    const [row] = await ctx.engine.executeRaw<{ visible: boolean }>(`SELECT ${privatePagesFilterFragment('p')} AS visible FROM pages p
      WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`, [q.sourceId, q.slug]);
    if (row?.visible === true) throw error;
    throw pageNotFoundError(ctx, q.slug, { includeDeleted, sourceIdParam: q.sourceId });
  }
}

/** Readable intervals: a remote caller sees an interval only under the ledger's visibility rule and the page's current trust floor. */
async function readable(ctx: OperationContext, read: PageAtTime, intervals: PageInterval[], minTrust: unknown): Promise<PageInterval[]> {
  if (ctx.remote === false) return intervals;
  if (read.page_id == null || !(await pageTrustForRead(ctx, { id: read.page_id }, minTrust))) return [];
  const out: PageInterval[] = [];
  for (const i of intervals) if (await remoteMayRead(ctx.engine, read.page_id, i)) out.push(i);
  return out;
}

function intervalView(ctx: OperationContext, i: PageInterval, opts: { body: boolean; inlineMax: number }) {
  const meta = { slug: i.slug, revision: i.revision, deleted: i.deleted, recorded_at: i.event.recorded_at, visible_at: i.event.visible_at, until: i.until,
    source_time: i.event.source_time, event: i.event.type, event_id: i.event.id, origin: i.event.origin, body: i.body,
    ...(i.body_reason ? { body_reason: i.body_reason } : {}), ...(i.version_id != null ? { version_id: i.version_id } : {}),
    ...(i.page ? { title: i.page.title, type: i.page.type, tags: i.page.tags, frontmatter: i.page.frontmatter } : {}) };
  if (!opts.body || !i.page) return meta;
  const bytes = i.page.body_bytes ?? 0;
  if (i.body === 'segmented' || bytes > opts.inlineMax) {
    return { ...meta, body_ref: { total_bytes: bytes, ...(i.version_id != null ? { read: { tool: 'get_page', arguments: { slug: i.slug, version_id: i.version_id, body: 'window' } } } : {}) } };
  }
  const clean = (s: string | null) => s == null ? null : ctx.remote === false ? s : sanitizeRemoteBody(s, { includeWithdrawn: true, keepMaterializedMarkers: true });
  return { ...meta, compiled_truth: clean(i.page.compiled_truth), timeline: clean(i.page.timeline) };
}

function ledgerView(read: PageAtTime) {
  return { known_as_of: read.known_as_of, source_id: read.source_id, certified: read.certified, uncertified_reason: read.uncertified_reason, coverage_from: read.coverage_cut };
}

/** `get_page {known_as_of}`: the page at the slug as recorded at the instant, with the interval it was in and whether the ledger certifies it. */
export async function getPageKnownAsOf(ctx: OperationContext, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  const at = parseKnownAsOf(p.known_as_of);
  const extra = GET_PAGE_UNSUPPORTED.filter(k => p[k] !== undefined && p[k] !== false);
  if (extra.length || (p.body !== undefined && p.body !== 'auto' && p.body !== 'full' && p.body !== 'none')) {
    throw opError('invalid_params', `get_page: known_as_of does not combine with ${extra.length ? extra.join(', ') : `body: ${String(p.body)}`}.`,
      'Read the page as recorded with known_as_of alone (plus source_id, include_deleted or body: "none"), or drop known_as_of for the current page.');
  }
  const slug = String(p.slug);
  const sourceId = await targetSource(ctx, p, 'get_page');
  const read = await readAsCaller(ctx, { sourceId, slug, at }, p.include_deleted === true);
  const current = read.current && (await readable(ctx, read, [read.current], p.min_trust))[0];
  if (!current || (current.deleted && p.include_deleted !== true)) throw pageNotFoundError(ctx, slug, { includeDeleted: p.include_deleted === true, sourceIdParam: sourceId });
  return { ...intervalView(ctx, current, { body: p.body !== 'none', inlineMax: await inlineBodyBytes(ctx) }), ...ledgerView(read) };
}

/** `get_versions {known_as_of}`: the page's validity intervals known at the instant, newest first; `diff` adds each one's change from the one before it. */
export async function getVersionsKnownAsOf(ctx: OperationContext, p: Record<string, unknown>, limit: number): Promise<Record<string, unknown>> {
  const at = parseKnownAsOf(p.known_as_of);
  const slug = String(p.slug);
  const sourceId = await targetSource(ctx, p, 'get_versions');
  const wantBody = p.include_body === true;
  const read = await readAsCaller(ctx, { sourceId, slug, at, history: true, withBodies: wantBody || p.diff === true }, true);
  const intervals = await readable(ctx, read, read.intervals, p.min_trust);
  if (!intervals.length) throw pageNotFoundError(ctx, slug, { includeDeleted: true, sourceIdParam: sourceId });
  const inlineMax = await inlineBodyBytes(ctx);
  const views = intervals.map((i, n) => {
    const view: Record<string, unknown> = intervalView(ctx, i, { body: wantBody, inlineMax });
    if (p.diff !== true) return view;
    const prev = intervals.slice(0, n).reverse().find(x => x.lifetime === i.lifetime);
    const text = (x: PageInterval | undefined) => x?.page && x.body !== 'segmented' ? `${x.page.compiled_truth ?? ''}${x.page.timeline ? `\n${x.page.timeline}` : ''}` : null;
    const [a, b] = [prev ? text(prev) : '', text(i)];
    view.diff = a == null || b == null ? null : unifiedDiff(ctx.remote === false ? a : sanitizeRemoteBody(a), ctx.remote === false ? b : sanitizeRemoteBody(b),
      { oldPath: prev ? `${slug}@${prev.event.recorded_at}` : '/dev/null', newPath: `${slug}@${i.event.recorded_at}` });
    return view;
  });
  const newest = views.reverse();
  return { slug, ...ledgerView(read), truncated: newest.length > limit, versions: newest.slice(0, limit) };
}
