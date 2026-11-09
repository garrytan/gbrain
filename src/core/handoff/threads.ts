/**
 * Thread pickup: log turns on a shared thread page, keep a rolling summary,
 * checkpoint the next step, find a thread from any agent, and pick it up with
 * a context packet. No model is called on any of these paths; find_thread
 * reuses the brain's hybrid retrieval (query expansion and reranking off) and
 * its link graph, then ranks deterministically.
 */
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { resolveEntitySlug, slugify } from '../entities/resolve.ts';
import type { HybridSearchOpts } from '../search/hybrid.ts';
import { resolveExcludePrivatePages } from '../search/private-visibility.ts';
import { parseSinceParam } from '../facts/since-parse.ts';
import {
  AGENT_PREFIX, DELEGATION_PREFIX, THREAD_PREFIX, THREAD_STATUSES, handoffKindOf, normalizeProse, oneLine, parseTask, parseThread, renderThread,
  type ThreadState, type ThreadStatus, type ThreadTurn, type TurnKind,
} from './format.ts';
import {
  assertHandoffType, handoffId, handoffNow, linkSlug, listHandoffPages, mutateHandoffPage, notFound, readHandoffPage,
  type MutationOutcome, type StoredHandoffPage,
} from './store.ts';

export const PICKUP_TURNS = 10;
const MAX_TURN_CHARS = 8_000;

export interface TurnInput {
  agent: string;
  model: string | null;
  kind?: TurnKind;
  text: string;
  decisions?: string[];
  openQuestions?: string[] | null;
  entities?: string[];
  nextStep?: string | null;
}

/** Append `next` to the handoff chain unless it is already the last agent. */
export function extendChain(chain: string[], next: string): string[] {
  return chain[chain.length - 1] === next ? chain : [...chain, next];
}

export function historyLine(chain: string[]): string {
  return chain.join(' -> ');
}

function emptyThread(title: string, agent: string, model: string | null, at: string): ThreadState {
  return { title, agent, model, status: 'active', agents: [agent], createdAt: at, updatedAt: at, summary: '', nextStep: '',
    decisions: [], openQuestions: [], entities: [], turns: [], extra: {} };
}

/** Apply one turn to a thread state (pure). Decisions accumulate; open questions, when given, replace the list. */
export function applyTurn(thread: ThreadState, turn: TurnInput, at: string): ThreadState {
  const entities = [...thread.entities];
  for (const e of turn.entities ?? []) if (!entities.includes(e)) entities.push(e);
  const decisions = [...thread.decisions];
  for (const d of turn.decisions ?? []) if (!decisions.includes(d)) decisions.push(d);
  const n = (thread.turns[thread.turns.length - 1]?.n ?? 0) + 1;
  const record: ThreadTurn = {
    n, agent: turn.agent, model: turn.model, at, kind: turn.kind ?? 'turn', text: normalizeProse(turn.text).slice(0, MAX_TURN_CHARS),
    decisions: turn.decisions ?? [], openQuestions: turn.openQuestions ?? [], entities: turn.entities ?? [], nextStep: turn.nextStep ?? null,
  };
  return {
    ...thread,
    agent: turn.agent,
    model: turn.model ?? (thread.agent === turn.agent ? thread.model : null),
    agents: extendChain(thread.agents, turn.agent),
    updatedAt: at,
    decisions,
    openQuestions: turn.openQuestions ?? thread.openQuestions,
    nextStep: turn.nextStep ?? thread.nextStep,
    entities,
    turns: [...thread.turns, record],
  };
}

export function readThreadState(page: StoredHandoffPage): ThreadState {
  assertHandoffType(page, 'thread', 'thread');
  return parseThread(page);
}

/**
 * Resolve entity references to page slugs with the brain's entity resolver.
 * A slug-shaped reference ("properties/12-oak-st") links as written; a name
 * resolves only to a live page the caller may read. Names that resolve to no
 * page stay in the turn text and come back as `unresolved`.
 */
export async function resolveEntities(ctx: OperationContext, sourceId: string, refs: string[]): Promise<{ slugs: string[]; unresolved: string[] }> {
  const slugs: string[] = [];
  const unresolved: string[] = [];
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  for (const ref of refs) {
    const direct = ref.includes('/') ? linkSlug(ref) : null;
    if (direct) { if (!slugs.includes(direct)) slugs.push(direct); continue; }
    const guess = await resolveEntitySlug(ctx.engine, sourceId, ref).catch(() => null);
    const page = guess ? await ctx.engine.readPageSnapshot(guess, { sourceId }) : null;
    const hidden = page && excludePrivate && page.page.frontmatter?.visibility === 'private';
    if (page && !page.page.deleted_at && !hidden) { if (!slugs.includes(page.page.slug)) slugs.push(page.page.slug); }
    else unresolved.push(ref);
  }
  return { slugs, unresolved };
}

