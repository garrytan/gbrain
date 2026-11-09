/**
 * Read and write handoff pages through the ordinary page write path.
 *
 * Writes go through `submitPageMutation` (the path `put_page` uses), so a
 * handoff page gets the same durable request, canonical file publication,
 * revision history, auto-linking and source/slug fences as any other page.
 * Every replacement names the revision it read: the page write path checks it
 * under the page lock, so of two writers that read the same revision exactly
 * one commits and the other gets `revision_conflict`. `mutateHandoffPage`
 * re-reads and re-applies on a conflict; a mutation that is only legal on
 * the state it read (claim_task) re-checks on the fresh read and refuses,
 * which is what makes a claim atomic.
 */
import type { OperationContext } from '../ops/contract.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { slugify } from '../entities/resolve.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import type { Page } from '../types.ts';
import { AGENT_PREFIX, DELEGATION_PREFIX, THREAD_PREFIX, handoffKindOf, type HandoffKind, type StoredPageFields } from './format.ts';

/** Revision refusals a re-read can resolve: a concurrent replace, or a concurrent create. */
const STALE_REVISION_CODES = new Set(['revision_conflict', 'revision_required']);
const MAX_ATTEMPTS = 8;

let clock: () => number = () => Date.now();
/** The handoff clock (lease expiry, heartbeats, timestamps). */
export function handoffNow(): Date {
  return new Date(clock());
}
/** Test seam: pin or advance the handoff clock; `null` restores the wall clock. */
export function __setHandoffClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

export interface StoredHandoffPage extends StoredPageFields {
  slug: string;
  sourceId: string;
  type: string;
  revision: string;
  updatedAt: Date;
}

/** Read one live page of the handoff source, or null. */
export async function readHandoffPage(ctx: OperationContext, sourceId: string, slug: string): Promise<StoredHandoffPage | null> {
  const snap = await ctx.engine.readPageSnapshot(slug, { sourceId });
  if (!snap || snap.page.deleted_at) return null;
  return { ...storedFields(snap.page, sourceId, snap.revision), tags: snap.tags };
}

/**
 * Handoff pages are written whole by the handoff ops, so they are inline by
 * construction; a segmented one (a thread grown past the segment threshold)
 * is refused with page_body_segmented rather than read as empty.
 */
function storedFields(page: Page, sourceId: string, revision: string): StoredHandoffPage {
  assertInlineBody(page, 'agent handoff');
  const timeline = page.timeline ?? '';
  return {
    slug: page.slug, sourceId, type: page.type, revision, title: page.title ?? '',
    frontmatter: page.frontmatter ?? {},
    body: timeline ? `${page.compiled_truth ?? ''}\n\n${timeline}` : page.compiled_truth ?? '',
    updatedAt: page.updated_at,
    tags: null,
  };
}

/** The page tags of one listed page (listings carry no tags). */
export async function loadTags(ctx: OperationContext, page: StoredHandoffPage): Promise<StoredHandoffPage> {
  return page.tags ? page : { ...page, tags: await ctx.engine.getTags(page.slug, { sourceId: page.sourceId }) };
}

/** Every live handoff page of one kind under its directory (threads/, delegations/, agents/); tags are not loaded. */
export async function listHandoffPages(ctx: OperationContext, sourceId: string, kind: Exclude<HandoffKind, 'routing'>, prefix: string): Promise<StoredHandoffPage[]> {
  const pages = await ctx.engine.listPages({ slugPrefix: prefix, sourceId, limit: 5000, sort: 'slug' });
  return pages.filter(p => !p.deleted_at && handoffKindOf(p) === kind).map(p => storedFields(p, sourceId, ''));
}

export interface MutationOutcome<T> {
  result: T;
  slug: string;
  revision: string | null;
  /** True when nothing changed and no write was submitted. */
  noop: boolean;
  /** Set when the write was accepted but has not published yet (`write_pending`). */
  pending?: Record<string, unknown>;
  dryRun?: boolean;
}

/**
 * Read-modify-write one page. `apply` gets the current page (null when absent)
 * and returns the new content plus a result, `null` for "nothing to change",
 * or throws to refuse. A revision refusal re-reads and calls `apply` again.
 */
export async function mutateHandoffPage<T>(
  ctx: OperationContext,
  sourceId: string,
  slug: string,
  apply: (current: StoredHandoffPage | null) => { content: string; result: T } | { noop: T },
): Promise<MutationOutcome<T>> {
  for (let attempt = 1; ; attempt++) {
    const current = await readHandoffPage(ctx, sourceId, slug);
    const planned = apply(current);
    if ('noop' in planned) return { result: planned.noop, slug, revision: current?.revision ?? null, noop: true };
    if (ctx.dryRun) return { result: planned.result, slug, revision: current?.revision ?? null, noop: false, dryRun: true };
    const written = await writeOnce(ctx, sourceId, slug, planned.content, current?.revision ?? null);
    if ('stale' in written) {
      if (attempt < MAX_ATTEMPTS) continue;
      throw written.stale;
    }
    const receipt = written.receipt;
    const committed = receipt.state === undefined || receipt.state === 'committed';
    return { result: planned.result, slug, revision: typeof receipt.revision === 'string' ? receipt.revision : null, noop: false,
      ...(committed ? {} : { pending: receipt }) };
  }
}

