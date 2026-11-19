/**
 * GBRA-650: `get_page` with `slugs` reads several pages in one call.
 *
 * Each slug is read by the single-page read, in request order; an identical slug string is read once and repeats its
 * entry. A page the caller cannot read (missing, soft-deleted, private, kept to other members, outside the grant,
 * below the trust floor) throws page_not_found there, and its entry carries that error exactly as the transport renders
 * it for a single read, minus the per-call envelope keys, so a hidden page and a missing one give identical entries.
 * Any other failure (a database error, an ambiguous snapshot, a timeout, a missing engine capability) fails the call.
 *
 * Entries are `{requested_slug, page}` or `{requested_slug, error, message, suggestion, fix, ...}`. The key is not
 * `slug`, so the guest stamp and the room marker, which read every object naming a slug, only ever see pages.
 * Remote callers get lean pages (resultRowsFor); `fields: "full"` and trusted local callers get the whole result.
 * `token_budget` is shared fairly (D1): each delivered entry gets an equal share, and what a short entry leaves goes to
 * the longer ones. A page longer than its share comes back as the single read's window from its start, with the page
 * outline and `next` to read on (`auto_reason: 'batch_share'`), so one long page never fills the batch. Slugs past
 * what a minimum share can hold, or past the connection's egress cap, go to `omitted` with a `next` call; the first
 * remaining entry is always delivered, so every `next` makes progress.
 */

import { OperationError, opError, type OperationContext, type ParamDef } from './contract.ts';
import { ENVELOPE_RESERVE_BYTES, GET_PAGE_BODY_PARAMS } from './get-page-body.ts';
import { invalidParam } from './op-fix.ts';
import { keepRoomBody, roomBodyOf } from '../access/page-items.ts';
import { resultRowsFor } from '../search/lean-rows.ts';
import { estimateTokens } from '../search/token-budget.ts';
import { encodedFrameBytes, FRAME_RESERVE_BYTES, resultByteCap } from '../egress-budget.ts';
import { cliRenderContext, toAgentError } from '../agent-output.ts';

export const GET_PAGE_BATCH_MAX = 50;
export const BATCH_READ_TOKEN_BUDGET_KEY = 'mcp.batch_read_token_budget';
export const DEFAULT_BATCH_READ_TOKEN_BUDGET = 12_000;
export const REMOTE_BATCH_READ_TOKEN_BUDGET_MAX = 32_000;
/** The smallest share a cut page gets: room for its metadata, outline and a first window worth reading. */
export const MIN_BATCH_SHARE_TOKENS = 800;
const MIN_WINDOW_BYTES = 512;

const REFUSED_IN_BATCH = ['fuzzy', 'as_of', 'known_as_of', ...Object.keys(GET_PAGE_BODY_PARAMS)];
const CARRIED_TO_NEXT = ['include_content', 'content_only', 'include_deleted', 'include_timeline_entries', 'grammar_diagnostics', 'include_quarantined', 'source_id', 'min_trust', 'fields', 'token_budget'];
const ENVELOPE_ONLY = new Set(['contract_version', 'notices']);
/** Keys a lean entry drops: storage bookkeeping and the raw frontmatter. Every marker and body field stays. */
const LEAN_DROPPED = new Set(['id', 'frontmatter', 'content_hash', 'body_bytes', 'source_path', 'knowledge_revision', 'text_projection_revision',
  'emotional_weight', 'created_at', 'updated_at', 'updated_at_iso', 'effective_date_source', 'chars', 'tags', 'search_vector', 'last_retrieved_at']);

type Entry = { requested_slug: string; page: Record<string, unknown> } | ({ requested_slug: string } & Record<string, unknown>);

/** True for a batch reply whose every delivered entry is a miss: MCP returns it as an error, as it does one missed read. */
export function isAllMissingPageBatch(result: unknown): boolean {
  const pages = (result as { pages?: unknown } | null)?.pages;
  return Array.isArray(pages) && pages.length > 0 && pages.every(e => typeof e === 'object' && e !== null && 'requested_slug' in e && !('page' in e));
}

async function batchTokenBudget(ctx: OperationContext, raw: unknown): Promise<number> {
  if (raw !== undefined && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1)) {
    throw invalidParam(ctx, 'get_page', 'token_budget', `token_budget must be a positive number of tokens (got ${JSON.stringify(raw)}).`, { example: DEFAULT_BATCH_READ_TOKEN_BUDGET });
  }
  let budget = raw as number | undefined;
  if (budget === undefined && ctx.remote === false) return Number.POSITIVE_INFINITY;
  if (budget === undefined) {
    try { const n = Number(await ctx.engine.getConfig(BATCH_READ_TOKEN_BUDGET_KEY)); if (Number.isFinite(n) && n > 0) budget = n; } catch { /* the file plane, then the default */ }
  }
  if (budget === undefined) {
    const file = Number((ctx.config?.mcp as Record<string, unknown> | undefined)?.batch_read_token_budget);
    budget = Number.isFinite(file) && file > 0 ? file : DEFAULT_BATCH_READ_TOKEN_BUDGET;
  }
  budget = Math.floor(budget);
  return ctx.remote === false ? budget : Math.min(budget, REMOTE_BATCH_READ_TOKEN_BUDGET_MAX);
}