/** The thread slug a log_turn targets: the given id, else one derived from the title. */
export function threadSlugFor(threadId: string | null, title: string): string {
  if (threadId) return threadId;
  const id = slugify(title).slice(0, 80).replace(/-+$/, '');
  if (!id) throw opError('invalid_params', 'log_turn needs thread_id or a title with letters or digits.', 'Pass thread_id to continue a thread, or title to start one.');
  return `${THREAD_PREFIX}${id}`;
}

/** Append one turn (creating the thread when `title` is given and the thread is absent). */
export async function appendTurn(ctx: OperationContext, sourceId: string, slug: string, title: string | null, turn: TurnInput,
  extra: { summary?: string; status?: ThreadStatus; seedSummary?: string } = {}): Promise<MutationOutcome<{ thread: ThreadState; created: boolean }>> {
  return mutateHandoffPage(ctx, sourceId, slug, current => {
    const at = handoffNow().toISOString();
    let base: ThreadState;
    let created = false;
    if (current) base = readThreadState(current);
    else if (title) { base = emptyThread(oneLine(title), turn.agent, turn.model, at); created = true; }
    else throw notFound('thread', slug);
    let next = applyTurn(base, turn, at);
    if (extra.summary !== undefined) next = { ...next, summary: normalizeProse(extra.summary) };
    else if (extra.seedSummary !== undefined && !next.summary) next = { ...next, summary: normalizeProse(extra.seedSummary) };
    if (extra.status !== undefined) next = { ...next, status: extra.status };
    else if (next.status === 'parked' && turn.kind !== 'checkpoint') next = { ...next, status: 'active' };
    return { content: renderThread(next), result: { thread: next, created } };
  });
}

export async function replaceSummary(ctx: OperationContext, sourceId: string, slug: string, summary: string, agent: string | null) {
  return mutateHandoffPage<ThreadState>(ctx, sourceId, slug, current => {
    if (!current) throw notFound('thread', slug);
    const thread = readThreadState(current);
    const text = normalizeProse(summary);
    if (text === thread.summary) return { noop: thread };
    const next: ThreadState = { ...thread, summary: text, updatedAt: handoffNow().toISOString(),
      ...(agent ? { agent, agents: extendChain(thread.agents, agent), model: agent === thread.agent ? thread.model : null } : {}) };
    return { content: renderThread(next), result: next };
  });
}

// ── pickup ─────────────────────────────────────────────────────────────────

export interface LinkedPage { slug: string; title: string | null; type: string | null; exists: boolean; via: 'thread' | 'graph' }

async function linkedPages(ctx: OperationContext, sourceId: string, slug: string, entities: string[]): Promise<LinkedPage[]> {
  const out = new Map<string, LinkedPage>();
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  const describe = async (target: string, via: LinkedPage['via']) => {
    if (out.has(target)) return;
    const snap = await ctx.engine.readPageSnapshot(target, { sourceId });
    const live = snap && !snap.page.deleted_at && !(excludePrivate && snap.page.frontmatter?.visibility === 'private');
    if (!live && via === 'graph') return;
    out.set(target, { slug: target, title: live ? snap!.page.title : null, type: live ? snap!.page.type : null, exists: !!live, via });
  };
  for (const e of entities) await describe(e, 'thread');
  const links = await ctx.engine.getLinks(slug, { sourceId });
  for (const l of links) {
    if (l.to_source_id && l.to_source_id !== sourceId) continue;
    if (l.to_slug.startsWith(DELEGATION_PREFIX) || l.to_slug.startsWith(THREAD_PREFIX)) continue;
    await describe(l.to_slug, 'graph');
  }
  return [...out.values()];
}

export interface PickupPacket {
  thread_id: string;
  slug: string;
  title: string;
  status: ThreadStatus;
  agent: string;
  model: string | null;
  history: string;
  agents: string[];
  summary: string;
  next_up: string;
  decisions: string[];
  open_questions: string[];
  last_turns: Array<{ n: number; agent: string; model: string | null; at: string; kind: TurnKind; text: string; decisions: string[]; open_questions: string[]; entities: string[]; next_up: string | null }>;
  turn_count: number;
  linked_pages: LinkedPage[];
  delegations: Array<{ task_id: string; title: string; status: string; from_agent: string; to: string | null; claimed_by: string | null }>;
  created_at: string;
  updated_at: string;
}

