/**
 * Deterministic routing: rank delegation targets from the rules in the
 * `routing` page, the agents that are live (recent heartbeat), and past
 * outcomes recorded on delegation pages (completions, failures, releases,
 * fan-out picks). No model is called; the same pages give the same ranking.
 *
 * The routing page (`routing.md`) carries its rules in frontmatter:
 *
 *   rules:
 *     - when: { tags: [deck, design], task_type: listing }
 *       prefer: [claude, model:gpt-5]
 *       fallback: [chatgpt]
 *   live_window_minutes: 90
 *
 * `when.tags` matches when the task has any listed tag; `when.task_type`
 * matches exactly; a rule with no `when` (or `when: default`) always matches.
 * Targets are agent names, or `model:<label>` for any agent on that model.
 */
import type { OperationContext } from '../ops/contract.ts';
import { slugify } from '../entities/resolve.ts';
import { AGENT_PREFIX, DELEGATION_PREFIX, ROUTING_SLUG, parseAgent, parseTask, type AgentState, type TaskState } from './format.ts';
import { handoffId, handoffNow, listHandoffPages, readHandoffPage } from './store.ts';

export const DEFAULT_LIVE_WINDOW_MINUTES = 90;

export interface RoutingRule { index: number; tags: string[]; taskType: string | null; prefer: string[]; fallback: string[] }
export interface RoutingConfig { rules: RoutingRule[]; liveWindowMinutes: number; warnings: string[]; found: boolean }

function targetList(raw: unknown): string[] {
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  return list.filter((v): v is string => typeof v === 'string').map(normalizeTarget).filter((v): v is string => v !== null);
}

/** `claude` → agent target; `model:GPT-5` → `model:gpt-5`. */
export function normalizeTarget(raw: string): string | null {
  const t = raw.trim();
  const m = /^model:\s*(.+)$/i.exec(t);
  if (m) { const label = m[1]!.trim().toLowerCase(); return label ? `model:${label}` : null; }
  const name = slugify(t);
  return name || null;
}

export function parseRoutingConfig(frontmatter: Record<string, unknown> | null): RoutingConfig {
  const warnings: string[] = [];
  if (!frontmatter) return { rules: [], liveWindowMinutes: DEFAULT_LIVE_WINDOW_MINUTES, warnings, found: false };
  const window = Number(frontmatter.live_window_minutes);
  const liveWindowMinutes = Number.isFinite(window) && window >= 1 && window <= 7 * 24 * 60 ? Math.round(window) : DEFAULT_LIVE_WINDOW_MINUTES;
  if (frontmatter.live_window_minutes !== undefined && liveWindowMinutes !== window) warnings.push(`live_window_minutes ${String(frontmatter.live_window_minutes)} is not 1-10080; using ${liveWindowMinutes}.`);
  const rawRules = Array.isArray(frontmatter.rules) ? frontmatter.rules : [];
  if (frontmatter.rules !== undefined && !Array.isArray(frontmatter.rules)) warnings.push('rules must be a list; no rule applied.');
  const rules: RoutingRule[] = [];
  rawRules.forEach((r, index) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { warnings.push(`rule ${index + 1} is not a mapping; skipped.`); return; }
    const rule = r as Record<string, unknown>;
    const when = rule.when ?? rule.match;
    let tags: string[] = [];
    let taskType: string | null = null;
    if (when && typeof when === 'object' && !Array.isArray(when)) {
      const w = when as Record<string, unknown>;
      tags = (typeof w.tags === 'string' ? [w.tags] : Array.isArray(w.tags) ? w.tags : []).filter((t): t is string => typeof t === 'string').map(t => t.trim().toLowerCase()).filter(Boolean);
      taskType = typeof w.task_type === 'string' && w.task_type.trim() ? w.task_type.trim().toLowerCase() : null;
    } else if (when !== undefined && when !== 'default') {
      warnings.push(`rule ${index + 1} has an unreadable when; skipped.`); return;
    }
    const prefer = targetList(rule.prefer);
    const fallback = targetList(rule.fallback);
    if (!prefer.length && !fallback.length) { warnings.push(`rule ${index + 1} names no prefer or fallback target; skipped.`); return; }
    rules.push({ index: index + 1, tags, taskType, prefer, fallback });
  });
  return { rules, liveWindowMinutes, warnings, found: true };
}

