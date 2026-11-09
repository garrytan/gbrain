/**
 * Cross-agent thread pickup ops: log_turn, update_thread_summary, checkpoint,
 * find_thread, pickup. A thread is a markdown page (`threads/<id>.md`) any
 * agent connected to the brain can append to and pick up; the logic lives in
 * src/core/handoff/threads.ts. Handoff pages live in the caller's write
 * source (`source_id` narrows it like put_page).
 */
import type { Operation, OperationContext } from './contract.ts';
import { opError } from './contract.ts';
import { THREAD_STATUSES } from '../handoff/format.ts';
import { agentNameParam, handoffId, optionalAgentName, stringListParam, stringParam, threadSlugParam } from '../handoff/store.ts';
import { appendTurn, findThreads, pickupThread, replaceSummary, resolveEntities, threadSlugFor, threadStatusParam } from '../handoff/threads.ts';

const SOURCE_PARAM = { type: 'string' as const, description: 'Source holding the handoff pages; default your write source.' };
const AGENT_PARAM = { type: 'string' as const, required: true, description: "Your agent name, e.g. 'claude' or 'grok-bot'." };
const MODEL_PARAM = { type: 'string' as const, description: "Your model label, e.g. 'claude-opus-5-5'." };
const THREAD_ID_PARAM = { type: 'string' as const, required: true, description: "Thread id, e.g. '12-oak-st-listing-deck'." };

export async function handoffSource(ctx: OperationContext, p: Record<string, unknown>, op: string): Promise<string> {
  const { pageMutationSource } = await import('../persistence/page-mutations.ts');
  return pageMutationSource(ctx, p, op);
}

function modelParam(raw: unknown): string | null {
  const m = stringParam(raw, 'model', { max: 120 }).replace(/[()·\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
  return m || null;
}

function writeReceipt(outcome: { revision: string | null; noop: boolean; pending?: Record<string, unknown>; dryRun?: boolean }) {
  return {
    revision: outcome.revision,
    ...(outcome.noop ? { noop: true } : {}),
    ...(outcome.pending ? { write_pending: true, request_id: outcome.pending.request_id ?? null } : {}),
    ...(outcome.dryRun ? { dry_run: true } : {}),
  };
}

const log_turn: Operation = {
  name: 'log_turn',
  mutating: true,
  writeInference: 'async_derived',
  scope: 'write',
  outputRedaction: 'no_stored_text',
  description: 'Append a turn to a shared thread page (threads/<id>.md) so any agent can pick the work up later. '
    + 'Pass thread_id to continue a thread, or title to start or continue the thread with that title. Decisions accumulate; '
    + 'open_questions, when passed, replace the open list. Entities (slugs or names) are linked to their pages.',
  params: {
    agent: AGENT_PARAM,
    model: MODEL_PARAM,
    thread_id: { type: 'string', description: 'Thread to continue. Omit and pass title to start one.' },
    title: { type: 'string', description: "Thread title, e.g. '12 Oak St listing deck'." },
    summary: { type: 'string', required: true, description: 'One to three lines on what happened this turn.' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions made this turn.' },
    open_questions: { type: 'array', items: { type: 'string' }, description: 'The open questions now (replaces the list).' },
    entities: { type: 'array', items: { type: 'string' }, description: "Pages this turn touched: slugs ('properties/12-oak-st') or names." },
    next_up: { type: 'string', description: 'The next step, if it changed.' },
    status: { type: 'string', enum: [...THREAD_STATUSES], description: 'Set the thread status.' },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'log_turn');
    const agent = agentNameParam(p.agent, 'agent');
    const title = stringParam(p.title, 'title', { max: 200 }).trim();
    const threadId = p.thread_id === undefined || p.thread_id === null || p.thread_id === '' ? null : threadSlugParam(p.thread_id);
    if (!threadId && !title) throw opError('invalid_params', 'log_turn needs thread_id or title.', 'Pass thread_id to continue a thread, or title to start one.');
    const slug = threadSlugFor(threadId, title);
    const summary = stringParam(p.summary, 'summary', { required: true, max: 8_000 });
    const refs = stringListParam(p.entities, 'entities');
    const { slugs, unresolved } = await resolveEntities(ctx, sourceId, refs);
    const openQuestions = p.open_questions === undefined || p.open_questions === null ? null : stringListParam(p.open_questions, 'open_questions');
    const status = threadStatusParam(p.status);
    const nextStep = stringParam(p.next_up, 'next_up', { max: 1_000 }).trim() || null;
    const outcome = await appendTurn(ctx, sourceId, slug, title || null, {
      agent, model: modelParam(p.model), text: unresolved.length ? `${summary}\n\nAlso mentioned: ${unresolved.join(', ')}` : summary,
      decisions: stringListParam(p.decisions, 'decisions'), openQuestions, entities: slugs, nextStep,
    }, { ...(status ? { status } : {}), seedSummary: summary });
    const thread = outcome.result.thread;
    return {
      thread_id: handoffId(slug), slug, created: outcome.result.created, turn: thread.turns[thread.turns.length - 1]?.n ?? 0,
      status: thread.status, history: thread.agents.join(' -> '), linked: slugs, unresolved_entities: unresolved, ...writeReceipt(outcome),
    };
  },
  cliHints: { name: 'log-turn' },
};

const update_thread_summary: Operation = {
  name: 'update_thread_summary',
  mutating: true,
  idempotent: true,
  writeInference: 'async_derived',
  scope: 'write',
  outputRedaction: 'no_stored_text',
  description: "Replace a thread's rolling summary: what the work is, where it stands, and what matters for whoever picks it up next.",
  params: {
    thread_id: THREAD_ID_PARAM,
    summary: { type: 'string', required: true, description: 'The new rolling summary (markdown).' },
    agent: { type: 'string', description: 'Your agent name; joins the handoff history.' },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'update_thread_summary');
    const slug = threadSlugParam(p.thread_id);
    const outcome = await replaceSummary(ctx, sourceId, slug, stringParam(p.summary, 'summary', { required: true }), optionalAgentName(p.agent, 'agent'));
    return { thread_id: handoffId(slug), slug, ...writeReceipt(outcome) };
  },
  cliHints: { name: 'thread-summary', positional: ['thread_id'] },
};

const checkpoint: Operation = {
  name: 'checkpoint',
  mutating: true,
  writeInference: 'async_derived',
  scope: 'write',
  outputRedaction: 'no_stored_text',
  description: "Save your place on a thread: record the next step (and optionally a new rolling summary) and park the thread, so you or another agent can resume it with pickup.",
  params: {
    thread_id: THREAD_ID_PARAM,
    agent: AGENT_PARAM,
    model: MODEL_PARAM,
    next_up: { type: 'string', required: true, description: 'What to do next when the work resumes.' },
    summary: { type: 'string', description: 'A new rolling summary.' },
    status: { type: 'string', enum: [...THREAD_STATUSES], description: "Default 'parked'." },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'checkpoint');
    const slug = threadSlugParam(p.thread_id);
    const agent = agentNameParam(p.agent, 'agent');
    const nextStep = stringParam(p.next_up, 'next_up', { required: true, max: 1_000 }).trim();
    const summary = p.summary === undefined || p.summary === null ? undefined : stringParam(p.summary, 'summary');
    const outcome = await appendTurn(ctx, sourceId, slug, null, { agent, model: modelParam(p.model), kind: 'checkpoint', text: '', nextStep },
      { status: threadStatusParam(p.status) ?? 'parked', ...(summary !== undefined ? { summary } : {}) });
    const thread = outcome.result.thread;
    return { thread_id: handoffId(slug), slug, status: thread.status, next_up: thread.nextStep, turn: thread.turns[thread.turns.length - 1]?.n ?? 0, ...writeReceipt(outcome) };
  },
  cliHints: { name: 'checkpoint', positional: ['thread_id'] },
};

