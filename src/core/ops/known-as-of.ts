/**
 * W2 page-at-time on the op surface: `get_page {known_as_of}` and
 * `get_versions {known_as_of, diff}` (docs/designs/BELIEF_LEDGER.md section
 * 10). Recorded time, read from the belief ledger's publication events
 * (`belief/page-at-time.ts`); `as_of` elsewhere is valid time.
 */
import type { OperationContext, ParamDef } from './contract.ts';
import { opError } from './contract.ts';
import { assertExplicitSourceLive, federatedSearchScope, pageNotFoundError, parseSourceIdParam, readHolders } from './context.ts';
import { inlineBodyBytes } from './get-page-body.ts';
import { pageTrustForRead } from './get-page-projection.ts';
import { parseKnownAsOf, readPageAtTime, remoteMayRead, type PageAtTime, type PageInterval } from '../belief/page-at-time.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { unifiedDiff } from '../skillpack/diff-text.ts';
import { historicalEvidence, historyTakeRows } from '../belief/historical-search.ts';

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

/** search parameters that select a current-state ranking stage, cursor or evidence view, none of which the historical retriever serves. */
const SEARCH_UNSUPPORTED = ['cursor', 'offset', 'mode', 'types', 'return_unit', 'return_window', 'salience', 'recency', 'min_trust', 'token_budget'] as const;

/** The sources a recorded-time search reads: the explicit or ambient scope, else every source the caller may read (an uncovered one refuses). */
async function historicalScope(ctx: OperationContext, p: Record<string, unknown>, op: string): Promise<string[]> {
  const sourceIdParam = parseSourceIdParam(p.source_id, op, { allowAll: true });
  const scope = federatedSearchScope(ctx, sourceIdParam);
  await assertExplicitSourceLive(ctx, sourceIdParam);
  if (scope.sourceId) return [scope.sourceId];
  if (scope.sourceIds?.length) return [...scope.sourceIds];
  return (await ctx.engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id COLLATE "C"')).map(r => r.id);
}

const callerHolders = (ctx: OperationContext) => ctx.remote === false ? undefined : readHolders(ctx) ?? ['world'];

/**
 * `search {known_as_of}` (W2 second slice, historical-retrieval.md section 8): the historical retriever as a keyword
 * search, with think's refusals and disclosure. Lexical only; full surface only.
 */
export async function searchKnownAsOf(ctx: OperationContext, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  const at = parseKnownAsOf(p.known_as_of);
  const extra = SEARCH_UNSUPPORTED.filter(k => p[k] !== undefined);
  if (extra.length || (p.match !== undefined && p.match !== 'keyword')) {
    throw opError('invalid_params', `search: known_as_of does not combine with ${extra.length ? extra.join(', ') : `match: ${String(p.match)}`}.`,
      'A recorded-time search is lexical and unpaged: pass query, known_as_of and optionally source_id, limit, snippet_chars or match: "keyword".');
  }
  const limit = Math.max(1, Math.min(Number(p.limit ?? 20) || 20, 100));
  const query = String(p.query ?? '');
  const result = await historicalEvidence(ctx.engine, { query, at, sources: await historicalScope(ctx, p, 'search'), remote: ctx.remote !== false,
    holders: callerHolders(ctx), limit, takesLimit: 0 });
  const { selectRelevantExcerpt } = await import('../think/gather.ts');
  const snippet = typeof p.snippet_chars === 'number' && p.snippet_chars > 0 ? Math.floor(p.snippet_chars) : 600;
  return {
    known_as_of: result.known_as_of,
    results: result.pages.map(r => ({ slug: r.slug, source_id: r.source_id, title: r.title, type: r.type, score: r.score, revision: r.revision, recorded_at: r.recorded_at,
      content_date: r.content_date, trust_tier: r.trust_tier,
      chunk_text: selectRelevantExcerpt([r.compiled_truth, r.timeline].filter(t => t.trim().length > 0).join('\n\n'), query, snippet, `${r.title ?? ''} ${r.slug}`) })),
  };
}

/** takes_list parameters a body at T cannot answer. */
const TAKES_UNSUPPORTED = ['resolved', 'sort_by', 'offset', 'min_trust'] as const;

/**
 * `takes_list {known_as_of, page_slug}` (section 8): the take rows of that page's body at T, with W4's holder and
 * remote rule. Listing every take in the brain at T would mean reading every body, so page_slug is required.
 */
export async function takesListKnownAsOf(ctx: OperationContext, p: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const at = parseKnownAsOf(p.known_as_of);
  if (typeof p.page_slug !== 'string' || !p.page_slug) {
    throw opError('invalid_params', 'takes_list: known_as_of needs page_slug.', 'Name the page whose takes as recorded you want; listing every take in the brain at an instant is not supported.');
  }
  const extra = TAKES_UNSUPPORTED.filter(k => p[k] !== undefined);
  if (extra.length || p.active === false) {
    throw opError('invalid_params', `takes_list: known_as_of does not combine with ${extra.length ? extra.join(', ') : 'active: false'}.`,
      'List the active takes of the body at the instant with page_slug and known_as_of (plus holder, kind or limit).');
  }
  const slug = p.page_slug;
  const sourceId = await targetSource(ctx, { ...p, slug }, 'takes_list');
  const read = await readAsCaller(ctx, { sourceId, slug, at }, false);
  const current = read.current && (await readable(ctx, read, [read.current], undefined))[0];
  if (!current || current.deleted || !current.page) throw pageNotFoundError(ctx, slug, { includeDeleted: false, sourceIdParam: sourceId });
  const rows = await historyTakeRows(ctx.engine, { sourceId, interval: current, at, remote: ctx.remote !== false, holders: callerHolders(ctx) });
  const limit = Math.max(1, Math.min(Number(p.limit ?? 100) || 100, 500));
  return rows.filter(t => (p.holder === undefined || t.holder === p.holder) && (p.kind === undefined || t.kind === p.kind)).slice(0, limit)
    .map(t => ({ page_slug: current.slug, source_id: sourceId, row_num: t.row_num, take_key: t.take_key, claim: t.claim, kind: t.kind, holder: t.holder, weight: t.weight,
      since_date: t.since_date, revision: current.revision, recorded_at: current.event.recorded_at, known_as_of: read.known_as_of, certified: read.certified }));
}