export function ruleMatches(rule: RoutingRule, task: { tags: string[]; taskType: string | null }): boolean {
  const tags = task.tags.map(t => t.toLowerCase());
  if (rule.tags.length && !rule.tags.some(t => tags.includes(t))) return false;
  if (rule.taskType && rule.taskType !== (task.taskType ?? '').toLowerCase()) return false;
  return true;
}

/** A task addressed to `toModel` matches an agent on that model, or on a more specific label of it (`claude` ⊃ `claude-opus-5-5`). */
export function modelMatches(toModel: string, agentModel: string | null): boolean {
  if (!agentModel) return false;
  const want = toModel.trim().toLowerCase();
  const have = agentModel.trim().toLowerCase();
  return have === want || have.startsWith(`${want}-`) || have.startsWith(`${want} `) || have.startsWith(`${want}/`);
}

// ── stats ──────────────────────────────────────────────────────────────────

export interface AgentStats {
  agent: string;
  assigned: number;
  claims: number;
  done: number;
  failed: number;
  released: number;
  open_now: number;
  completion_rate: number | null;
  median_time_to_claim_minutes: number | null;
  fan_out: { tasks: number; completed: number; picked_groups: number; wins: number; win_rate: number | null };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const round = (v: number, places = 3) => Math.round(v * 10 ** places) / 10 ** places;

/** Per-agent outcomes from delegation pages: the log records every claim, release, completion and failure. */
export function computeStats(tasks: TaskState[], agentNames: string[]): Map<string, AgentStats> {
  const acc = new Map<string, { assigned: number; claims: number; done: number; failed: number; released: number; openNow: number; ttc: number[];
    fanTasks: number; fanDone: number; pickedGroups: number; wins: number }>();
  const get = (a: string) => {
    let s = acc.get(a);
    if (!s) { s = { assigned: 0, claims: 0, done: 0, failed: 0, released: 0, openNow: 0, ttc: [], fanTasks: 0, fanDone: 0, pickedGroups: 0, wins: 0 }; acc.set(a, s); }
    return s;
  };
  for (const name of agentNames) get(name);
  const pickedGroups = new Set(tasks.filter(t => t.fanOut && t.picked === true).map(t => t.fanOut!));
  for (const t of tasks) {
    if (t.toAgent) {
      const s = get(t.toAgent);
      s.assigned++;
      if (t.status === 'open' || t.status === 'released') s.openNow++;
    }
    const seenClaim = new Set<string>();
    for (const e of t.log) {
      if (e.event === 'claimed') {
        const s = get(e.agent);
        s.claims++;
        if (!seenClaim.has(e.agent)) {
          seenClaim.add(e.agent);
          const minutes = (Date.parse(e.at) - Date.parse(t.createdAt)) / 60_000;
          if (Number.isFinite(minutes) && minutes >= 0) s.ttc.push(minutes);
        }
      } else if (e.event === 'released') get(e.agent).released++;
      else if (e.event === 'completed') get(e.agent).done++;
      else if (e.event === 'failed') get(e.agent).failed++;
    }
    if (t.fanOut && t.toAgent) {
      const s = get(t.toAgent);
      s.fanTasks++;
      if (t.status === 'done') {
        s.fanDone++;
        if (pickedGroups.has(t.fanOut)) s.pickedGroups++;
        if (t.picked === true) s.wins++;
      }
    }
  }
  const out = new Map<string, AgentStats>();
  for (const [agent, s] of [...acc.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const finished = s.done + s.failed + s.released;
    const ttc = median(s.ttc);
    out.set(agent, {
      agent, assigned: s.assigned, claims: s.claims, done: s.done, failed: s.failed, released: s.released, open_now: s.openNow,
      completion_rate: finished ? round(s.done / finished) : null,
      median_time_to_claim_minutes: ttc === null ? null : round(ttc, 1),
      fan_out: { tasks: s.fanTasks, completed: s.fanDone, picked_groups: s.pickedGroups, wins: s.wins, win_rate: s.pickedGroups ? round(s.wins / s.pickedGroups) : null },
    });
  }
  return out;
}

// ── route ──────────────────────────────────────────────────────────────────

export interface RouteTarget {
  target: string;
  kind: 'agent' | 'model';
  agent: string | null;
  model: string | null;
  score: number;
  live: boolean | null;
  reasons: string[];
  reason: string;
}

export interface RouteInput { tags: string[]; taskType: string | null; exclude?: string[] }

export interface HandoffDirectory {
  agents: AgentState[];
  tasks: Array<{ slug: string; task: TaskState }>;
  routing: RoutingConfig;
}

export async function loadDirectory(ctx: OperationContext, sourceId: string): Promise<HandoffDirectory> {
  const [agentPages, taskPages, routingPage] = await Promise.all([
    listHandoffPages(ctx, sourceId, 'agent', AGENT_PREFIX),
    listHandoffPages(ctx, sourceId, 'delegation', DELEGATION_PREFIX),
    readHandoffPage(ctx, sourceId, ROUTING_SLUG),
  ]);
  return {
    agents: agentPages.map(p => parseAgent(handoffId(p.slug), p)),
    tasks: taskPages.map(p => ({ slug: p.slug, task: parseTask(p) })),
    routing: parseRoutingConfig(routingPage ? routingPage.frontmatter : null),
  };
}

const RULE_PREFER = 100;
const RULE_PREFER_STEP = 10;
const RULE_FALLBACK = 40;
const RULE_FALLBACK_STEP = 5;
const LIVE_BONUS = 30;
const STALE_PENALTY = -40;
const NEVER_SEEN_PENALTY = -60;
const COMPLETION_WEIGHT = 20;
const WIN_WEIGHT = 15;
const FAILURE_PENALTY = 5;
const FAILURE_PENALTY_CAP = 25;
const CAPABILITY_BONUS = 10;

function minutesAgo(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60_000)) : null;
}