export async function pickupPacket(ctx: OperationContext, sourceId: string, slug: string, thread: ThreadState): Promise<PickupPacket> {
  const tasks = (await listHandoffPages(ctx, sourceId, 'delegation', DELEGATION_PREFIX))
    .map(p => ({ slug: p.slug, task: parseTask(p) }))
    .filter(t => t.task.thread === slug)
    .map(t => ({ task_id: handoffId(t.slug), title: t.task.title, status: t.task.status, from_agent: t.task.fromAgent,
      to: t.task.toAgent ?? (t.task.toModel ? `model:${t.task.toModel}` : null), claimed_by: t.task.claimedBy }));
  return {
    thread_id: handoffId(slug), slug, title: thread.title, status: thread.status, agent: thread.agent, model: thread.model,
    history: historyLine(thread.agents), agents: thread.agents, summary: thread.summary, next_up: thread.nextStep,
    decisions: thread.decisions, open_questions: thread.openQuestions,
    last_turns: thread.turns.slice(-PICKUP_TURNS).map(t => ({ n: t.n, agent: t.agent, model: t.model, at: t.at, kind: t.kind, text: t.text,
      decisions: t.decisions, open_questions: t.openQuestions, entities: t.entities, next_up: t.nextStep })),
    turn_count: thread.turns.length,
    linked_pages: await linkedPages(ctx, sourceId, slug, thread.entities),
    delegations: tasks,
    created_at: thread.createdAt, updated_at: thread.updatedAt,
  };
}

/** Pick up a thread; with `agent`, the picking agent joins the handoff chain and a parked thread becomes active. */
export async function pickupThread(ctx: OperationContext, sourceId: string, slug: string, agent: string | null, model: string | null) {
  if (!agent) {
    const page = await readHandoffPage(ctx, sourceId, slug);
    if (!page) throw notFound('thread', slug);
    return { packet: await pickupPacket(ctx, sourceId, slug, readThreadState(page)), recorded: false };
  }
  const outcome = await mutateHandoffPage<ThreadState>(ctx, sourceId, slug, current => {
    if (!current) throw notFound('thread', slug);
    const thread = readThreadState(current);
    const chain = extendChain(thread.agents, agent);
    const sameHolder = thread.agent === agent && (model === null || model === thread.model);
    if (chain === thread.agents && sameHolder && thread.status === 'active') return { noop: thread };
    const next: ThreadState = { ...thread, agents: chain, agent, model: model ?? (thread.agent === agent ? thread.model : null),
      status: thread.status === 'parked' ? 'active' : thread.status, updatedAt: handoffNow().toISOString() };
    return { content: renderThread(next), result: next };
  });
  return { packet: await pickupPacket(ctx, sourceId, slug, outcome.result), recorded: !outcome.noop, outcome };
}

// ── find_thread ────────────────────────────────────────────────────────────

export interface FindThreadOpts { query: string; agent: string | null; since: string | null; status: ThreadStatus | null; limit: number }

export interface ThreadMatch {
  thread_id: string;
  slug: string;
  title: string;
  status: ThreadStatus;
  agent: string;
  history: string;
  updated_at: string;
  score: number;
  why: string;
  snippet: string | null;
}

const W_RETRIEVAL = 1.0;
const W_GRAPH = 0.6;
const W_AGENT_CHAIN = 0.35;
const W_AGENT_HOLDER = 0.15;
const W_RECENCY = 0.3;
const RECENCY_HALF_LIFE_DAYS = 14;

function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'at an unknown time';
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Rank thread pages for a query. Signals, all deterministic:
 *   retrieval — hybrid search over thread pages (best rank per thread);
 *   graph     — the thread links to a page the query names (an entity hit);
 *   agent     — the named agent is in the thread's handoff chain (a boost,
 *               not a filter: users misremember which app held a project);
 *   recency   — exponential decay on updated_at.
 * `since` and `status` are hard filters.
 */
