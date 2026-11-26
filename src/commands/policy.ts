/**
 * gbrain policy: the owner's agent policy (decision F1). Every write is owner-confirmed: a
 * terminal prompt in a process with no agent marker, or the owner session. Reads mirror the
 * policy_check and agent_policy ops.
 *
 *   gbrain policy init [--preset <name>] [--scope owner|company]
 *   gbrain policy show [--check] [--scope owner|company] [--json]
 *   gbrain policy allow|ask|deny <verb> [--amount 60 --currency USD | --amount 60USD] [--merchant <m>] [--to self|household|known|new] [--window per_action|day|week|month] [--id <rule-id>] [--note <text>] [--scope owner|company]
 *   gbrain policy edit [--scope owner|company]
 *   gbrain policy accept <revision> [--scope owner|company]
 *   gbrain policy check <verb> [--amount 60 --currency USD] [--merchant <m>] [--to <class>] [--json]
 *   gbrain policy presets [--json]
 *   gbrain policy status [--json]
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { setCliExitVerdict, spawnCliChild } from '../core/cli-force-exit.ts';
import { rethrowCapabilityRefusal } from '../core/engine-capability-refusal.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { AGENT_VERBS, isAgentVerb, isRecipientClass } from '../core/agent-verbs.ts';
import { formatLimit, parseLimit, parsePolicyFence, POLICY_WINDOWS, renderPolicyFence, type PolicyDecision, type PolicyLimit, type PolicyRule, type PolicyWindow } from '../core/policy/fence.ts';
import { ledgerReader, usageLookup } from '../core/ledger/store.ts';
import { DEFAULT_PRESET, POLICY_PRESETS, findPreset } from '../core/policy/presets.ts';
import { acceptRevision, applyPolicyChange, POLICY_SCOPES, POLICY_SLUGS, renderPolicyPage, resolvePolicy, type PolicyScope } from '../core/policy/store.ts';
import { checkPolicy, describePolicy, stateFix } from '../core/policy/check.ts';
import { confirmRequiredError, terminalAuthorityProblem } from '../core/policy/authority.ts';

export function usage(): string {
  return [
    'Usage: gbrain policy <subcommand>',
    '',
    'The agent policy says when an agent may send, spend, delete, sign up, call or publish on your behalf',
    'outside this brain. It is advice agents check with policy_check; your harness keeps its own approvals.',
    'Every change asks you, in your own terminal, to type a short code.',
    '',
    '  init [--preset <name>] [--scope owner|company]       write a preset (default ask-all); gbrain policy presets lists them',
    '  show [--check] [--scope owner|company] [--json]     the policy agents are served; --check validates the page',
    '  allow|ask|deny <verb> [--amount 60 --currency USD] [--merchant <m>] [--to self|household|known|new]',
    '                [--window per_action|day|week|month] [--id <rule-id>] [--note <text>] [--scope owner|company]',
    '                                                       add or replace one rule, e.g. gbrain policy allow spend --amount 25 --currency USD',
    '  edit [--scope owner|company]                         edit the rules table in $EDITOR (needs a terminal)',
    '  accept <revision> [--scope owner|company]            approve a revision changed outside gbrain, after reviewing it',
    '  check <verb> [--amount 60 --currency USD] [--merchant <m>] [--to <class>] [--json]',
    '                                                       what policy_check answers, e.g. gbrain policy check send --to new',
    '  presets [--json]                                     the named presets',
    '  status [--json]                                      the state, and when each client last fetched the policy',
    '',
    `Verbs: ${AGENT_VERBS.join(', ')}.`,
  ].join('\n');
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function scopeOf(args: string[]): PolicyScope {
  const s = flag(args, '--scope') ?? 'owner';
  if (!(POLICY_SCOPES as readonly string[]).includes(s)) throw opError('invalid_params', `--scope must be owner or company, not ${s}.`, 'Pass --scope owner or --scope company.');
  return s as PolicyScope;
}

/** `--amount 60 --currency USD` or one `--amount 60USD` token. */
function amountOf(args: string[]): PolicyLimit | undefined {
  const raw = flag(args, '--amount');
  if (raw === undefined) return undefined;
  const limit = parseLimit(`${raw}${flag(args, '--currency') ? ` ${flag(args, '--currency')}` : ''}`);
  if (!limit) throw opError('invalid_params', `--amount ${raw} needs a currency.`, 'Pass --amount 60 --currency USD, or one token: --amount 60USD.');
  return limit;
}

function verbOf(value: string | undefined): (typeof AGENT_VERBS)[number] {
  if (!isAgentVerb(value)) throw opError('invalid_params', `Unknown verb ${value ?? '(none)'}.`, `Pass one of: ${AGENT_VERBS.join(', ')}.`);
  return value;
}

