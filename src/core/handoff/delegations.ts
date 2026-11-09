/**
 * Delegation inbox: agents register and heartbeat, delegate work as task
 * pages, see their inbox, claim with a lease, and complete or release.
 *
 * Claims are atomic: claim_task reads the task, checks it is claimable by the
 * caller, and writes the claim naming the revision it read. The page write
 * path checks that revision under the page lock, so two agents claiming the
 * same task get one commit and one revision conflict; the loser re-reads,
 * sees the live lease and is refused with `task_claimed`.
 *
 * A task addressed to an agent (`to_agent`) is visible to and claimable by
 * that agent only. A task addressed to a model (`to_model`) is visible to
 * agents registered on that model. A lease that runs out reopens the task:
 * inbox and claim treat it as open at once, and the next heartbeat writes
 * the reopen into the page.
 */
import { randomBytes } from 'node:crypto';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { slugify } from '../entities/resolve.ts';
import {
  DELEGATION_PREFIX, normalizeProse, oneLine, parseAgent, parseTask, renderAgent, renderTask,
  type AgentState, type TaskLogEntry, type TaskPriority, type TaskState,
} from './format.ts';
import {
  agentSlug, assertHandoffType, handoffId, handoffNow, listHandoffPages, loadTags, mutateHandoffPage, notFound, readHandoffPage,
  type MutationOutcome, type StoredHandoffPage,
} from './store.ts';
import { appendTurn, threadSlugFor } from './threads.ts';
import { loadDirectory, modelMatches, rankTargets } from './routing.ts';

export const DEFAULT_LEASE_MINUTES = 15;
export const MAX_LEASE_MINUTES = 240;
/** A heartbeat closer than this to the recorded one changes nothing on the page. */
const HEARTBEAT_WRITE_INTERVAL_MS = 60_000;
const REAP_BATCH = 25;
const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
/** Sorts a task with no due date after every dated one. */
const NO_DUE = '9999-12-31';

// ── agents ─────────────────────────────────────────────────────────────────

export async function readAgent(ctx: OperationContext, sourceId: string, name: string): Promise<AgentState | null> {
  const page = await readHandoffPage(ctx, sourceId, agentSlug(name));
  if (!page) return null;
  assertHandoffType(page, 'agent', 'agent');
  return parseAgent(name, page);
}

export interface AgentUpdate { model?: string | null; capabilities?: string[]; heartbeat?: boolean }

/** Create or update an agent page. A heartbeat-only update within a minute of the last one is a no-op. */
export async function upsertAgent(ctx: OperationContext, sourceId: string, name: string, update: AgentUpdate): Promise<MutationOutcome<{ agent: AgentState; created: boolean }>> {
  return mutateHandoffPage<{ agent: AgentState; created: boolean }>(ctx, sourceId, agentSlug(name), current => {
    const now = handoffNow();
    const at = now.toISOString();
    const prior = current ? (assertHandoffType(current, 'agent', 'agent'), parseAgent(name, current)) : null;
    const next: AgentState = {
      name,
      model: update.model !== undefined && update.model !== null ? oneLine(update.model) : prior?.model ?? null,
      capabilities: update.capabilities ?? prior?.capabilities ?? [],
      registeredAt: prior?.registeredAt || at,
      lastHeartbeat: update.heartbeat ? at : prior?.lastHeartbeat ?? at,
      extra: prior?.extra ?? {},
    };
    if (prior) {
      const sameFields = prior.model === next.model && JSON.stringify(prior.capabilities) === JSON.stringify(next.capabilities);
      const recent = prior.lastHeartbeat !== null && now.getTime() - Date.parse(prior.lastHeartbeat) < HEARTBEAT_WRITE_INTERVAL_MS;
      if (sameFields && (!update.heartbeat || recent)) return { noop: { agent: prior, created: false } };
    }
    return { content: renderAgent(next), result: { agent: next, created: !prior } };
  });
}

// ── task state helpers ─────────────────────────────────────────────────────

export function leaseExpired(task: TaskState, now: number): boolean {
  return task.status === 'claimed' && (!task.leaseUntil || Date.parse(task.leaseUntil) <= now);
}

/** The status an agent should act on: a claimed task whose lease ran out is open. */
export function effectiveStatus(task: TaskState, now: number): TaskState['status'] {
  return leaseExpired(task, now) ? 'open' : task.status;
}