export async function findThreads(ctx: OperationContext, sourceId: string, opts: FindThreadOpts): Promise<{ matches: ThreadMatch[]; considered: number }> {
  const { hybridSearch } = await import('../search/hybrid.ts');
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  // Zero-model retrieval: no query expansion, no reranker, no relational arm; the query embedding is the only provider call.
  const common: HybridSearchOpts = { sourceId, excludePrivate, requireSafeChunks: ctx.remote !== false, expansion: false,
    reranker: { enabled: false, topNIn: 0, topNOut: null }, relationalRetrieval: false, adaptiveReturn: false, autocut: false };
  const retrieval = new Map<string, { rank: number; snippet: string }>();
  for (const row of await hybridSearch(ctx.engine, opts.query, { ...common, where: { handoff_type: ['thread'] }, limit: 40 })) {
    if (!row.slug.startsWith(THREAD_PREFIX) || retrieval.has(row.slug)) continue;
    retrieval.set(row.slug, { rank: retrieval.size, snippet: oneLine(row.chunk_text ?? '').slice(0, 160) });
  }
  // Graph arm: pages the query names (non-handoff hits, plus the resolver's exact entity), then the threads linking to them.
  const graph = new Map<string, string>();
  const entityRows = await hybridSearch(ctx.engine, opts.query, { ...common, limit: 8,
    exclude_slug_prefixes: [THREAD_PREFIX, DELEGATION_PREFIX, AGENT_PREFIX] });
  const entitySlugs = [...new Set(entityRows.map(r => r.slug))].slice(0, 5);
  const { slugs: resolved } = await resolveEntities(ctx, sourceId, [opts.query]);
  for (const s of resolved) if (!entitySlugs.includes(s)) entitySlugs.unshift(s);
  for (const entity of entitySlugs) {
    const backlinks = await ctx.engine.getBacklinks(entity, { sourceId });
    for (const l of backlinks) {
      if (l.from_slug.startsWith(THREAD_PREFIX) && !graph.has(l.from_slug) && (!l.from_source_id || l.from_source_id === sourceId)) graph.set(l.from_slug, entity);
    }
  }
  const now = handoffNow().getTime();
  const since = opts.since ? parseSinceParam(opts.since) : null;
  if (opts.since && !since) throw opError('invalid_params', `since "${opts.since}" is not a date.`, 'Pass since as YYYY-MM-DD, an ISO time, or a span like 7d.');
  const candidates = [...new Set([...retrieval.keys(), ...graph.keys()])];
  const matches: ThreadMatch[] = [];
  for (const slug of candidates) {
    const page = await readHandoffPage(ctx, sourceId, slug);
    if (!page || handoffKindOf(page) !== 'thread') continue;
    if (excludePrivate && page.frontmatter?.visibility === 'private') continue;
    const thread = parseThread(page);
    const updated = thread.updatedAt || page.updatedAt.toISOString();
    if (opts.status && thread.status !== opts.status) continue;
    if (since && Date.parse(updated) < since.getTime()) continue;
    const why: string[] = [];
    let score = 0;
    const hit = retrieval.get(slug);
    if (hit) { score += W_RETRIEVAL / (1 + hit.rank * 0.5); why.push(`search match #${hit.rank + 1} among threads`); }
    const viaEntity = graph.get(slug);
    if (viaEntity) { score += W_GRAPH; why.push(`links to [[${viaEntity}]]`); }
    if (opts.agent) {
      if (thread.agents.includes(opts.agent)) { score += W_AGENT_CHAIN; why.push(`worked on by ${opts.agent}`); }
      if (thread.agent === opts.agent) score += W_AGENT_HOLDER;
    }
    const ageDays = Math.max(0, (now - Date.parse(updated)) / 86_400_000);
    score += Number.isFinite(ageDays) ? W_RECENCY * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS) : 0;
    why.push(`updated ${ago(updated, now)}`);
    matches.push({ thread_id: handoffId(slug), slug, title: thread.title, status: thread.status, agent: thread.agent, history: historyLine(thread.agents),
      updated_at: updated, score: Math.round(score * 1000) / 1000, why: why.join('; '), snippet: hit?.snippet || null });
  }
  matches.sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at) || a.slug.localeCompare(b.slug));
  return { matches: matches.slice(0, opts.limit), considered: candidates.length };
}

export function threadStatusParam(raw: unknown, param = 'status'): ThreadStatus | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !(THREAD_STATUSES as readonly string[]).includes(raw)) {
    throw opError('invalid_params', `${param} must be one of ${THREAD_STATUSES.join(', ')}.`, `Pass ${param} as active, parked or done.`);
  }
  return raw as ThreadStatus;
}
