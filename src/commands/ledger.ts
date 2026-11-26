/**
 * gbrain ledger: what agents did outside the brain (L2), read and recorded on the brain host.
 *
 *   gbrain ledger [--since 30d] [--verb <verb>] [--counterparty <name>] [--json]
 *   gbrain ledger add <verb> --summary <text> [--status done] [--spent <n> | --saved <n> --period one_time|monthly|yearly]
 *                     [--currency USD] [--estimated] [--evidence <slug>]... [--counterparty <name>] [--at <iso>] [--json]
 *   gbrain ledger confirm <action_id> [--json]
 *   gbrain ledger digest --week [--save] [--json]
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import type { OperationContext } from '../core/ops/contract.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { loadConfig } from '../core/config.ts';
import { AGENT_VERBS, isAgentVerb } from '../core/agent-verbs.ts';
import { dumpFrontmatterYaml } from '../core/data-frontmatter.ts';
import { submitPageMutation } from '../core/persistence/page-mutations.ts';
import { terminalAuthorityProblem } from '../core/policy/authority.ts';
import { ACTION_SOURCE, ACTION_STATUSES, DIGEST_PREFIX, SAVED_PERIODS } from '../core/ledger/action.ts';
import { confirmAction, ledgerReader, ledgerReport, logAction, parseSince, scanActions, type LogActionInput } from '../core/ledger/store.ts';
import { renderDigest, type LedgerTotals } from '../core/ledger/totals.ts';

export function usage(): string {
  return [
    'Usage: gbrain ledger [subcommand]',
    '',
    'The action ledger: what your agents did outside this brain (sent, spent, cancelled, signed up), with',
    'evidence. Totals are computed by gbrain and split into with evidence, confirmed by you, and estimated.',
    '',
    '  [--since 30d] [--verb <verb>] [--counterparty <name>] [--json]   totals for a window (default 30 days)',
    '  add <verb> --summary <text> [--spent <n> | --saved <n> --period one_time|monthly|yearly] [--currency USD]',
    '      [--estimated] [--evidence <slug>]... [--counterparty <name>] [--status done] [--at <iso>]',
    '                                       record an action yourself, e.g. gbrain ledger add cancel --summary "Cancelled the acme-example trial" --saved 12 --currency USD --period monthly --estimated',
    '  confirm <action_id>                  mark a done action\'s amounts as confirmed by you (your own terminal only)',
    '  digest --week [--save]               the last 7 days as text; --save keeps it as a private page under actions/weekly/',
    '',
    `Verbs: ${AGENT_VERBS.join(', ')}.`,
  ].join('\n');
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function flags(args: string[], name: string): string[] {
  return args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]!] : []));
}

function numberFlag(args: string[], name: string): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw opError('invalid_params', `${name} must be a number of 0 or more, not ${raw}.`, `Pass ${name} 12.50.`);
  return n;
}

function localCtx(engine: BrainEngine): OperationContext {
  return { engine, config: loadConfig() ?? { engine: engine.kind }, remote: false, dryRun: false, sourceId: ACTION_SOURCE,
    logger: { info: () => {}, warn: (m: string) => console.error(m), error: (m: string) => console.error(m) } } as unknown as OperationContext;
}

const money = (b: Record<string, number>) => Object.entries(b).map(([c, n]) => `${n.toFixed(2)} ${c}`).join(', ') || 'none';

function totalsText(t: LedgerTotals): string {
  return [
    `${t.actions} actions done.`,
    `Spent: with evidence ${money(t.spent.evidenced)}; confirmed by you ${money(t.spent.user_confirmed)}; estimated ${money(t.spent.estimated)}.`,
    ...(['one_time', 'monthly', 'yearly'] as const).map(p => `Saved ${p.replace('_', ' ')}: with evidence ${money(t.saved[p].evidenced)}; confirmed ${money(t.saved[p].user_confirmed)}; estimated ${money(t.saved[p].estimated)}.`),
    ...Object.entries(t.by_verb).map(([v, x]) => `  ${v}: ${x.actions} (spent ${money(x.spent)})`),
    `Live budget holds: ${t.holds.live} (${money(t.holds.held)}); expired without a result: ${t.holds.expired_unconfirmed}.`,
  ].join('\n');
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-w${String(week).padStart(2, '0')}`;
}

export async function runLedger(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
  const rest = sub ? args.slice(1) : args;
  const json = rest.includes('--json');
  const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value, null, 2) : text);
  if (args.includes('--help') || args.includes('-h') || sub === 'help') { console.log(usage()); return; }
  const now = new Date();
  try {
    switch (sub) {
      case undefined: {
        const since = parseSince(flag(rest, '--since'), now);
        if (!since) throw opError('invalid_params', '--since must be a number of days like 30d, or an ISO date.', 'Pass --since 30d.');
        const verb = flag(rest, '--verb');
        if (verb !== undefined && !isAgentVerb(verb)) throw opError('invalid_params', `Unknown verb ${verb}.`, `Pass one of: ${AGENT_VERBS.join(', ')}.`);
        const report = await ledgerReport(engine, ledgerReader(false), { since, until: new Date(now.getTime() + 1), verb, counterparty: flag(rest, '--counterparty') }, now);
        out(report, report.state === 'partial' ? `Too many actions in this window to total in one read (${report.scanned} scanned). Next: ${report.fix.argv?.join(' ')}` : totalsText(report.totals));
        return;
      }
      case 'add': {
        const verb = rest[0];
        if (!isAgentVerb(verb)) throw opError('invalid_params', `Unknown verb ${verb ?? '(none)'}.`, `Pass one of: ${AGENT_VERBS.join(', ')}.`);
        const status = flag(rest, '--status') ?? 'done';
        if (!(ACTION_STATUSES as readonly string[]).includes(status)) throw opError('invalid_params', `--status must be one of ${ACTION_STATUSES.join(', ')}.`, 'Pass --status done.');
        const period = flag(rest, '--period');
        if (period !== undefined && !(SAVED_PERIODS as readonly string[]).includes(period)) throw opError('invalid_params', '--period must be one_time, monthly or yearly.', 'Pass --period monthly.');
        const result = await logAction(localCtx(engine), {
          verb, status: status as LogActionInput['status'], summary: flag(rest, '--summary'), counterparty: flag(rest, '--counterparty'), at: flag(rest, '--at'),
          currency: flag(rest, '--currency'), spent: numberFlag(rest, '--spent'), saved: numberFlag(rest, '--saved'), saved_period: period as LogActionInput['saved_period'],
          ...(rest.includes('--estimated') ? { estimated: true } : {}), evidence: flags(rest, '--evidence').map(ref => ({ ref })), approval_by: 'owner', harness: 'gbrain-cli',
        }, now);
        out(result, `Logged ${result.action_id} (${result.status}, ${result.claim_basis}).`);
        return;
      }
      case 'confirm': {
        const id = rest.find(a => !a.startsWith('-'));
        if (!id) throw opError('invalid_params', 'confirm needs an action_id.', 'Run gbrain ledger --json to find it, then gbrain ledger confirm <action_id>.');
        const problem = terminalAuthorityProblem();
        if (problem) {
          throw opError('ledger_confirm_required', `The action was not confirmed: ${problem.reason === 'agent_marker' ? `this process carries the agent marker ${problem.marker}` : 'no terminal is attached'}.`,
            `Ask the user to run gbrain ledger confirm ${id} in their own terminal.`, { reason: problem.reason,
              fix: { argv: ['gbrain', 'ledger', 'confirm', id], consent: [], actor: 'user', requires_exclusive: false, why: 'Only the user confirms an amount.',
                user_message: `To confirm the amounts of ${id}, run this in your own terminal, outside the agent session: gbrain ledger confirm ${id}` } });
        }
        const result = await confirmAction(localCtx(engine), id);
        out(result, result.unchanged ? `${id} was already confirmed.` : `${id} is confirmed by you.`);
        return;
      }
      case 'digest': {
        if (!rest.includes('--week')) throw opError('invalid_params', 'digest needs --week.', 'Run gbrain ledger digest --week.');
        const since = new Date(now.getTime() - 7 * 86_400_000);
        const scan = await scanActions(engine, ledgerReader(false), since, new Date(now.getTime() + 1));
        if (scan.partial) throw opError('ledger_scan_too_large', `More than ${scan.scanned} actions fall in the last week, so no digest was written.`, 'Run gbrain ledger --since 3d for a shorter window.');
        const text = renderDigest(scan.rows, since, now, now);
        let saved: string | null = null;
        if (rest.includes('--save')) {
          saved = `${DIGEST_PREFIX}${isoWeek(now)}`;
          const existing = await engine.getPage(saved, { sourceId: ACTION_SOURCE });
          const content = `---\n${dumpFrontmatterYaml({ title: `Agent actions, week ${isoWeek(now)}`, visibility: 'private' }).trimEnd()}\n---\n\n${text}`;
          await submitPageMutation(localCtx(engine), { operation: 'put_page', params: { slug: saved, source_id: ACTION_SOURCE, content, request_id: randomUUID(),
            ...(existing ? { expected_revision: String(existing.knowledge_revision ?? '') } : {}) } });
        }
        out({ since: since.toISOString(), until: now.toISOString(), saved, text }, saved ? `${text}\nSaved as ${saved}.` : text);
        return;
      }
    }
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    setCliExitVerdict(writeCliError(error, 'ledger', { argv: ['ledger', ...args] }));
    return;
  }
  console.error(usage());
  setCliExitVerdict(2);
}