function parseSlugs(ctx: OperationContext, p: Record<string, unknown>): string[] {
  const example = { slugs: ['people/alice-example', 'companies/acme-example'] };
  if (p.slug !== undefined) throw invalidParam(ctx, 'get_page', 'slugs', 'Pass either slug or slugs, not both.', { example: example.slugs });
  const raw = p.slugs;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(s => typeof s === 'string' && s !== '')) {
    throw invalidParam(ctx, 'get_page', 'slugs', 'slugs must be a non-empty array of page slugs.', { example: example.slugs });
  }
  if (raw.length > GET_PAGE_BATCH_MAX) {
    throw invalidParam(ctx, 'get_page', 'slugs', `slugs takes at most ${GET_PAGE_BATCH_MAX} pages per call (got ${raw.length}); split the list across calls.`, { example: example.slugs });
  }
  const refused = REFUSED_IN_BATCH.filter(k => p[k] !== undefined);
  if (refused.length) {
    throw opError('invalid_params', `get_page with slugs does not take ${refused.join(', ')}.`,
      `Read each page whole in the batch, then read a part of one page with a single get_page call (slug plus ${refused[0]}).`);
  }
  return raw as string[];
}

function renderMiss(ctx: OperationContext, e: OperationError): Record<string, unknown> {
  const envelope = ctx.renderError?.(e, 'get_page')
    ?? toAgentError(e, { transport: 'cli', op: 'get_page', mutating: false, idempotent: true, outcome: 'failed', render: cliRenderContext() }) as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.entries(envelope).filter(([k]) => !ENVELOPE_ONLY.has(k)));
}

