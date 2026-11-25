/**
 * Agent policy reads (L1): policy_check and agent_policy answer "may the agent do this outside
 * action" from the stored, owner-approved policy (src/core/policy/), server-side and derived, and
 * capabilities says which ops this installation and connection can actually call. Writes to the
 * policy are CLI-only (gbrain policy) and owner-confirmed.
 */
import type { Operation, OperationContext } from './contract.ts';
import type { Action } from '../agent-output.ts';
import { AGENT_VERBS, RECIPIENT_CLASSES, isAgentVerb, isRecipientClass } from '../agent-verbs.ts';
import { invalidParam } from './op-fix.ts';
import { parseLimit, type PolicyLimit } from '../policy/fence.ts';
import { callerScopes, checkPolicy, describePolicy } from '../policy/check.ts';
import { ledgerReader, usageLookup } from '../ledger/store.ts';

/** The ops a skill asks about when it names none: the agent-platform verbs. */
export const AGENT_PLATFORM_OPS = ['policy_check', 'agent_policy', 'capabilities'] as const;
const MAX_PROBE_OPS = 50;

function amountParam(ctx: OperationContext, p: Record<string, unknown>): PolicyLimit | undefined {
  if (p.amount === undefined || p.amount === null) return undefined;
  const raw = typeof p.amount === 'number' ? `${p.amount} ${typeof p.currency === 'string' ? p.currency : ''}` : String(p.amount);
  const limit = parseLimit(raw.trim());
  if (!limit) throw invalidParam(ctx, 'policy_check', 'amount', 'Pass amount as a number with currency as a three-letter code (amount 60, currency USD).', { example: 60 });
  if (limit.amount < 0) throw invalidParam(ctx, 'policy_check', 'amount', 'amount must not be negative.', { example: 60 });
  return limit;
}

const policy_check: Operation = {
  name: 'policy_check',
  description: 'Before you send, spend, delete, sign up, call or publish on the user\'s behalf outside this brain, ask whether the user\'s agent policy allows it. Advisory: allow, ask, deny or none (no policy), with requires_approval and any day, week or month budget left. To hold budget for a spend, call policy_reserve instead.',
  params: {
    verb: { type: 'string', required: true, enum: [...AGENT_VERBS], description: 'The outside action.' },
    amount: { type: 'number', description: 'Money involved, with currency.' },
    currency: { type: 'string', description: 'Three-letter currency code for amount, like USD.' },
    merchant: { type: 'string', description: 'Merchant or service, when a rule may name it.' },
    to: { type: 'string', enum: [...RECIPIENT_CLASSES], description: 'Who it reaches: self, household, known or new.' },
  },
  callShape: '{"verb":"spend","amount":60,"currency":"USD","merchant":"acme-example"}',
  scope: 'read',
  mutating: false,
  idempotent: true,
  outputRedaction: { exempt: 'derived decision fields (rule id, revision, state) from the owner-approved policy; no page text' },
  cliHints: { name: 'policy-check', hidden: true },
  annotations: { title: 'policy_check (advisory)', readOnlyHint: true },
  handler: async (ctx: OperationContext, p) => {
    if (!isAgentVerb(p.verb)) throw invalidParam(ctx, 'policy_check', 'verb', `verb must be one of ${AGENT_VERBS.join(', ')}.`, { choices: AGENT_VERBS });
    if (p.to !== undefined && !isRecipientClass(p.to)) throw invalidParam(ctx, 'policy_check', 'to', 'to must be self, household, known or new.', { choices: RECIPIENT_CLASSES });
    const merchant = typeof p.merchant === 'string' && p.merchant.trim() ? p.merchant.trim().slice(0, 200) : undefined;
    const remote = ctx.remote !== false;
    return checkPolicy(ctx.engine, { verb: p.verb, amount: amountParam(ctx, p), merchant, to: p.to as never }, callerScopes(remote), { usage: usageLookup(ctx.engine, ledgerReader(remote, ctx), new Date()) });
  },
};

const agent_policy: Operation = {
  name: 'agent_policy',
  description: 'The user\'s agent policy rules that apply to you, as rows, with its state and revision. Advisory; call policy_check for one action.',
  params: {},
  scope: 'read',
  mutating: false,
  idempotent: true,
  outputRedaction: { exempt: 'the owner-approved rules written for agents to read, as rows; never the page' },
  cliHints: { name: 'agent-policy', hidden: true },
  annotations: { title: 'agent_policy (advisory)', readOnlyHint: true },
  handler: async (ctx: OperationContext) => describePolicy(ctx.engine, callerScopes(ctx.remote !== false)),
};

type CapabilityReason = 'unsupported_build' | 'hidden_listing' | 'surface_ceiling' | 'blocked_grant';

interface CapabilityRow { op: string; served: boolean; listed: boolean; granted: boolean; callable: boolean; reason?: CapabilityReason; discovery?: string; fix?: Action }

