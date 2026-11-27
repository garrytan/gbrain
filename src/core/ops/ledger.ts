/**
 * Action ledger ops (L2): log_action records an outside action an agent took (or moves a proposed
 * one on), ledger reads the caller's totals, and policy_reserve checks the agent policy with its
 * budget windows and holds the amount in one locked step. Advisory, like the policy: a budget is
 * shown as advice, never enforced.
 */
import type { Operation, OperationContext } from './contract.ts';
import { AGENT_VERBS, RECIPIENT_CLASSES, SPEND_PURPOSES, isAgentVerb, isRecipientClass } from '../agent-verbs.ts';
import { invalidParam } from './op-fix.ts';
import { parseLimit } from '../policy/fence.ts';
import { ACTION_STATUSES, APPROVERS, SAVED_PERIODS } from '../ledger/action.ts';
import { ledgerReader, ledgerReport, logAction, parseSince, policyReserve, type LogActionInput } from '../ledger/store.ts';

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

function verbOf(ctx: OperationContext, tool: string, v: unknown) {
  if (!isAgentVerb(v)) throw invalidParam(ctx, tool, 'verb', `verb must be one of ${AGENT_VERBS.join(', ')}.`, { choices: AGENT_VERBS });
  return v;
}

const log_action: Operation = {
  name: 'log_action',
  description: 'After you act on the user\'s behalf outside this brain (send, spend, cancel, sign up...), record it. An amount needs evidence (the slug of a saved page that shows it) or estimated: true. Pass action_id to settle a policy_reserve hold or move a proposed action on. Keep request_id and retry with the same arguments.',
  params: {
    verb: { type: 'string', required: true, enum: [...AGENT_VERBS], description: 'The outside action.' },
    summary: { type: 'string', description: 'What was done, at most 200 characters (required for a new action).' },
    status: { type: 'string', enum: [...ACTION_STATUSES], description: 'Default done.' },
    purpose: { type: 'string', enum: [...SPEND_PURPOSES], description: 'For spend: buy or pay.' },
    counterparty: { type: 'string', description: 'The merchant, service or person on the other side.' },
    harness: { type: 'string', description: 'The agent or harness that acted.' },
    at: { type: 'string', description: 'When it happened (ISO time; default now).' },
    currency: { type: 'string', description: 'Three-letter code for spent or saved.' },
    spent: { type: 'number', description: 'Money spent.' },
    saved: { type: 'number', description: 'Money saved, with saved_period.' },
    saved_period: { type: 'string', enum: [...SAVED_PERIODS], description: 'one_time, monthly or yearly (never annualized).' },
    estimated: { type: 'boolean', description: 'true when the amount is an estimate with no evidence.' },
    minutes_saved: { type: 'number', description: 'Estimated minutes saved (recorded, never totalled).' },
    evidence: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, note: { type: 'string' } } }, description: 'Refs to evidence: a page slug (counts as evidence when you can read it) or a URL.' },
    approval_by: { type: 'string', enum: [...APPROVERS], description: 'Who approved it: owner, policy or none.' },
    approval_rule: { type: 'string', description: 'The policy rule id that allowed it.' },
    policy_revision: { type: 'string', description: 'The policy revision policy_check returned.' },
    cost_usd: { type: 'number', description: 'What the agent run cost, as reported by the harness.' },
    supersedes: { type: 'string', description: 'The action_id this entry corrects.' },
    action_id: { type: 'string', description: 'An action you logged or reserved, to move it on (settles a hold).' },
    request_id: { type: 'string', description: 'A UUID; reuse it only to replay the same call.' },
  },
  callShape: '{"verb":"cancel","summary":"Cancelled the acme-example trial","counterparty":"acme-example","saved":12,"currency":"USD","saved_period":"monthly","evidence":[{"ref":"inbox/acme-example-cancel"}],"request_id":"<uuid>"}',
  scope: 'write',
  mutating: true,
  idempotent: true,
  outputRedaction: { exempt: 'derived ledger fields (action id, status, claim basis, which evidence refs resolved); no page text' },
  cliHints: { name: 'log-action', hidden: true },
  annotations: { title: 'log_action (action ledger)' },
  handler: async (ctx, p) => {
    const verb = verbOf(ctx, 'log_action', p.verb);
    if (ctx.dryRun) return { dry_run: true, action: 'log_action', verb };
    const evidence = Array.isArray(p.evidence) ? p.evidence.map(e => (typeof e === 'string' ? { ref: e } : e)) as LogActionInput['evidence'] : undefined;
    return logAction(ctx, {
      verb, summary: str(p.summary), status: p.status as LogActionInput['status'], purpose: p.purpose as LogActionInput['purpose'],
      counterparty: str(p.counterparty), harness: str(p.harness), at: str(p.at), currency: str(p.currency), spent: num(p.spent), saved: num(p.saved),
      saved_period: p.saved_period as LogActionInput['saved_period'], estimated: typeof p.estimated === 'boolean' ? p.estimated : undefined,
      minutes_saved: num(p.minutes_saved), evidence, approval_by: p.approval_by as LogActionInput['approval_by'], approval_rule: str(p.approval_rule),
      policy_revision: str(p.policy_revision), cost_usd: num(p.cost_usd), supersedes: str(p.supersedes), action_id: str(p.action_id), request_id: str(p.request_id),
    });
  },
};

