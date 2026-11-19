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
 * Reading stops at the first entry past `token_budget` or the connection's egress cap; it and every later slug go to
 * `omitted` with a `next` call. The first remaining entry is always delivered, so every `next` makes progress.
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
  const pages: Entry[] = [];
  let used = 0;
  let stop: { at: number; reason: 'token_budget' | 'egress_cap' } | null = null;
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i]!;
    let entry = read.get(slug);
    if (!entry) {
      try {
        const result = await readOne(ctx, { ...shared, slug }) as Record<string, unknown>;
        const strips = roomBodyOf(result);
        const shown = lean ? leanPage(result) : { ...result };
        entry = { requested_slug: slug, page: strips ? keepRoomBody(shown, strips) : shown };
      } catch (e) {
        if (!isMiss(e)) throw e;
        entry = { requested_slug: slug, ...renderMiss(ctx, e) };
      }
      read.set(slug, entry);
    }
    const tokens = estimateTokens(JSON.stringify(entry));
    if (pages.length > 0 && used + tokens > budget) { stop = { at: i, reason: 'token_budget' }; break; }
    if (pages.length > 0 && Number.isFinite(cap)
      && encodedFrameBytes({ content: [{ type: 'text', text: JSON.stringify({ pages: [...pages, entry] }) }] }) + ENVELOPE_RESERVE_BYTES - FRAME_RESERVE_BYTES > cap) {
      stop = { at: i, reason: 'egress_cap' };
      break;
    }
    pages.push(entry);
    used += tokens;
  }
  const missing = pages.filter(e => !('page' in e)).map(e => e.requested_slug);
  const rest = stop ? slugs.slice(stop.at) : [];
  const carried = Object.fromEntries(CARRIED_TO_NEXT.filter(k => p[k] !== undefined).map(k => [k, p[k]]));
  const omitted = stop ? { slugs: rest, reason: stop.reason, ...(Number.isFinite(budget) ? { token_budget: budget } : {}), next: { tool: 'get_page', args: { ...carried, slugs: rest } } } : undefined;
  const summary = missing.length || omitted
    ? [`${pages.length - missing.length} of ${slugs.length} pages read`,
        ...(missing.length ? [`${missing.length} not found: ${missing.join(', ')}`] : []),
        ...(omitted ? [`${rest.length} left for omitted.next (${stop!.reason})`] : [])].join('; ') + '.'
    : undefined;
  return { ...(summary ? { summary } : {}), pages, ...(omitted ? { omitted } : {}) };
}