export function ruleFromArgs(decision: PolicyDecision, args: string[]): PolicyRule {
  const verb = verbOf(args[0]);
  const to = flag(args, '--to');
  if (to !== undefined && !isRecipientClass(to)) throw opError('invalid_params', `--to must be self, household, known or new, not ${to}.`, 'Pass --to self|household|known|new.');
  const window = flag(args, '--window');
  if (window !== undefined && !(POLICY_WINDOWS as readonly string[]).includes(window)) throw opError('invalid_params', `--window must be per_action, day, week or month, not ${window}.`, 'Pass --window per_action (one action) or day, week or month (a budget) with --amount.');
  const limit = amountOf(args);
  if (window && !limit) throw opError('invalid_params', '--window needs --amount.', 'Pass --amount 60 --currency USD with --window.');
  const merchant = flag(args, '--merchant');
  const note = flag(args, '--note');
  const id = flag(args, '--id') ?? [verb, merchant ?? '', to ?? '', limit ? `upto-${limit.amount}${limit.currency}` : '', window && window !== 'per_action' ? `per-${window}` : ''].filter(Boolean).join('-')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 64).replace(/^-+|-+$/g, '');
  const rule: PolicyRule = { id, verb, decision, ...(to ? { when: to } : {}), ...(limit ? { limit } : {}), ...(window ? { window: window as PolicyWindow } : {}), ...(merchant ? { merchant } : {}), ...(note ? { note } : {}) };
  const parsed = parsePolicyFence(renderPolicyFence([rule]));
  if (!parsed.ok) throw opError('invalid_params', `That rule cannot be saved: ${parsed.error.message}. Nothing was changed.`, 'Shorten --merchant or --note, or pass --id with lowercase letters, digits, - or _ (at most 64).');
  return parsed.rules[0]!;
}

function describeRule(r: PolicyRule): string {
  return `${r.decision} ${r.verb}${r.merchant ? ` at ${r.merchant}` : ''}${r.when ? ` to ${r.when}` : ''}${r.limit ? ` up to ${formatLimit(r.limit)}` : ''} (rule ${r.id})`;
}

async function startingRules(engine: BrainEngine, scope: PolicyScope): Promise<PolicyRule[]> {
  const served = await resolvePolicy(engine, scope);
  return served.approval?.rules ?? [];
}

async function lastFetches(engine: BrainEngine): Promise<Array<{ client: string; operation: string; last_fetched: string }> | null> {
  const rows = await engine.executeRaw<{ client: string | null; operation: string; at: Date | string }>(
    `SELECT COALESCE(agent_name, token_name, 'unnamed') AS client, operation, max(created_at) AS at FROM mcp_request_log
      WHERE operation IN ('policy_check', 'agent_policy') GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 50`).catch((err: unknown) => { rethrowCapabilityRefusal(err); return null; }); // silent-read-ok: null prints as unknown, never as no fetches
  if (!rows) return null;
  return rows.map(r => ({ client: r.client ?? 'unnamed', operation: r.operation, last_fetched: new Date(r.at).toISOString() }));
}