function leanPage(page: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(page)) {
    if (v === undefined || (v === null && k !== 'effective_date') || LEAN_DROPPED.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function isMiss(e: unknown): e is OperationError {
  return e instanceof OperationError && (e.canonical ?? e.code) === 'page_not_found';
}

export const GET_PAGE_BATCH_PARAMS: Record<string, ParamDef> = {
  slugs: { type: 'array', items: { type: 'string' }, description: 'Up to 50, instead of slug.' },
  token_budget: { type: 'number', description: 'With slugs: token cap (12000).', fullSurfaceOnly: true },
  fields: { type: 'string', enum: ['lean', 'full'], description: 'With slugs: full keeps every page field.', fullSurfaceOnly: true },
};

type ReadOne = (ctx: OperationContext, p: Record<string, unknown>) => Promise<unknown>;

/** get_page's handler: a batch with \`slugs\`, else the single read, which needs \`slug\`. */
export function getPageOrPages(ctx: OperationContext, p: Record<string, unknown>, readOne: ReadOne): Promise<unknown> {
  if (p.slugs !== undefined) return getPagesBatch(ctx, p, readOne);
  if (typeof p.slug !== 'string' || p.slug === '') throw invalidParam(ctx, 'get_page', 'slug', 'get_page needs slug (one page) or slugs (several).', { example: 'people/alice-example' });
  return readOne(ctx, p);
}

async function getPagesBatch(ctx: OperationContext, p: Record<string, unknown>, readOne: ReadOne): Promise<Record<string, unknown>> {
  const slugs = parseSlugs(ctx, p);
  const budget = await batchTokenBudget(ctx, p.token_budget);
  const lean = resultRowsFor(ctx, p.fields) === 'lean';
  const cap = await resultByteCap({ remote: ctx.remote, transport: ctx.transport, engine: ctx.engine, config: ctx.config });
  const { slugs: _slugs, token_budget: _budget, fields: _fields, ...shared } = p;
  const read = new Map<string, Entry>();
  for (const slug of slugs) {
    if (read.has(slug)) continue;
    try { read.set(slug, pageEntry(slug, await readOne(ctx, { ...shared, slug }) as Record<string, unknown>, lean)); }
    catch (e) {
      if (!isMiss(e)) throw e;
      read.set(slug, { requested_slug: slug, ...renderMiss(ctx, e) });
    }
  }
  let floor = 0;
  const over = Number.isFinite(budget) ? slugs.findIndex(slug => (floor += Math.min(tokensOf(read.get(slug)!), MIN_BATCH_SHARE_TOKENS)) > budget) : -1;
  const admitted = over < 0 ? slugs : slugs.slice(0, Math.max(1, over));
  const cut = new Set<string>();
  if (Number.isFinite(budget)) {
    const share = fairShare(admitted.map(slug => tokensOf(read.get(slug)!)), budget);
    const long = admitted.filter(slug => 'page' in read.get(slug)! && tokensOf(read.get(slug)!) > share);
    let left = budget - admitted.filter(slug => !long.includes(slug)).reduce((n, slug) => n + tokensOf(read.get(slug)!), 0);
    const order = [...new Set(long)].sort((a, b) => tokensOf(read.get(a)!) - tokensOf(read.get(b)!));
    let waiting = long.length;
    for (const slug of order) {
      const times = long.filter(s => s === slug).length;
      read.set(slug, await cutEntry(ctx, readOne, shared, slug, Math.max(MIN_BATCH_SHARE_TOKENS, Math.floor(left / waiting)), lean));
      cut.add(slug);
      left -= tokensOf(read.get(slug)!) * times;
      waiting -= times;
    }
  }
  const pages: Entry[] = [];
  let stop: { at: number; reason: 'token_budget' | 'egress_cap' } | null = admitted.length < slugs.length ? { at: admitted.length, reason: 'token_budget' } : null;
  for (let i = 0; i < admitted.length; i++) {
    const entry = read.get(admitted[i]!)!;
    if (pages.length > 0 && Number.isFinite(cap)
      && encodedFrameBytes({ content: [{ type: 'text', text: JSON.stringify({ pages: [...pages, entry] }) }] }) + ENVELOPE_RESERVE_BYTES - FRAME_RESERVE_BYTES > cap) {
      stop = { at: i, reason: 'egress_cap' };
      break;
    }
    pages.push(entry);
  }
  const missing = pages.filter(e => !('page' in e)).map(e => e.requested_slug);
  const shortened = pages.filter(e => cut.has(e.requested_slug)).length;
  const rest = stop ? slugs.slice(stop.at) : [];
  const carried = Object.fromEntries(CARRIED_TO_NEXT.filter(k => p[k] !== undefined).map(k => [k, p[k]]));
  const omitted = stop ? { slugs: rest, reason: stop.reason, ...(Number.isFinite(budget) ? { token_budget: budget } : {}), next: { tool: 'get_page', args: { ...carried, slugs: rest } } } : undefined;
  const summary = missing.length || omitted || shortened
    ? [`${pages.length - missing.length} of ${slugs.length} pages read`,
        ...(shortened ? [`${shortened} cut to fit ${budget} tokens; read on with each page's next`] : []),
        ...(missing.length ? [`${missing.length} not found: ${missing.join(', ')}`] : []),
        ...(omitted ? [`${rest.length} left for omitted.next (${stop!.reason})`] : [])].join('; ') + '.'
    : undefined;
  return { ...(summary ? { summary } : {}), pages, ...(omitted ? { omitted } : {}) };
}

const tokensOf = (entry: Entry) => estimateTokens(JSON.stringify(entry));

function pageEntry(slug: string, result: Record<string, unknown>, lean: boolean): Entry {
  const strips = roomBodyOf(result);
  const shown = lean ? leanPage(result) : { ...result };
  return { requested_slug: slug, page: strips ? keepRoomBody(shown, strips) : shown };
}

/** The per-entry share: entries under an equal split keep their size and the rest is split again among the longer ones. */
export function fairShare(costs: number[], budget: number): number {
  let left = budget;
  let count = costs.length;
  for (const cost of [...costs].sort((a, b) => a - b)) {
    if (cost > left / count) break;
    left -= cost;
    count--;
  }
  return count === 0 ? budget : Math.max(MIN_BATCH_SHARE_TOKENS, Math.floor(left / count));
}

/** A page longer than its share: the single read's first window plus the outline, shrunk until the entry fits the share. */
async function cutEntry(ctx: OperationContext, readOne: ReadOne, shared: Record<string, unknown>, slug: string, share: number, lean: boolean): Promise<Entry> {
  const outline = (await readOne(ctx, { ...shared, slug, body: 'outline' }) as Record<string, unknown>).outline as { entries?: Array<Record<string, unknown>> } | undefined;
  const brief = outline && { ...outline, entries: (outline.entries ?? []).map(({ byte_start: _s, byte_end: _e, ...rest }) => rest) };
  let maxBytes = Math.max(MIN_WINDOW_BYTES, share * 4);
  for (;;) {
    const window = await readOne(ctx, { ...shared, slug, body: 'window', max_bytes: maxBytes }) as Record<string, unknown>;
    const entry = pageEntry(slug, { ...window, ...(brief ? { outline: brief } : {}), truncated: true, auto_reason: 'batch_share' }, lean);
    const over = tokensOf(entry) - share;
    if (over <= 0 || maxBytes <= MIN_WINDOW_BYTES) return entry;
    maxBytes = Math.max(MIN_WINDOW_BYTES, maxBytes - over * 4 - 64);
  }
}