/**
 * One revision-checked page write. A stale revision (another writer committed
 * first, or created the page first) comes back as `stale` so the caller can
 * re-read and re-decide; every other refusal is thrown as is.
 */
async function writeOnce(ctx: OperationContext, sourceId: string, slug: string, content: string, expectedRevision: string | null):
  Promise<{ receipt: Record<string, unknown> } | { stale: OperationError }> {
  const { submitPageMutation } = await import('../persistence/page-mutations.ts');
  try {
    return { receipt: await submitPageMutation(ctx, { operation: 'put_page', params: {
      slug, content, source_id: sourceId, ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
    } }) };
  } catch (error) {
    if (error instanceof OperationError && STALE_REVISION_CODES.has(error.code)) return { stale: error };
    throw error;
  }
}

// ── identifiers ────────────────────────────────────────────────────────────

/** An agent name: lowercase slug form, 1-64 chars ("Grok Bot" → "grok-bot"). */
export function agentNameParam(raw: unknown, param: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw opError('invalid_params', `${param} is required.`, `Pass ${param} as an agent name, for example "claude" or "grok-bot".`);
  }
  const name = slugify(raw);
  if (!name || name.length > 64) {
    throw opError('invalid_params', `${param} must be an agent name of 1-64 letters, digits and hyphens.`, `Pass ${param} like "claude" or "grok-bot".`);
  }
  return name;
}

export function optionalAgentName(raw: unknown, param: string): string | null {
  return raw === undefined || raw === null || raw === '' ? null : agentNameParam(raw, param);
}

function prefixedSlug(raw: unknown, prefix: string, param: string, noun: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw opError('invalid_params', `${param} is required.`, `Pass ${param} as the ${noun} id (for example "${prefix}example" or "example").`);
  }
  const trimmed = raw.trim().replace(/\.md$/i, '');
  const tail = trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
  const id = tail.split('/').map(slugify).filter(Boolean).join('-');
  if (!id || id.length > 120) {
    throw opError('invalid_params', `${param} is not a valid ${noun} id.`, `Pass ${param} as the ${noun} id a previous call returned.`);
  }
  return `${prefix}${id}`;
}

export const threadSlugParam = (raw: unknown, param = 'thread_id') => prefixedSlug(raw, THREAD_PREFIX, param, 'thread');
export const taskSlugParam = (raw: unknown, param = 'task_id') => prefixedSlug(raw, DELEGATION_PREFIX, param, 'task');
export const agentSlug = (name: string) => `${AGENT_PREFIX}${name}`;

/** The id an agent passes back: the slug without its directory. */
export function handoffId(slug: string): string {
  return slug.slice(slug.indexOf('/') + 1);
}

/** Refuse to treat any other page as a handoff page of `kind`. */
export function assertHandoffType(page: StoredHandoffPage, kind: HandoffKind, noun: string): void {
  if (handoffKindOf(page) !== kind) {
    throw opError('invalid_params', `${page.slug} is a ${page.type || 'untyped'} page, not a ${noun}.`,
      `Pick another ${noun} id; handoff tools never rewrite a page that is not a ${noun}.`);
  }
}

export function notFound(noun: string, slug: string): OperationError {
  return opError('not_found', `No ${noun} ${handoffId(slug)} in this brain source.`,
    noun === 'thread' ? 'Find the thread with find_thread, or start one with log_turn and a title.' : `List open work with inbox, or check the ${noun} id.`);
}

// ── param helpers ──────────────────────────────────────────────────────────

export function stringParam(raw: unknown, param: string, opts: { required?: boolean; max?: number } = {}): string {
  if (raw === undefined || raw === null) {
    if (opts.required) throw opError('invalid_params', `${param} is required.`, `Pass ${param} as text.`);
    return '';
  }
  if (typeof raw !== 'string') throw opError('invalid_params', `${param} must be a string.`, `Pass ${param} as text.`);
  if (opts.required && !raw.trim()) throw opError('invalid_params', `${param} must not be empty.`, `Pass ${param} as non-empty text.`);
  const max = opts.max ?? 20_000;
  if (raw.length > max) throw opError('invalid_params', `${param} is longer than ${max} characters.`, `Shorten ${param}; long material belongs in its own page, linked by slug.`);
  return raw;
}

export function stringListParam(raw: unknown, param: string, maxItems = 50): string[] {
  if (raw === undefined || raw === null) return [];
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list) || list.some(v => typeof v !== 'string')) {
    throw opError('invalid_params', `${param} must be a list of strings.`, `Pass ${param} as an array, for example ["first", "second"].`);
  }
  const out = (list as string[]).map(v => v.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (out.length > maxItems) throw opError('invalid_params', `${param} has more than ${maxItems} items.`, `Pass at most ${maxItems} items in ${param}.`);
  return [...new Set(out)];
}

/** A page slug a handoff page may link to: lowercase path segments, no wiki syntax. */
export function linkSlug(raw: string): string | null {
  const s = raw.trim().replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '').toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(s) && s.length <= 200 ? s : null;
}