async function editRules(engine: BrainEngine, scope: PolicyScope): Promise<PolicyRule[]> {
  const problem = terminalAuthorityProblem();
  if (problem) throw confirmRequiredError(['gbrain', 'policy', 'edit', ...(scope === 'company' ? ['--scope', 'company'] : [])], problem,
    'policy edit opens an editor, so it needs your own terminal; from a script or agent, change one rule with gbrain policy allow|ask|deny <verb> instead.');
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-policy-'));
  const file = join(dir, 'policy.md');
  try {
    writeFileSync(file, renderPolicyPage(scope, await startingRules(engine, scope)), { mode: 0o600 });
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    const status = await new Promise<number | null>(resolve => {
      const child = spawnCliChild(editor, [file], { shell: true });
      child.on('error', () => resolve(null));
      child.on('exit', code => resolve(code));
    });
    if (status !== 0) throw opError('invalid_params', `The editor (${editor}) exited with status ${status ?? 'unknown'}; nothing was changed.`, 'Run gbrain policy edit again, or use gbrain policy allow|ask|deny.');
    const parsed = parsePolicyFence(readFileSync(file, 'utf8'));
    if (!parsed.ok) throw opError('policy_malformed', `The edited policy is malformed at line ${parsed.error.line}, column ${parsed.error.column}: ${parsed.error.message}. Nothing was changed.`, 'Run gbrain policy edit again and fix the table.');
    return parsed.rules;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runPolicy(engine: BrainEngine, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const json = rest.includes('--json');
  const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value, null, 2) : text);
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { console.log(usage()); return; }
  try {
    switch (sub) {
      case 'presets':
        out(POLICY_PRESETS.map(p => ({ name: p.name, summary: p.summary, rules: p.rules.length })), POLICY_PRESETS.map(p => `${p.name}${p.name === DEFAULT_PRESET ? ' (default)' : ''}: ${p.summary}`).join('\n'));
        return;
      case 'init': {
        const name = flag(rest, '--preset') ?? DEFAULT_PRESET;
        const preset = findPreset(name);
        if (!preset) throw opError('invalid_params', `Unknown preset ${name}.`, `Run gbrain policy presets; known: ${POLICY_PRESETS.map(p => p.name).join(', ')}.`);
        const scope = scopeOf(rest);
        const result = await applyPolicyChange(engine, { scope, rules: preset.rules, change: `set to the ${preset.name} preset` });
        out(result, result.status === 'unchanged' ? `The ${scope} policy already is ${preset.name}.` : `The ${scope} policy is now ${preset.name} (revision ${result.revision}).`);
        return;
      }
      case 'allow': case 'ask': case 'deny': {
        const scope = scopeOf(rest);
        const r = ruleFromArgs(sub, rest);
        const rules = [...(await startingRules(engine, scope)).filter(x => x.id !== r.id), r];
        const result = await applyPolicyChange(engine, { scope, rules, change: describeRule(r) });
        out(result, result.status === 'unchanged' ? 'No change: that rule is already in force.' : `Rule in force: ${describeRule(r)} (revision ${result.revision}).`);
        return;
      }
      case 'edit': {
        const scope = scopeOf(rest);
        const rules = await editRules(engine, scope);
        const result = await applyPolicyChange(engine, { scope, rules, change: `edited (${rules.length} rules)` });
        out(result, result.status === 'unchanged' ? 'No change.' : `Saved and approved revision ${result.revision}.`);
        return;
      }
      case 'accept': {
        const revision = rest.find(a => !a.startsWith('-') && a !== flag(rest, '--scope'));
        if (!revision) throw opError('invalid_params', 'accept needs a revision.', 'Run gbrain policy show to see the revision, then gbrain policy accept <revision>.');
        const result = await acceptRevision(engine, scopeOf(rest), revision);
        out(result, `Approved revision ${result.revision}; agents are served it now.`);
        return;
      }
      case 'check': {
        const verb = verbOf(rest[0]);
        const to = flag(rest, '--to');
        if (to !== undefined && !isRecipientClass(to)) throw opError('invalid_params', `--to must be self, household, known or new, not ${to}.`, 'Pass --to self|household|known|new.');
        const answer = await checkPolicy(engine, { verb, amount: amountOf(rest), merchant: flag(rest, '--merchant'), to }, ['owner', 'company'], { usage: usageLookup(engine, ledgerReader(false), new Date()) });
        out(answer, `${answer.decision}${answer.rule_id ? ` (rule ${answer.rule_id}, ${answer.scope})` : ''}: ${answer.reason}${(answer.budgets ?? []).map(b => `\n${b.rule_id}: ${b.advice}`).join('')}${answer.fix ? `\nNote: ${answer.fix.why}` : ''}`);
        return;
      }
      case 'show': {
        const scopes: PolicyScope[] = rest.includes('--scope') ? [scopeOf(rest)] : ['owner', 'company'];
        const served = await Promise.all(scopes.map(s => resolvePolicy(engine, s)));
        if (rest.includes('--check')) {
          const bad = served.find(p => p.state === 'malformed');
          out(served.map(p => ({ scope: p.scope, state: p.state, parse_error: p.parse_error ?? null })),
            served.map(p => `${p.scope} (${POLICY_SLUGS[p.scope]}): ${p.state}${p.parse_error ? ` at line ${p.parse_error.line}, column ${p.parse_error.column}: ${p.parse_error.message}` : ''}`).join('\n'));
          if (bad) setCliExitVerdict(1);
          return;
        }
        const view = await describePolicy(engine, scopes);
        out(view, served.map(p => {
          const fix = stateFix(p);
          return [`${p.scope} policy (${POLICY_SLUGS[p.scope]}): ${p.state}${p.served_revision ? `, serving revision ${p.served_revision}` : ''}`,
            ...(p.authoritative ? renderPolicyFence(p.rules).split('\n').slice(1, -1) : []),
            ...(p.approval ? [`Approved by ${p.approval.proof.by} (${p.approval.proof.method}) at ${p.approval.proof.at}: ${p.approval.change}`] : []),
            ...(fix ? [`Next: ${fix.argv?.join(' ') ?? ''} (${fix.why})`] : [])].join('\n');
        }).join('\n\n'));
        return;
      }
      case 'status': {
        const served = await Promise.all(POLICY_SCOPES.map(s => resolvePolicy(engine, s)));
        const fetches = await lastFetches(engine);
        out({ scopes: served.map(p => ({ scope: p.scope, state: p.state, served_revision: p.served_revision })), clients: fetches },
          [...served.map(p => `${p.scope}: ${p.state}${p.served_revision ? ` (revision ${p.served_revision})` : ''}`),
            fetches === null ? 'The MCP request log could not be read, so the last fetch per client is unknown.'
              : fetches.length ? 'Last fetched by:' : 'No client has fetched the policy over MCP yet.',
            ...(fetches ?? []).map(f => `  ${f.client}: ${f.operation} at ${f.last_fetched}`)].join('\n'));
        return;
      }
    }
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    setCliExitVerdict(writeCliError(error, 'policy', { argv: ['policy', ...args] }));
    return;
  }
  console.error(usage());
  setCliExitVerdict(2);
}
