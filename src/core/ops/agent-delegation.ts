/**
 * Delegation inbox and deterministic routing ops: register_agent, heartbeat,
 * delegate, inbox, claim_task, complete_task, release_task, fan_out,
 * pick_result, route, routing_stats. Tasks are markdown pages
 * (`delegations/<id>.md`), agents are `agents/<name>.md`, routing rules live
 * in `routing.md`; the logic is in src/core/handoff/{delegations,routing}.ts.
 * No op here calls a model.
 */
import type { Operation } from './contract.ts';
import { opError } from './contract.ts';
import { TASK_PRIORITIES, parseTask, type TaskPriority } from '../handoff/format.ts';
import {
  agentNameParam, handoffId, handoffNow, linkSlug, optionalAgentName, readHandoffPage, stringListParam, stringParam, taskSlugParam, threadSlugParam,
  assertHandoffType, notFound,
} from '../handoff/store.ts';
import {
  DEFAULT_LEASE_MINUTES, MAX_LEASE_MINUTES, claimTask, completeTask, delegate, fanOut, inbox, pickResult, reapExpiredLeases, releaseTask,
  taskView, upsertAgent, type DelegateInput,
} from '../handoff/delegations.ts';
import { loadDirectory, rankTargets, statsFor } from '../handoff/routing.ts';
import { handoffSource } from './agent-threads.ts';

const SOURCE_PARAM = { type: 'string' as const, description: 'Source holding the handoff pages; default your write source.' };
const AGENT_PARAM = { type: 'string' as const, required: true, description: "Your agent name, e.g. 'claude'." };
const TASK_ID_PARAM = { type: 'string' as const, required: true, description: 'Task id from inbox or delegate.' };

function modelLabel(raw: unknown, param = 'model'): string | null {
  const m = stringParam(raw, param, { max: 120 }).replace(/\s+/g, ' ').trim();
  return m || null;
}

function priorityParam(raw: unknown): TaskPriority {
  if (raw === undefined || raw === null || raw === '') return 'normal';
  if (typeof raw !== 'string' || !(TASK_PRIORITIES as readonly string[]).includes(raw)) {
    throw opError('invalid_params', `priority must be one of ${TASK_PRIORITIES.join(', ')}.`, "Pass priority 'normal' for the default.");
  }
  return raw as TaskPriority;
}

function dueParam(raw: unknown): string | null {
  const s = stringParam(raw, 'due', { max: 40 }).trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) || !Number.isFinite(Date.parse(s))) {
    throw opError('invalid_params', `due "${s}" is not a date.`, 'Pass due as YYYY-MM-DD or an ISO 8601 time.');
  }
  return s;
}

function contextParam(raw: unknown): string[] {
  const out: string[] = [];
  for (const ref of stringListParam(raw, 'context')) {
    const slug = linkSlug(ref);
    if (!slug) throw opError('invalid_params', `context entry "${ref}" is not a page slug.`, "Pass context as page slugs, e.g. ['properties/12-oak-st'].");
    out.push(slug);
  }
  return out;
}

function tagList(raw: unknown): string[] {
  return stringListParam(raw, 'tags', 20).map(t => t.toLowerCase());
}

function taskInput(p: Record<string, unknown>, fromAgent: string): Omit<DelegateInput, 'toAgent' | 'toModel'> {
  return {
    title: stringParam(p.title, 'title', { required: true, max: 200 }).trim(),
    instructions: stringParam(p.instructions, 'instructions', { required: true }),
    fromAgent,
    context: contextParam(p.context),
    thread: p.thread_id === undefined || p.thread_id === null || p.thread_id === '' ? null : threadSlugParam(p.thread_id),
    priority: priorityParam(p.priority),
    due: dueParam(p.due),
    autoOk: p.auto_ok === true,
    tags: tagList(p.tags),
    taskType: stringParam(p.task_type, 'task_type', { max: 60 }).trim().toLowerCase() || null,
  };
}

