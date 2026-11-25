/**
 * policy_check and agent_policy answers (derived fields only). The policy page is forced private,
 * so it is read server-side and a caller sees the decision, the rule id, the served revision, the
 * policy state and the rules that apply to it, never the page.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import type { AgentVerb, RecipientClass } from '../agent-verbs.ts';
import { currentCallerAccess } from '../search/private-visibility.ts';
import { evaluatePolicy, stricterVerdict, type PolicyQuery, type PolicyVerdict } from './evaluate.ts';
import { formatLimit, type PolicyLimit, type PolicyRule } from './fence.ts';
import { CHANGE_NOTICE_MS, resolvePolicy, type PolicyScope, type PolicyState, type ServedPolicy } from './store.ts';

export const POLICY_ENFORCEMENT = 'advisory' as const;
export const HARNESS_APPROVALS_LINE = 'Advice only: keep following your harness\'s own approvals, and ask the user whenever the decision is ask.';

const STATE_RANK: Record<PolicyState, number> = { none: 0, ok: 1, changed_outside_gbrain: 2, unapproved: 3, malformed: 4 };

/**
 * The scopes this request reads. Local callers, owner credentials and unbound credentials (no audience, identity or
 * actor) read both. Every other remote caller (a member, a group, a guest, a several-member audience) reads only the
 * company policy, because the owner's policy page is private.
 */
export function callerScopes(remote: boolean): PolicyScope[] {
  if (!remote) return ['owner', 'company'];
  const access = currentCallerAccess();
  const unbound = access.audience === null && access.identity.length === 0 && !access.actor;
  return access.owner || unbound ? ['owner', 'company'] : ['company'];
}

export interface ScopeView {
  scope: PolicyScope;
  policy_state: PolicyState;
  policy_revision: string | null;
  authoritative: boolean;
  parse_error?: { line: number; column: number; message: string };
  foreign?: { revision: string; author: string };
}

function scopeView(p: ServedPolicy): ScopeView {
  return {
    scope: p.scope, policy_state: p.state, policy_revision: p.served_revision, authoritative: p.authoritative,
    ...(p.parse_error ? { parse_error: p.parse_error } : {}), ...(p.foreign ? { foreign: p.foreign } : {}),
  };
}

/** The one next step a non-ok state carries: always a read the agent can run, or the owner's accept. */
export function stateFix(p: ServedPolicy): Action | null {
  if (p.state === 'malformed') return { argv: ['gbrain', 'policy', 'show', '--check'], consent: [], actor: 'agent', requires_exclusive: false,
    why: `The ${p.scope} policy page is malformed at line ${p.parse_error?.line}, column ${p.parse_error?.column}, so ${p.authoritative ? 'agents still get the last approved revision' : 'every outside action answers ask'} until it is fixed.` };
  if (p.state === 'changed_outside_gbrain' && p.foreign && p.foreign.revision !== 'deleted') return {
    argv: ['gbrain', 'policy', 'accept', p.foreign.revision, ...(p.scope === 'company' ? ['--scope', 'company'] : [])], consent: [], actor: 'user', requires_exclusive: false,
    why: `The ${p.scope} policy page was changed outside gbrain (revision ${p.foreign.revision}, by ${p.foreign.author}); agents still get the last approved revision.`,
    user_message: 'Review the change, then run this in your own terminal, outside the agent session, to approve it: '
      + `gbrain policy accept ${p.foreign.revision}${p.scope === 'company' ? ' --scope company' : ''}` };
  if (p.state === 'unapproved') return { argv: ['gbrain', 'policy', 'show'], consent: [], actor: 'agent', requires_exclusive: false,
    why: `The ${p.scope} policy page has no owner approval, so every outside action answers ask until the owner accepts it.` };
  return null;
}

export interface PolicyCheckInput { verb: AgentVerb; amount?: PolicyLimit; merchant?: string; to?: RecipientClass }

export interface PolicyCheckAnswer {
  decision: 'allow' | 'ask' | 'deny' | 'none';
  rule_id: string | null;
  scope: PolicyScope | null;
  policy_revision: string | null;
  policy_state: PolicyState;
  enforcement: typeof POLICY_ENFORCEMENT;
  reason: string;
  note: string;
  scopes: ScopeView[];
  fix?: Action;
}