const find_thread: Operation = {
  name: 'find_thread',
  mutating: false,
  idempotent: true,
  scope: 'read',
  outputRedaction: 'retrieval',
  annotations: { readOnlyHint: true },
  description: 'Find the thread a user means ("the project about Y from Grok Bot"): hybrid search over thread pages plus link-graph hits on the pages the query names, '
    + 'boosted when the named agent worked on it and by recency. Returns the top matches with a why line; confirm with the user, then pickup.',
  params: {
    query: { type: 'string', required: true, description: "What the work was about, e.g. '12 Oak St listing deck'." },
    agent: { type: 'string', description: 'The agent or app that held it (boosts, does not filter).' },
    since: { type: 'string', description: 'Updated on/after: YYYY-MM-DD, ISO time, or 7d/2w.' },
    status: { type: 'string', enum: [...THREAD_STATUSES], description: 'Only threads with this status.' },
    limit: { type: 'number', description: 'Matches to return, 1-10 (default 3).' },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'find_thread');
    const query = stringParam(p.query, 'query', { required: true, max: 500 }).trim();
    const limit = p.limit === undefined ? 3 : Number(p.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw opError('invalid_params', 'limit must be an integer from 1 to 10.', 'Pass limit 3 for the default.');
    const since = stringParam(p.since, 'since', { max: 64 }).trim() || null;
    const { matches, considered } = await findThreads(ctx, sourceId, { query, agent: optionalAgentName(p.agent, 'agent'), since, status: threadStatusParam(p.status), limit });
    return { query, matches, considered };
  },
  cliHints: { name: 'find-thread', positional: ['query'] },
};

const pickup: Operation = {
  name: 'pickup',
  mutating: true,
  writeInference: 'async_derived',
  scope: 'write',
  outputRedaction: 'retrieval',
  description: 'Pick up a thread: returns its rolling summary, last 10 turns, decisions, open questions, next step, linked pages, linked delegations and handoff history. '
    + 'With agent, you join the history (e.g. grok-bot -> claude) and a parked thread becomes active.',
  params: {
    thread_id: THREAD_ID_PARAM,
    agent: { type: 'string', description: 'Your agent name; omit for a read-only look.' },
    model: MODEL_PARAM,
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'pickup');
    const slug = threadSlugParam(p.thread_id);
    const agent = optionalAgentName(p.agent, 'agent');
    const { packet, recorded, outcome } = await pickupThread(ctx, sourceId, slug, agent, modelParam(p.model));
    return { ...packet, recorded, ...(outcome ? writeReceipt(outcome) : {}) };
  },
  cliHints: { name: 'pickup', positional: ['thread_id'] },
};

export const agentThreadOperations: Operation[] = [log_turn, update_thread_summary, checkpoint, find_thread, pickup];