const TASK_FIELDS = {
  title: { type: 'string' as const, required: true, description: 'Short task title.' },
  instructions: { type: 'string' as const, required: true, description: 'What to do, in enough detail to act without asking.' },
  context: { type: 'array' as const, items: { type: 'string' as const }, description: "Page slugs to read first, e.g. ['properties/12-oak-st']." },
  thread_id: { type: 'string' as const, description: 'Thread the work belongs to (the delegation is noted on it).' },
  priority: { type: 'string' as const, enum: [...TASK_PRIORITIES], description: "Default 'normal'." },
  due: { type: 'string' as const, description: 'Due date, YYYY-MM-DD or ISO time.' },
  auto_ok: { type: 'boolean' as const, description: 'The receiving agent may start without asking the user.' },
  tags: { type: 'array' as const, items: { type: 'string' as const }, description: 'Tags routing rules match on.' },
  task_type: { type: 'string' as const, description: 'Task type routing rules match on.' },
};

const register_agent: Operation = {
  name: 'register_agent',
  mutating: true,
  idempotent: true,
  writeInference: 'async_derived',
  scope: 'write',
  outputRedaction: 'no_stored_text',
  description: 'Register an agent (agents/<name>.md) with its model and capabilities so delegations and routing can address it. Also counts as a heartbeat.',
  params: {
    name: { type: 'string', required: true, description: "Agent name, e.g. 'claude' or 'grok-bot'." },
    model: { type: 'string', required: true, description: "Model label, e.g. 'claude-opus-5-5'." },
    capabilities: { type: 'array', items: { type: 'string' }, description: "What it is good at, e.g. ['decks', 'research']." },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'register_agent');
    const name = agentNameParam(p.name, 'name');
    const model = modelLabel(p.model);
    if (!model) throw opError('invalid_params', 'model is required.', "Pass model as your model label, e.g. 'claude-opus-5-5'.");
    const outcome = await upsertAgent(ctx, sourceId, name, { model, capabilities: tagList(p.capabilities), heartbeat: true });
    const a = outcome.result.agent;
    return { agent: name, slug: `agents/${name}`, created: outcome.result.created, model: a.model, capabilities: a.capabilities, last_heartbeat: a.lastHeartbeat,
      revision: outcome.revision, ...(outcome.noop ? { noop: true } : {}) };
  },
  cliHints: { name: 'register-agent', positional: ['name'] },
};

const heartbeat: Operation = {
  name: 'heartbeat',
  mutating: true,
  idempotent: true,
  writeInference: 'async_derived',
  scope: 'write',
  outputRedaction: 'no_stored_text',
  description: 'Mark an agent live (registering it on first use) and reopen delegations whose lease ran out. Returns how many tasks wait in its inbox. '
    + 'Call it on your schedule and at the start of every chat, then call inbox.',
  params: {
    name: { type: 'string', required: true, description: 'Your agent name.' },
    model: { type: 'string', description: 'Your model label (recorded on first use or change).' },
    capabilities: { type: 'array', items: { type: 'string' }, description: 'Your capabilities (replaces the recorded list).' },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'heartbeat');
    const name = agentNameParam(p.name, 'name');
    const outcome = await upsertAgent(ctx, sourceId, name, {
      ...(p.model !== undefined ? { model: modelLabel(p.model) } : {}),
      ...(p.capabilities !== undefined ? { capabilities: tagList(p.capabilities) } : {}),
      heartbeat: true,
    });
    const reopened = ctx.dryRun ? [] : await reapExpiredLeases(ctx, sourceId);
    const box = await inbox(ctx, sourceId, name);
    return { agent: name, created: outcome.result.created, last_heartbeat: outcome.result.agent.lastHeartbeat,
      inbox_open: box.open.length, claimed: box.claimed.length, reopened };
  },
  cliHints: { name: 'heartbeat', positional: ['name'] },
};