const ledger: Operation = {
  name: 'ledger',
  description: 'Totals of the outside actions you can read for a window: spent and saved per currency, split by evidenced, user_confirmed and estimated, by verb and by counterparty, plus live budget holds. Computed by gbrain; a window too large to read returns state partial and the narrower call.',
  params: {
    since: { type: 'string', description: 'Start: <n>d (default 30d) or an ISO date, at most 3660 days back.' },
    verb: { type: 'string', enum: [...AGENT_VERBS], description: 'Only this verb.' },
    counterparty: { type: 'string', description: 'Only this counterparty.' },
  },
  scope: 'read',
  mutating: false,
  idempotent: true,
  outputRedaction: { exempt: 'derived totals over actions the caller can read; no page text' },
  cliHints: { name: 'ledger-totals', hidden: true },
  annotations: { title: 'ledger (action totals)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const now = new Date();
    const since = parseSince(p.since, now);
    if (!since) throw invalidParam(ctx, 'ledger', 'since', 'since must be a number of days like 30d, or an ISO date.', { example: '30d' });
    if (p.verb !== undefined) verbOf(ctx, 'ledger', p.verb);
    return ledgerReport(ctx.engine, ledgerReader(ctx.remote !== false, ctx), { since, until: new Date(now.getTime() + 1), verb: p.verb as never, counterparty: str(p.counterparty) }, now);
  },
};

const policy_reserve: Operation = {
  name: 'policy_reserve',
  description: 'Before a spend, check the agent policy with its day, week and month budgets and hold the amount for 24 hours, in one step, so two agents cannot both use the last of a budget. Returns the policy_check answer and the reservation; settle it with log_action {action_id, status: "done", spent} after you act (with no amount the held amount is recorded as an estimate). A deny holds nothing.',
  params: {
    verb: { type: 'string', required: true, enum: [...AGENT_VERBS], description: 'The outside action.' },
    amount: { type: 'number', required: true, description: 'The amount to hold.' },
    currency: { type: 'string', required: true, description: 'Three-letter currency code, like USD.' },
    summary: { type: 'string', required: true, description: 'What the agent is about to do, at most 200 characters.' },
    merchant: { type: 'string', description: 'Merchant or service, when a rule may name it.' },
    to: { type: 'string', enum: [...RECIPIENT_CLASSES], description: 'Who it reaches: self, household, known or new.' },
    purpose: { type: 'string', enum: [...SPEND_PURPOSES], description: 'For spend: buy or pay.' },
    harness: { type: 'string', description: 'The agent or harness that will act.' },
    request_id: { type: 'string', description: 'A UUID; reuse it only to replay the same call.' },
  },
  callShape: '{"verb":"spend","amount":40,"currency":"USD","merchant":"acme-example","summary":"Reorder printer ink","request_id":"<uuid>"}',
  scope: 'write',
  mutating: true,
  idempotent: true,
  outputRedaction: { exempt: 'derived decision and budget fields from the owner-approved policy and the caller\'s readable actions; no page text' },
  cliHints: { name: 'policy-reserve', hidden: true },
  annotations: { title: 'policy_reserve (advisory budget hold)' },
  handler: async (ctx, p) => {
    const verb = verbOf(ctx, 'policy_reserve', p.verb);
    const amount = typeof p.amount === 'number' ? parseLimit(`${p.amount} ${typeof p.currency === 'string' ? p.currency : ''}`) : null;
    if (!amount) throw invalidParam(ctx, 'policy_reserve', 'amount', 'Pass amount as a number with currency as a three-letter code (amount 40, currency USD).', { example: 40 });
    if (p.to !== undefined && !isRecipientClass(p.to)) throw invalidParam(ctx, 'policy_reserve', 'to', 'to must be self, household, known or new.', { choices: RECIPIENT_CLASSES });
    const summary = str(p.summary);
    if (!summary) throw invalidParam(ctx, 'policy_reserve', 'summary', 'summary is required.', { example: 'Reorder printer ink' });
    if (ctx.dryRun) return { dry_run: true, action: 'policy_reserve', verb };
    return policyReserve(ctx, { verb, amount, summary, merchant: str(p.merchant)?.slice(0, 200), to: p.to as never, purpose: p.purpose as never, harness: str(p.harness), request_id: str(p.request_id) });
  },
};

export const ledgerOperations: Operation[] = [log_action, ledger, policy_reserve];