const capabilities: Operation = {
  name: 'capabilities',
  description: 'Which gbrain ops this installation serves and this connection can call now, listed or not, with the fix for each one that is not callable.',
  params: {
    ops: { type: 'array', items: { type: 'string' }, description: `Op names to check (default: ${AGENT_PLATFORM_OPS.join(', ')}).` },
  },
  scope: 'read',
  mutating: false,
  idempotent: true,
  agentCallable: true,
  outputRedaction: 'no_stored_text',
  annotations: { title: 'capabilities (what this connection can call)', readOnlyHint: true },
  handler: async (ctx: OperationContext, p) => {
    const wanted = Array.isArray(p.ops) && p.ops.length ? [...new Set(p.ops.map(String))].slice(0, MAX_PROBE_OPS) : [...AGENT_PLATFORM_OPS];
    const { operations } = await import('../operations.ts');
    const { hiddenToolRoute } = await import('../../mcp/hidden-tool-hint.ts');
    const byName = new Map(operations.map(o => [o.name, o]));
    const conn = ctx.remote === false ? null : ctx.toolAccess?.connection();
    let grantFix: Action | null | undefined;
    const grantRepair = async (): Promise<Action | null> => {
      if (grantFix !== undefined) return grantFix;
      if (!ctx.auth) return (grantFix = null);
      try {
        const { resolveGrantDiagnosis, grantRepairAction } = await import('../harness/capabilities.ts');
        grantFix = grantRepairAction(await resolveGrantDiagnosis(ctx.auth, ctx.engine, ctx.config, { surfaceCeiling: ctx.surfaceCeiling }));
      } catch { grantFix = null; } // silent-read-ok: a failed grant diagnosis falls back to the generic regrant fix below, which names the same owner step
      return grantFix;
    };
    const rows: CapabilityRow[] = [];
    for (const name of wanted) {
      const op = byName.get(name);
      if (!op) {
        rows.push({ op: name, served: false, listed: false, granted: false, callable: false, reason: 'unsupported_build',
          fix: { argv: ['gbrain', 'upgrade'], consent: [], actor: ctx.transport === 'http' ? 'host_admin' : 'user', requires_exclusive: false,
            why: `This gbrain build has no ${name} op. Upgrading gbrain on the brain host adds it if a newer release has it.`,
            user_message: `The gbrain on the brain host does not have ${name} yet. Upgrading gbrain there (gbrain upgrade) adds it if a newer release has it.` } });
        continue;
      }
      if (!conn) {
        const local = ctx.remote === false || (ctx.isCallable?.(name) ?? true);
        rows.push({ op: name, served: true, listed: local, granted: true, callable: local });
        continue;
      }
      const route = hiddenToolRoute(op, conn);
      const callable = route?.kind === 'callable';
      const listed = callable && ctx.toolAccess?.isListed ? await ctx.toolAccess.isListed(op) : callable;
      const granted = conn.grantAllows ? conn.grantAllows(op) : true;
      const row: CapabilityRow = { op: name, served: true, listed, granted, callable };
      if (callable && !listed) {
        row.reason = 'hidden_listing';
        row.discovery = `${name} is callable on this connection but not in its tool list: call it by name, or call request_tools {"tools":["${name}"]} for its schema. No grant change is needed.`;
      } else if (route?.kind === 'widen') {
        row.reason = 'hidden_listing';
        row.fix = { mcp: { tool: 'request_tools', arguments: { surface: route.surface } }, consent: [], actor: 'agent', requires_exclusive: false,
          why: `${name} is outside this connection's ${conn.surface ?? 'full'} tool surface; request_tools {"surface":"${route.surface}"} adds it. No grant change is needed.` };
      } else if (route?.kind === 'host' && route.blocker === 'grant') {
        row.reason = 'blocked_grant';
        const repair = await grantRepair();
        row.fix = repair ?? { consent: [], actor: 'host_admin', requires_exclusive: false,
          why: `This credential's grant does not include ${name}; the brain owner can regrant it with gbrain auth on the brain host.`,
          user_message: `This connection's gbrain credential is not allowed to call ${name}. The brain owner can regrant it with gbrain auth on the brain host.` };
      } else if (!callable) {
        row.reason = 'surface_ceiling';
        row.fix = { consent: [], actor: ctx.transport === 'http' ? 'host_admin' : 'user', requires_exclusive: false,
          why: route?.kind === 'host' && route.blocker === 'read_only'
            ? `This connection is read-only, so it cannot call ${name}; that is the host's choice, not a grant problem.`
            : `The server's tool surface does not include ${name} and this connection cannot widen it; the host can serve it with gbrain serve --surface full.`,
          user_message: `The gbrain server does not offer ${name} on this connection. Whoever runs it can start it with --surface full (or set GBRAIN_SURFACE=full in this agent's MCP entry).` };
      }
      rows.push(row);
    }
    return { transport: ctx.remote === false ? 'cli' : ctx.transport ?? 'stdio', ops: rows };
  },
};

export const policyOperations: Operation[] = [policy_check, agent_policy, capabilities];