const delegate_op: Operation = {
  name: 'delegate',
  mutating: true,
  idempotent: false,
  writeInference: 'async_derived',
  scope: 'write',
  outputRedaction: 'no_stored_text',
  description: 'Hand work to another agent: writes a task page (delegations/<id>.md) addressed to to_agent or to_model. '
    + 'With neither, the top target from route is used and its reason recorded. The task shows in that agent\'s inbox.',
  params: {
    from_agent: AGENT_PARAM,
    ...TASK_FIELDS,
    to_agent: { type: 'string', description: 'Agent to hand it to.' },
    to_model: { type: 'string', description: 'Or: any agent on this model.' },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'delegate');
    const fromAgent = agentNameParam(p.from_agent, 'from_agent');
    const toAgent = optionalAgentName(p.to_agent, 'to_agent');
    const toModel = modelLabel(p.to_model, 'to_model');
    if (toAgent && toModel) throw opError('invalid_params', 'Pass to_agent or to_model, not both.', 'Address the task to one agent, or to every agent on a model.');
    const result = await delegate(ctx, sourceId, { ...taskInput(p, fromAgent), toAgent, toModel });
    return { task_id: handoffId(result.slug), slug: result.slug, to_agent: result.task.toAgent, to_model: result.task.toModel,
      routed: result.task.routed, thread: result.task.thread, thread_noted: result.thread.noted, ...(result.thread.error ? { thread_error: result.thread.error } : {}),
      revision: result.outcome.revision, ...(result.outcome.dryRun ? { dry_run: true } : {}) };
  },
  cliHints: { name: 'delegate' },
};

const inbox_op: Operation = {
  name: 'inbox',
  mutating: false,
  idempotent: true,
  scope: 'read',
  outputRedaction: 'retrieval',
  annotations: { readOnlyHint: true },
  description: 'Tasks waiting for an agent: open tasks addressed to it (or to its model), highest priority first, each with an ask_user line '
    + '(null when auto_ok), plus the tasks it holds. A task addressed to another agent never appears.',
  params: {
    agent: AGENT_PARAM,
    include_closed: { type: 'boolean', description: 'Also list its done and failed tasks.' },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'inbox');
    return inbox(ctx, sourceId, agentNameParam(p.agent, 'agent'), { includeClosed: p.include_closed === true });
  },
  cliHints: { name: 'inbox', positional: ['agent'] },
};

const claim_task: Operation = {
  name: 'claim_task',
  mutating: true,
  idempotent: false,
  writeInference: 'async_derived',
  scope: 'write',
  outputRedaction: 'retrieval',
  description: `Claim a task from your inbox with a lease (default ${DEFAULT_LEASE_MINUTES} minutes). Atomic: when two agents race, one wins and the other gets task_claimed. `
    + 'Claiming again while you hold it renews the lease. Returns the full task; then pickup its thread.',
  params: {
    task_id: TASK_ID_PARAM,
    agent: AGENT_PARAM,
    lease_minutes: { type: 'number', description: `Lease length, 1-${MAX_LEASE_MINUTES} (default ${DEFAULT_LEASE_MINUTES}).` },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'claim_task');
    const slug = taskSlugParam(p.task_id);
    const lease = p.lease_minutes === undefined ? DEFAULT_LEASE_MINUTES : Number(p.lease_minutes);
    if (!Number.isInteger(lease) || lease < 1 || lease > MAX_LEASE_MINUTES) {
      throw opError('invalid_params', `lease_minutes must be an integer from 1 to ${MAX_LEASE_MINUTES}.`, `Pass lease_minutes ${DEFAULT_LEASE_MINUTES} for the default.`);
    }
    const outcome = await claimTask(ctx, sourceId, slug, agentNameParam(p.agent, 'agent'), lease);
    return { claimed: true, renewed: outcome.result.renewed, task: taskView(slug, outcome.result.task, handoffNow().getTime(), { instructions: 'full' }),
      revision: outcome.revision, ...(outcome.dryRun ? { dry_run: true } : {}) };
  },
  cliHints: { name: 'claim-task', positional: ['task_id'] },
};