export function addressedTo(task: TaskState, agent: string, agentModel: string | null): boolean {
  if (task.toAgent) return task.toAgent === agent;
  if (task.toModel) return modelMatches(task.toModel, agentModel);
  return false;
}

function addressee(task: TaskState): string {
  return task.toAgent ?? (task.toModel ? `model:${task.toModel}` : 'nobody');
}

function logEntry(agent: string, event: string, detail: string | null = null): TaskLogEntry {
  return { at: handoffNow().toISOString(), agent, event, detail: detail ? oneLine(detail).slice(0, 300) : null };
}

function readTask(page: StoredHandoffPage): TaskState {
  assertHandoffType(page, 'delegation', 'delegation task');
  return parseTask(page);
}

export function taskView(slug: string, task: TaskState, now: number, opts: { instructions?: 'full' | 'preview' } = {}) {
  const status = effectiveStatus(task, now);
  const preview = opts.instructions === 'full' ? task.instructions : task.instructions.length > 280 ? `${task.instructions.slice(0, 277)}...` : task.instructions;
  return {
    task_id: handoffId(slug), slug, title: task.title, status, ...(status !== task.status ? { lease_expired: true } : {}),
    from_agent: task.fromAgent, to_agent: task.toAgent, to_model: task.toModel, priority: task.priority, due: task.due, auto_ok: task.autoOk,
    tags: task.tags, task_type: task.taskType, thread: task.thread, context: task.context, attempts: task.attempts,
    claimed_by: task.claimedBy, lease_until: task.leaseUntil, fan_out: task.fanOut, picked: task.picked,
    instructions: preview, ...(task.result ? { result: task.result } : {}), ...(task.files.length ? { files: task.files } : {}),
    created_at: task.createdAt, updated_at: task.updatedAt,
  };
}

/**
 * Note a task event on its thread. The task write has already committed, so a
 * thread that was deleted or cannot be written is reported, never thrown.
 */