export async function checkPolicy(engine: BrainEngine, q: PolicyCheckInput, scopes: PolicyScope[]): Promise<PolicyCheckAnswer> {
  const served = await Promise.all(scopes.map(s => resolvePolicy(engine, s)));
  const live = served.filter(p => p.state !== 'none');
  const worst = served.reduce<ServedPolicy | null>((a, b) => (!a || STATE_RANK[b.state] > STATE_RANK[a.state] ? b : a), null);
  const fix = worst ? stateFix(worst) : null;
  const common = { enforcement: POLICY_ENFORCEMENT, note: HARNESS_APPROVALS_LINE, scopes: served.map(scopeView), policy_state: worst?.state ?? 'none' as PolicyState, ...(fix ? { fix } : {}) };
  if (!live.length) {
    return { decision: 'none', rule_id: null, scope: null, policy_revision: null, reason: 'No agent policy is set: follow your harness\'s own approvals.', ...common };
  }
  let best: (PolicyVerdict & { scope: PolicyScope; revision: string | null }) | null = null;
  for (const p of live) {
    const verdict: PolicyVerdict = p.authoritative
      ? evaluatePolicy(p.rules, q as PolicyQuery)
      : { decision: 'ask', rule_id: null, reason: p.state === 'malformed' ? `the ${p.scope} policy is malformed, so every outside action asks` : `the ${p.scope} policy has no owner approval, so every outside action asks` };
    const scoped = { ...verdict, scope: p.scope, revision: p.served_revision };
    best = best ? (stricterVerdict(best, verdict) === best ? best : scoped) : scoped;
  }
  return { decision: best!.decision, rule_id: best!.rule_id, scope: best!.scope, policy_revision: best!.revision, reason: best!.reason, ...common };
}

export interface RuleRow { scope: PolicyScope; id: string; verb: string; decision: string; when: string | null; limit: string | null; window: string | null; merchant: string | null; note: string | null }

function ruleRow(scope: PolicyScope, r: PolicyRule): RuleRow {
  return { scope, id: r.id, verb: r.verb, decision: r.decision, when: r.when ?? null, limit: r.limit ? formatLimit(r.limit) : null, window: r.window ?? null, merchant: r.merchant ?? null, note: r.note ?? null };
}

/** agent_policy: per scope the state, the served revision and the approved rules that apply, as rows. */
export async function describePolicy(engine: BrainEngine, scopes: PolicyScope[]) {
  const served = await Promise.all(scopes.map(s => resolvePolicy(engine, s)));
  const worst = served.reduce<ServedPolicy | null>((a, b) => (!a || STATE_RANK[b.state] > STATE_RANK[a.state] ? b : a), null);
  const fix = worst ? stateFix(worst) : null;
  return {
    policy_state: worst?.state ?? 'none',
    enforcement: POLICY_ENFORCEMENT,
    note: served.some(p => p.state !== 'none') ? HARNESS_APPROVALS_LINE : 'No agent policy is set: follow your harness\'s own approvals.',
    scopes: served.map(scopeView),
    rules: served.filter(p => p.authoritative).flatMap(p => p.rules.map(r => ruleRow(p.scope, r))),
    default_decision: served.some(p => p.state !== 'none') ? 'ask' : 'none',
    ...(fix ? { fix } : {}),
  };
}

/**
 * The policy line context_pack carries until the session-start delivery ledger lands: the state
 * when it is not ok, and the newest owner-confirmed change for a week, read from the approval's
 * stored proof (never from the config key alone).
 */
export async function policyStateForPack(engine: BrainEngine, remote: boolean, now = Date.now()): Promise<{ policy_state: Record<string, unknown> } | null> {
  const served = await Promise.all(callerScopes(remote).map(s => resolvePolicy(engine, s)));
  const live = served.filter(p => p.state !== 'none');
  if (!live.length) return null;
  const changed = live
    .filter(p => p.approval && now - Date.parse(p.approval.proof.at) < CHANGE_NOTICE_MS)
    .sort((a, b) => Date.parse(b.approval!.proof.at) - Date.parse(a.approval!.proof.at))[0];
  const worst = live.reduce((a, b) => (STATE_RANK[b.state] > STATE_RANK[a.state] ? b : a));
  const how = (m: string) => (m === 'terminal' ? 'confirmed in a terminal' : 'approved in the owner session');
  const notice = changed
    ? `Your agent policy changed: ${changed.approval!.change} by ${changed.approval!.proof.by} (${how(changed.approval!.proof.method)}, ${changed.approval!.proof.at.slice(0, 10)}).`
    : null;
  const fix = stateFix(worst);
  return { policy_state: { state: worst.state, enforcement: POLICY_ENFORCEMENT, scopes: live.map(scopeView), ...(notice ? { notice } : {}), ...(fix ? { fix: fix.why } : {}) } };
}