const complete_task: Operation = {
  name: 'complete_task',
  mutating: true,
  idempotent: false,
  writeInference: 'async_derived',
  scope: 'write',
  outputRedaction: 'no_stored_text',
  description: 'Finish a task you claimed: record the result (and any file slugs or URLs) and mark it done, or failed. The result is noted on its thread.',
  params: {
    task_id: TASK_ID_PARAM,
    agent: AGENT_PARAM,
    result: { type: 'string', required: true, description: 'What you did and what came out of it.' },
    status: { type: 'string', enum: ['done', 'failed'], description: "Default 'done'." },
    files: { type: 'array', items: { type: 'string' }, description: 'Slugs, paths or URLs of what you produced.' },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'complete_task');
    const slug = taskSlugParam(p.task_id);
    if (p.status !== undefined && p.status !== 'done' && p.status !== 'failed') throw opError('invalid_params', "status must be 'done' or 'failed'.", "Omit status for 'done'.");
    const { outcome, thread } = await completeTask(ctx, sourceId, slug, agentNameParam(p.agent, 'agent'), {
      result: stringParam(p.result, 'result', { required: true }), files: stringListParam(p.files, 'files'), failed: p.status === 'failed' });
    return { task_id: handoffId(slug), status: outcome.result.status, thread: outcome.result.thread, thread_noted: thread.noted,
      ...(thread.error ? { thread_error: thread.error } : {}), revision: outcome.revision, ...(outcome.dryRun ? { dry_run: true } : {}) };
  },
  cliHints: { name: 'complete-task', positional: ['task_id'] },
};

const release_task: Operation = {
  name: 'release_task',
  mutating: true,
  idempotent: false,
  writeInference: 'async_derived',
  scope: 'write',
  outputRedaction: 'no_stored_text',
  description: "Give a claimed task back when you can't finish it, with the reason. It returns to its addressee's inbox.",
  params: {
    task_id: TASK_ID_PARAM,
    agent: AGENT_PARAM,
    reason: { type: 'string', required: true, description: 'Why you are releasing it.' },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'release_task');
    const slug = taskSlugParam(p.task_id);
    const { outcome, thread } = await releaseTask(ctx, sourceId, slug, agentNameParam(p.agent, 'agent'), stringParam(p.reason, 'reason', { required: true, max: 2_000 }));
    return { task_id: handoffId(slug), status: outcome.result.status, thread_noted: thread.noted, ...(thread.error ? { thread_error: thread.error } : {}),
      revision: outcome.revision, ...(outcome.dryRun ? { dry_run: true } : {}) };
  },
  cliHints: { name: 'release-task', positional: ['task_id'] },
};

const fan_out: Operation = {
  name: 'fan_out',
  mutating: true,
  idempotent: false,
  writeInference: 'async_derived',
  scope: 'write',
  outputRedaction: 'no_stored_text',
  description: 'Send the same task to several agents at once: one sibling task each, all under one thread (created from the title when thread_id is omitted). '
    + 'Compare the results with the user, then record the chosen one with pick_result.',
  params: {
    from_agent: AGENT_PARAM,
    agents: { type: 'array', items: { type: 'string' }, required: true, description: "Two or more agents to send it to, e.g. ['claude', 'chatgpt']." },
    ...TASK_FIELDS,
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'fan_out');
    const fromAgent = agentNameParam(p.from_agent, 'from_agent');
    const agents = [...new Set(stringListParam(p.agents, 'agents', 10).map(a => agentNameParam(a, 'agents')))];
    if (agents.length < 2) throw opError('invalid_params', 'fan_out needs at least two different agents.', 'For one agent use delegate.');
    const result = await fanOut(ctx, sourceId, { ...taskInput(p, fromAgent), agents });
    return { fan_out: result.group, thread_id: handoffId(result.threadSlug), tasks: result.tasks.map(t => ({ task_id: handoffId(t.slug), to_agent: t.task.toAgent })) };
  },
  cliHints: { name: 'fan-out' },
};