/**
 * Ranked targets for a task. Each registered agent and each rule target is a
 * candidate; a `model:` rule target expands to the agents on that model and
 * stays as a model target of its own (any agent on it may claim). Ties break
 * by name, so the ranking is stable.
 */
export function rankTargets(dir: HandoffDirectory, input: RouteInput): RouteTarget[] {
  const now = handoffNow().getTime();
  const stats = computeStats(dir.tasks.map(t => t.task), dir.agents.map(a => a.name));
  const byName = new Map(dir.agents.map(a => [a.name, a]));
  const cands = new Map<string, { kind: 'agent' | 'model'; score: number; reasons: string[] }>();
  const cand = (target: string) => {
    let c = cands.get(target);
    if (!c) { c = { kind: target.startsWith('model:') ? 'model' : 'agent', score: 0, reasons: [] }; cands.set(target, c); }
    return c;
  };
  for (const a of dir.agents) cand(a.name);
  const ruleHits = new Map<string, number>();
  for (const rule of dir.routing.rules) {
    if (!ruleMatches(rule, input)) continue;
    const label = rule.tags.length || rule.taskType
      ? `rule ${rule.index} (${[rule.tags.length ? `tags ${rule.tags.join('/')}` : '', rule.taskType ? `task_type ${rule.taskType}` : ''].filter(Boolean).join(', ')})`
      : `rule ${rule.index} (default)`;
    const award = (target: string, points: number, how: string) => {
      const prior = ruleHits.get(target) ?? 0;
      if (points <= prior) return;
      const c = cand(target);
      c.score += points - prior;
      ruleHits.set(target, points);
      c.reasons.push(`${label}: ${how}`);
      if (target.startsWith('model:')) {
        const model = target.slice('model:'.length);
        for (const a of dir.agents) if (modelMatches(model, a.model)) award(a.name, points - 1, `${how} via model ${model}`);
      }
    };
    rule.prefer.forEach((t, i) => award(t, RULE_PREFER - i * RULE_PREFER_STEP, `preferred #${i + 1}`));
    rule.fallback.forEach((t, i) => award(t, RULE_FALLBACK - i * RULE_FALLBACK_STEP, `fallback #${i + 1}`));
  }
  const tags = input.tags.map(t => t.toLowerCase());
  const out: RouteTarget[] = [];
  for (const [target, c] of cands) {
    if (input.exclude?.includes(target)) continue;
    let live: boolean | null = null;
    if (c.kind === 'agent') {
      const agent = byName.get(target);
      const age = minutesAgo(agent?.lastHeartbeat ?? null, now);
      if (!agent) { c.score += NEVER_SEEN_PENALTY; c.reasons.push('not registered'); live = false; }
      else if (age === null) { c.score += NEVER_SEEN_PENALTY; c.reasons.push('no heartbeat yet'); live = false; }
      else if (age <= dir.routing.liveWindowMinutes) { c.score += LIVE_BONUS; c.reasons.push(`live (heartbeat ${age}m ago)`); live = true; }
      else { c.score += STALE_PENALTY; c.reasons.push(`stale (heartbeat ${age}m ago)`); live = false; }
      const s = stats.get(target);
      if (s && s.completion_rate !== null) {
        c.score += COMPLETION_WEIGHT * s.completion_rate;
        c.reasons.push(`completed ${s.done}/${s.done + s.failed + s.released} finished tasks`);
      }
      if (s && s.fan_out.win_rate !== null) {
        c.score += WIN_WEIGHT * s.fan_out.win_rate;
        c.reasons.push(`won ${s.fan_out.wins}/${s.fan_out.picked_groups} fan-out picks`);
      }
      if (s && s.failed) {
        c.score -= Math.min(FAILURE_PENALTY_CAP, FAILURE_PENALTY * s.failed);
        c.reasons.push(`${s.failed} failed`);
      }
      const caps = agent?.capabilities.map(x => x.toLowerCase()) ?? [];
      const shared = tags.filter(t => caps.includes(t));
      if (shared.length) { c.score += CAPABILITY_BONUS * shared.length; c.reasons.push(`capabilities ${shared.join(', ')}`); }
    } else {
      const model = target.slice('model:'.length);
      const onModel = dir.agents.filter(a => modelMatches(model, a.model));
      const liveOn = onModel.filter(a => { const age = minutesAgo(a.lastHeartbeat, now); return age !== null && age <= dir.routing.liveWindowMinutes; });
      live = liveOn.length > 0;
      c.reasons.push(liveOn.length ? `${liveOn.length} live agent(s) on this model` : onModel.length ? 'no live agent on this model' : 'no registered agent on this model');
      if (!live) c.score += onModel.length ? STALE_PENALTY : NEVER_SEEN_PENALTY;
    }
    const agent = c.kind === 'agent' ? target : null;
    out.push({ target, kind: c.kind, agent, model: c.kind === 'model' ? target.slice('model:'.length) : byName.get(target)?.model ?? null,
      score: round(c.score, 2), live, reasons: c.reasons, reason: c.reasons.join('; ') || 'registered agent' });
  }
  out.sort((a, b) => b.score - a.score || a.target.localeCompare(b.target));
  return out;
}

export function statsFor(dir: HandoffDirectory, agent: string | null): AgentStats[] {
  const stats = computeStats(dir.tasks.map(t => t.task), dir.agents.map(a => a.name));
  return agent ? [stats.get(agent) ?? computeStats([], [agent]).get(agent)!] : [...stats.values()];
}
