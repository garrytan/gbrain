/**
 * gbrain rules (agent platform C2): standing rules saved by gbrain correct or the correct op.
 *
 *   gbrain rules list [--source <id>] [--json]          every rule, its status, revision and whether it is confirmed
 *   gbrain rules show <id> [--source <id>] [--json]
 *   gbrain rules approve <id>@<revision> [--source <id>] the owner confirms that exact revision at their own terminal
 *   gbrain rules retire <id> [--source <id>]            it stops loading at once and is never revived
 *   gbrain rules check [<id>] [--source <id>] [--json]  keyless regression check (doctor rules_regression reads it)
 *
 * Runs on the brain host only: approval needs the owner's terminal, and a remote agent changes rules only through
 * the correct op.
 */
import type { BrainEngine } from '../core/engine.ts';
import { exitCliError, usageError } from '../cli/cli-error.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { ROUTERS, subcommandHelpRequested } from '../cli/subcommands.ts';
import { listRulePages } from '../core/rules/section.ts';
import { approveRule, retireRule } from '../core/rules/correct.ts';
import { runRulesCheck } from '../core/rules/check.ts';
import { ruleSlugOf } from '../core/rules/record.ts';

export { RULES_SUBCOMMANDS as SUBCOMMANDS } from '../cli/subcommands.ts';

export function printUsage(): void {
  process.stdout.write([
    'gbrain rules — standing rules your agents load (saved with gbrain correct or the correct tool)',
    '  list    [--source <id>] [--json]                every rule: status, revision, confirmed',
    '  show    <id> [--source <id>] [--json]           one rule and the command that approves it',
    '  approve <id>@<revision> [--source <id>]         confirm that exact revision (asks for a short code)',
    '  retire  <id> [--source <id>]                    stop loading it; a retired rule is never revived',
    '  check   [<id>] [--source <id>] [--json]         keyless regression check of confirmed rules',
    '',
    'Docs: docs/guides/standing-rules.md',
  ].join('\n') + '\n');
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runRules(engine: BrainEngine, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const json = args.includes('--json');
  if (!sub || subcommandHelpRequested(args, ROUTERS.rules)) { printUsage(); return; }
  const sourceId = flag(rest, '--source') ?? 'default';
  const words = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--source');
  const print = (result: unknown, text: string) => process.stdout.write((json ? JSON.stringify(result, null, 2) : text) + '\n');
  try {
    if (sub === 'list' || sub === 'show') {
      const rows = await listRulePages(engine, sourceId);
      const view = rows.map(r => ({ id: r.rule.id, scope: r.rule.scope, status: r.rule.status, revision: r.revision, confirmed: r.confirmed, rule: r.rule.text,
        attribution: r.rule.attribution, ...(r.rule.corrects ? { corrects: r.rule.corrects } : {}), checks: r.rule.checks.length }));
      if (sub === 'list') { print({ rules: view }, view.length ? view.map(v => `${v.id}  ${v.status}${v.confirmed ? ', confirmed' : ''}  @${v.revision}  ${v.rule}`).join('\n') : 'No standing rules yet. Save one with gbrain correct.'); return; }
      const slug = words[0] ? ruleSlugOf(words[0]) : null;
      const one = view.find(v => `rules/${v.id}` === slug);
      if (!one) throw usageError(`No standing rule ${words[0] ?? '(none given)'}.`, 'gbrain rules list shows each rule\'s id.');
      const approve = !one.confirmed && one.status !== 'retired' ? `gbrain rules approve ${one.id}@${one.revision}` : null;
      print({ ...one, ...(approve ? { approve } : {}) }, [`${one.id} (${one.scope}, ${one.status}${one.confirmed ? ', confirmed' : ''}) @${one.revision}`, one.rule, one.attribution,
        ...(approve ? [`Approve: ${approve}`] : [])].filter(Boolean).join('\n'));
      return;
    }
    if (sub === 'approve') {
      if (!words[0]) throw usageError('gbrain rules approve needs <id>@<revision>.', 'gbrain rules list shows each rule\'s id and revision.');
      const r = await approveRule(engine, words[0], { sourceId });
      print(r, r.approved ? `Approved ${r.rule_id} at revision ${r.revision}; your agents load it in their standing rules.` : `Not approved: ${JSON.stringify(r.receipt)}`);
      return;
    }
    if (sub === 'retire') {
      if (!words[0]) throw usageError('gbrain rules retire needs a rule id.', 'gbrain rules list shows each rule\'s id.');
      const r = await retireRule(engine, words[0], { sourceId });
      print(r, `Retired ${r.rule_id}${r.unchanged ? ' (it already was)' : ''}.`);
      return;
    }
    if (sub === 'check') {
      const r = await runRulesCheck(engine, { sourceId, ...(words[0] ? { id: words[0] } : {}) });
      print(r, r.checked ? [`Checked ${r.checked}, failed ${r.failed}.`, ...r.results.filter(x => !x.pass).map(x => `  ${x.rule_id}: ${x.problems.join('; ')}`)].join('\n') : 'No confirmed active rules to check.');
      if (r.failed) setCliExitVerdict(1);
      return;
    }
    throw usageError(`Unknown rules subcommand: ${sub}.`, 'Use one of: gbrain rules list, show, approve, retire or check.', { code: 'unknown_command' });
  } catch (e) {
    exitCliError(e, 'rules', { json });
  }
}