const pick_result: Operation = {
  name: 'pick_result',
  mutating: true,
  idempotent: true,
  writeInference: 'async_derived',
  scope: 'write',
  outputRedaction: 'no_stored_text',
  description: "Record which fan-out result the user chose. The pick feeds routing: an agent whose results win is ranked higher next time.",
  params: {
    task_id: TASK_ID_PARAM,
    by: { type: 'string', description: "Who picked, default 'user'." },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'pick_result');
    const slug = taskSlugParam(p.task_id);
    const result = await pickResult(ctx, sourceId, slug, optionalAgentName(p.by, 'by') ?? 'user');
    return { fan_out: result.group, picked: result.picked, agent: result.agent, siblings: result.siblings, changed: result.changed, thread_noted: result.thread.noted };
  },
  cliHints: { name: 'pick-result', positional: ['task_id'] },
};

const route: Operation = {
  name: 'route',
  mutating: false,
  idempotent: true,
  scope: 'read',
  outputRedaction: 'retrieval',
  annotations: { readOnlyHint: true },
  description: 'Rank who should take a task, deterministically (no model call): rules in the routing page (routing.md), which agents are live (recent heartbeat), '
    + 'and past outcomes (completion rate, failures, fan-out wins). Each target carries its reasons. Pass task_id, or tags and task_type.',
  params: {
    task_id: { type: 'string', description: 'Rank targets for an existing task.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Tags of the work to route.' },
    task_type: { type: 'string', description: 'Task type of the work to route.' },
    exclude: { type: 'array', items: { type: 'string' }, description: 'Agents to leave out (e.g. yourself).' },
    limit: { type: 'number', description: 'Targets to return, 1-20 (default 5).' },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'route');
    let tags = tagList(p.tags);
    let taskType = stringParam(p.task_type, 'task_type', { max: 60 }).trim().toLowerCase() || null;
    if (p.task_id !== undefined && p.task_id !== null && p.task_id !== '') {
      const slug = taskSlugParam(p.task_id);
      const page = await readHandoffPage(ctx, sourceId, slug);
      if (!page) throw notFound('task', slug);
      assertHandoffType(page, 'delegation', 'delegation task');
      const task = parseTask(page);
      tags = tags.length ? tags : task.tags;
      taskType = taskType ?? task.taskType;
    }
    const limit = p.limit === undefined ? 5 : Number(p.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw opError('invalid_params', 'limit must be an integer from 1 to 20.', 'Pass limit 5 for the default.');
    const exclude = stringListParam(p.exclude, 'exclude', 20).map(a => agentNameParam(a, 'exclude'));
    const dir = await loadDirectory(ctx, sourceId);
    const targets = rankTargets(dir, { tags, taskType, exclude });
    return { tags, task_type: taskType, targets: targets.slice(0, limit), routing_page: dir.routing.found,
      live_window_minutes: dir.routing.liveWindowMinutes, ...(dir.routing.warnings.length ? { warnings: dir.routing.warnings } : {}) };
  },
  cliHints: { name: 'route' },
};

const routing_stats: Operation = {
  name: 'routing_stats',
  mutating: false,
  idempotent: true,
  scope: 'read',
  outputRedaction: 'no_stored_text',
  annotations: { readOnlyHint: true },
  description: 'Per-agent delegation outcomes from the task pages: assigned, claims, done, failed, released, completion rate, median minutes to claim, and fan-out win rate.',
  params: {
    agent: { type: 'string', description: 'One agent; default every agent seen.' },
    source_id: SOURCE_PARAM,
  },
  handler: async (ctx, p) => {
    const sourceId = await handoffSource(ctx, p, 'routing_stats');
    const dir = await loadDirectory(ctx, sourceId);
    return { agents: statsFor(dir, optionalAgentName(p.agent, 'agent')), tasks: dir.tasks.length };
  },
  cliHints: { name: 'routing-stats', positional: ['agent'] },
};

export const agentDelegationOperations: Operation[] = [
  register_agent, heartbeat, delegate_op, inbox_op, claim_task, complete_task, release_task, fan_out, pick_result, route, routing_stats,
];