async function noteOnThread(ctx: OperationContext, sourceId: string, thread: string | null, turn: Parameters<typeof appendTurn>[4]):
  Promise<{ thread: string | null; noted: boolean; error?: string }> {
  if (!thread) return { thread: null, noted: false };
  try {
    await appendTurn(ctx, sourceId, thread, null, turn);
    return { thread, noted: true };
  } catch (error) {
    return { thread, noted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── delegate / fan_out ─────────────────────────────────────────────────────

export interface DelegateInput {
  title: string;
  instructions: string;
  fromAgent: string;
  toAgent: string | null;
  toModel: string | null;
  context: string[];
  thread: string | null;
  priority: TaskPriority;
  due: string | null;
  autoOk: boolean;
  tags: string[];
  taskType: string | null;
}

function newTaskState(input: DelegateInput, at: string, extra: { fanOut?: string; routed?: string } = {}): TaskState {
  return {
    title: oneLine(input.title), fromAgent: input.fromAgent, toAgent: input.toAgent, toModel: input.toModel, thread: input.thread,
    tags: input.tags, taskType: input.taskType, priority: input.priority, due: input.due, autoOk: input.autoOk, status: 'open',
    claimedBy: null, claimedAt: null, leaseUntil: null, attempts: 0, completedAt: null, fanOut: extra.fanOut ?? null, picked: null,
    routed: extra.routed ?? null, createdAt: at, updatedAt: at, instructions: normalizeProse(input.instructions), context: input.context,
    result: '', files: [], log: [logEntry(input.fromAgent, 'delegated', `to ${input.toAgent ?? `model:${input.toModel}`}`)], extra: {},
  };
}

/** A fresh task slug: date, title, short random tail (titles repeat; ids must not). */
export function newTaskSlug(title: string, suffix?: string): string {
  const date = handoffNow().toISOString().slice(0, 10);
  const base = slugify(title).slice(0, 60).replace(/-+$/, '') || 'task';
  const tail = randomBytes(3).toString('hex');
  return `${DELEGATION_PREFIX}${date}-${base}-${tail}${suffix ? `-${suffix}` : ''}`;
}

async function createTask(ctx: OperationContext, sourceId: string, slug: string, task: TaskState) {
  return mutateHandoffPage(ctx, sourceId, slug, current => {
    if (current) throw opError('invalid_params', `Task ${handoffId(slug)} already exists.`, 'Delegate again; a new task id is generated each time.');
    return { content: renderTask(task), result: task };
  });
}

/** Resolve the delegate target: explicit to_agent / to_model, else the top deterministic route. */
async function resolveTarget(ctx: OperationContext, sourceId: string, input: DelegateInput): Promise<{ toAgent: string | null; toModel: string | null; routed: string | null }> {
  if (input.toAgent || input.toModel) return { toAgent: input.toAgent, toModel: input.toModel, routed: null };
  const ranked = rankTargets(await loadDirectory(ctx, sourceId), { tags: input.tags, taskType: input.taskType, exclude: [input.fromAgent] });
  const top = ranked[0];
  if (!top) {
    throw opError('invalid_params', 'delegate needs to_agent or to_model: no agent is registered and the routing page names no target.',
      'Pass to_agent (an agent name) or to_model, or have agents call register_agent / heartbeat first.');
  }
  return top.kind === 'model' ? { toAgent: null, toModel: top.model, routed: `route: ${top.reason}` } : { toAgent: top.agent, toModel: null, routed: `route: ${top.reason}` };
}

async function assertThread(ctx: OperationContext, sourceId: string, thread: string | null): Promise<void> {
  if (!thread) return;
  const page = await readHandoffPage(ctx, sourceId, thread);
  if (!page) throw notFound('thread', thread);
  assertHandoffType(page, 'thread', 'thread');
}

export async function delegate(ctx: OperationContext, sourceId: string, input: DelegateInput) {
  await assertThread(ctx, sourceId, input.thread);
  const target = await resolveTarget(ctx, sourceId, input);
  const full = { ...input, toAgent: target.toAgent, toModel: target.toModel };
  const slug = newTaskSlug(input.title);
  const created = await createTask(ctx, sourceId, slug, newTaskState(full, handoffNow().toISOString(), { routed: target.routed ?? undefined }));
  const thread = await noteOnThread(ctx, sourceId, input.thread, { agent: input.fromAgent, model: null, kind: 'delegate',
    text: `Delegated to ${addressee(created.result)}: ${created.result.title} ([[${slug}]])` });
  return { slug, task: created.result, outcome: created, thread };
}

export async function fanOut(ctx: OperationContext, sourceId: string, input: Omit<DelegateInput, 'toAgent' | 'toModel'> & { agents: string[] }) {
  await assertThread(ctx, sourceId, input.thread);
  const threadSlug = input.thread ?? threadSlugFor(null, input.title);
  const at = handoffNow().toISOString();
  const group = handoffId(newTaskSlug(input.title));
  const tasks: Array<{ slug: string; task: TaskState }> = [];
  for (const agent of input.agents) {
    const slug = `${DELEGATION_PREFIX}${group}-${agent}`;
    const created = await createTask(ctx, sourceId, slug, newTaskState({ ...input, thread: threadSlug, toAgent: agent, toModel: null }, at, { fanOut: group }));
    tasks.push({ slug, task: created.result });
  }
  const thread = await appendTurn(ctx, sourceId, threadSlug, input.title, { agent: input.fromAgent, model: null, kind: 'fan_out',
    text: `Fanned out to ${input.agents.join(', ')}: ${oneLine(input.title)} (${tasks.map(t => `[[${t.slug}]]`).join(', ')})` });
  return { group, threadSlug, tasks, threadOutcome: thread };
}

// ── inbox ──────────────────────────────────────────────────────────────────

export async function inbox(ctx: OperationContext, sourceId: string, agent: string, opts: { includeClosed?: boolean } = {}) {
  const now = handoffNow().getTime();
  const self = await readAgent(ctx, sourceId, agent);
  const pages = await listHandoffPages(ctx, sourceId, 'delegation', DELEGATION_PREFIX);
  const open: Array<ReturnType<typeof taskView>> = [];
  const mine: Array<ReturnType<typeof taskView>> = [];
  const closed: Array<ReturnType<typeof taskView>> = [];
  for (const listed of pages) {
    if (!addressedTo(parseTask(listed), agent, self?.model ?? null)) continue;
    const page = await loadTags(ctx, listed);
    const task = parseTask(page);
    const status = effectiveStatus(task, now);
    const view = taskView(page.slug, task, now);
    if (status === 'claimed') { if (task.claimedBy === agent) mine.push(view); }
    else if (status === 'open' || status === 'released') open.push(view);
    else if (opts.includeClosed) closed.push(view);
  }
  const order = (a: ReturnType<typeof taskView>, b: ReturnType<typeof taskView>) =>
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (a.due ?? NO_DUE).localeCompare(b.due ?? NO_DUE) || a.created_at.localeCompare(b.created_at) || a.slug.localeCompare(b.slug);
  open.sort(order);
  mine.sort(order);
  return {
    agent, registered: self !== null, model: self?.model ?? null,
    open: open.map(v => ({ ...v, ask_user: v.auto_ok ? null : `Delegated from ${v.from_agent}: ${v.title}. Want me to take it?` })),
    claimed: mine,
    ...(opts.includeClosed ? { closed } : {}),
  };
}

// ── claim / complete / release ─────────────────────────────────────────────

export async function claimTask(ctx: OperationContext, sourceId: string, slug: string, agent: string, leaseMinutes: number) {
  const self = await readAgent(ctx, sourceId, agent);
  return mutateHandoffPage(ctx, sourceId, slug, current => {
    if (!current) throw notFound('task', slug);
    const task = readTask(current);
    const now = handoffNow().getTime();
    if (!addressedTo(task, agent, self?.model ?? null)) {
      throw opError('task_not_addressed', `Task ${handoffId(slug)} is addressed to ${addressee(task)}, not ${agent}; it was not claimed.`,
        'Leave it for its addressee. Your own work is in inbox.');
    }
    if (task.status === 'done' || task.status === 'failed') {
      throw opError('task_closed', `Task ${handoffId(slug)} is already ${task.status}.`, 'Nothing to claim; check inbox for open work.');
    }
    const leaseUntil = new Date(now + leaseMinutes * 60_000).toISOString();
    if (task.status === 'claimed' && !leaseExpired(task, now)) {
      if (task.claimedBy !== agent) {
        throw opError('task_claimed', `Task ${handoffId(slug)} is claimed by ${task.claimedBy} until ${task.leaseUntil}.`,
          'Another agent holds the lease; pick another task from inbox. The task reopens if that lease runs out.');
      }
      const renewed: TaskState = { ...task, leaseUntil, updatedAt: new Date(now).toISOString(), log: [...task.log, logEntry(agent, 'renewed', `lease until ${leaseUntil}`)] };
      return { content: renderTask(renewed), result: { task: renewed, renewed: true } };
    }
    const reopened = leaseExpired(task, now) ? [logEntry(task.claimedBy ?? agent, 'reopened', 'lease expired')] : [];
    const claimed: TaskState = { ...task, status: 'claimed', claimedBy: agent, claimedAt: new Date(now).toISOString(), leaseUntil,
      attempts: task.attempts + 1, updatedAt: new Date(now).toISOString(),
      log: [...task.log, ...reopened, logEntry(agent, 'claimed', `attempt ${task.attempts + 1}, lease until ${leaseUntil}`)] };
    return { content: renderTask(claimed), result: { task: claimed, renewed: false } };
  });
}

function assertHolder(task: TaskState, slug: string, agent: string, action: string): void {
  if (task.status === 'done' || task.status === 'failed') {
    throw opError('task_closed', `Task ${handoffId(slug)} is already ${task.status}.`, `Nothing to ${action}.`);
  }
  // A holder whose lease ran out may still finish, as long as nobody else claimed the task since.
  if (task.claimedBy !== agent || (task.status !== 'claimed' && task.status !== 'open')) {
    throw opError('task_not_yours', `Task ${handoffId(slug)} is not claimed by ${agent}.`, `Claim it with claim_task before you ${action} it.`);
  }
}

export async function completeTask(ctx: OperationContext, sourceId: string, slug: string, agent: string, input: { result: string; files: string[]; failed: boolean }) {
  const outcome = await mutateHandoffPage(ctx, sourceId, slug, current => {
    if (!current) throw notFound('task', slug);
    const task = readTask(current);
    assertHolder(task, slug, agent, input.failed ? 'fail' : 'complete');
    const at = handoffNow().toISOString();
    const next: TaskState = { ...task, status: input.failed ? 'failed' : 'done', completedAt: at, leaseUntil: null, updatedAt: at,
      result: normalizeProse(input.result), files: input.files, log: [...task.log, logEntry(agent, input.failed ? 'failed' : 'completed')] };
    return { content: renderTask(next), result: next };
  });
  const task = outcome.result;
  const thread = await noteOnThread(ctx, sourceId, task.thread, { agent, model: null, kind: 'complete',
    text: `${input.failed ? 'Failed' : 'Completed'} [[${slug}]] (${task.title}): ${oneLine(task.result).slice(0, 600)}` });
  return { outcome, thread };
}

export async function releaseTask(ctx: OperationContext, sourceId: string, slug: string, agent: string, reason: string) {
  const outcome = await mutateHandoffPage(ctx, sourceId, slug, current => {
    if (!current) throw notFound('task', slug);
    const task = readTask(current);
    assertHolder(task, slug, agent, 'release');
    const at = handoffNow().toISOString();
    const next: TaskState = { ...task, status: 'released', claimedBy: null, claimedAt: null, leaseUntil: null, updatedAt: at,
      log: [...task.log, logEntry(agent, 'released', reason)] };
    return { content: renderTask(next), result: next };
  });
  const task = outcome.result;
  const thread = await noteOnThread(ctx, sourceId, task.thread, { agent, model: null, kind: 'release',
    text: `Released [[${slug}]] (${task.title}): ${oneLine(reason)}` });
  return { outcome, thread };
}

/** Write the reopen of expired leases into their pages (bounded per call). */
export async function reapExpiredLeases(ctx: OperationContext, sourceId: string): Promise<string[]> {
  const now = handoffNow().getTime();
  const expired = (await listHandoffPages(ctx, sourceId, 'delegation', DELEGATION_PREFIX))
    .filter(p => leaseExpired(parseTask(p), now)).slice(0, REAP_BATCH);
  const reopened: string[] = [];
  for (const page of expired) {
    const outcome = await mutateHandoffPage(ctx, sourceId, page.slug, current => {
      if (!current) return { noop: false };
      const task = readTask(current);
      if (!leaseExpired(task, handoffNow().getTime())) return { noop: false };
      const at = handoffNow().toISOString();
      const next: TaskState = { ...task, status: 'open', leaseUntil: null, updatedAt: at, log: [...task.log, logEntry(task.claimedBy ?? 'gbrain', 'reopened', 'lease expired')] };
      return { content: renderTask(next), result: true };
    });
    if (outcome.result) reopened.push(handoffId(page.slug));
  }
  return reopened;
}

// ── pick_result ────────────────────────────────────────────────────────────

export async function pickResult(ctx: OperationContext, sourceId: string, slug: string, by: string) {
  const page = await readHandoffPage(ctx, sourceId, slug);
  if (!page) throw notFound('task', slug);
  const chosen = readTask(page);
  if (!chosen.fanOut) throw opError('invalid_params', `Task ${handoffId(slug)} is not part of a fan-out.`, 'pick_result records the chosen result among fan_out siblings.');
  if (chosen.status !== 'done') throw opError('invalid_params', `Task ${handoffId(slug)} is ${chosen.status}, not done.`, 'Pick a sibling whose status is done.');
  const siblings = (await listHandoffPages(ctx, sourceId, 'delegation', DELEGATION_PREFIX))
    .filter(p => parseTask(p).fanOut === chosen.fanOut);
  const changed: string[] = [];
  for (const sib of siblings) {
    const picked = sib.slug === slug;
    const outcome = await mutateHandoffPage(ctx, sourceId, sib.slug, current => {
      if (!current) return { noop: null };
      const task = readTask(current);
      const want = picked ? true : task.status === 'done' ? false : null;
      if (task.picked === want) return { noop: null };
      const at = handoffNow().toISOString();
      const next: TaskState = { ...task, picked: want, updatedAt: at, log: picked ? [...task.log, logEntry(by, 'picked')] : task.log };
      return { content: renderTask(next), result: null };
    });
    if (!outcome.noop) changed.push(handoffId(sib.slug));
  }
  const thread = await noteOnThread(ctx, sourceId, chosen.thread, { agent: by, model: null, kind: 'pick',
    text: `Picked the result of ${chosen.toAgent ?? chosen.claimedBy ?? 'an agent'}: [[${slug}]]` });
  return { group: chosen.fanOut, picked: handoffId(slug), agent: chosen.toAgent, siblings: siblings.map(s => handoffId(s.slug)), changed, thread };
}
