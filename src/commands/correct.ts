/**
 * gbrain correct (agent platform C2): the CLI form of the correct op.
 *
 *   gbrain correct "<rule>" [--fact-id N] [--corrected-fact "<text>"] [--entity <slug>] [--scope me|team]
 *                  [--question "<q>" --expect a,b --reject c] [--source <id>] [--request-id <id>] [--json]
 *   gbrain correct status <receipt>
 *   gbrain correct resume <receipt>
 *
 * Trusted local op dispatch (handleToolCall). Run by the owner at a terminal with no agent marker, it asks for a
 * short code and the rule joins the standing-rules section at once; otherwise the rule is saved active and the
 * receipt names the gbrain rules approve command.
 */
import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import { exitCliError, usageError } from '../cli/cli-error.ts';
import { ROUTERS, subcommandHelpRequested } from '../cli/subcommands.ts';

export { CORRECT_SUBCOMMANDS as SUBCOMMANDS } from '../cli/subcommands.ts';

export function printUsage(): void {
  process.stdout.write([
    'gbrain correct — save the user\'s correction as a standing rule and fix the fact it corrects',
    '  correct "<rule>" [--fact-id N] [--corrected-fact "<text>"] [--entity <slug>] [--scope me|team]',
    '                   [--question "<q>" --expect a,b --reject c] [--source <id>] [--request-id <id>] [--json]',
    '      writes the rule (proposed), supersedes fact N with --corrected-fact or withdraws it (never purges),',
    '      then makes the rule active; at your own terminal it asks for a short code so your agents load it',
    '  correct status <receipt> [--json]   where a correction stands and what is next',
    '  correct resume <receipt> [--json]   run the steps a stopped correction has not committed',
    '',
    'Docs: docs/guides/standing-rules.md',
  ].join('\n') + '\n');
}

const FLAGS: Readonly<Record<string, string>> = {
  '--fact-id': 'fact_id', '--corrected-fact': 'corrected_fact', '--entity': 'entity', '--scope': 'scope', '--question': 'question',
  '--expect': 'expect', '--reject': 'reject', '--source': 'source_id', '--request-id': 'request_id', '--provenance': 'provenance',
};

function parse(args: string[]): { values: Record<string, string>; words: string[] } {
  const values: Record<string, string> = {};
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) { words.push(a); continue; }
    const name = FLAGS[a];
    if (!name) throw usageError(`Unknown flag for gbrain correct: ${a}.`, `Use one of: ${Object.keys(FLAGS).join(', ')}, --json.`, { code: 'unknown_flag' });
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw usageError(`${a} needs a value.`, 'Example: gbrain correct "Alice-example is VP Engineering; never call her the CTO." --fact-id 42 --corrected-fact "Alice-example is VP Engineering."');
    values[name] = v; i++;
  }
  return { values, words };
}

function human(r: Record<string, any>): string {
  const lines = [`Correction ${r.receipt_id}: ${r.state}${r.step ? ` at the ${r.step} step` : ''}. Rule ${r.rule_id} is ${r.effect?.rule}; fact ${r.effect?.fact}.`];
  if (r.effect?.standing) lines.push('Your agents load it in their standing rules.');
  if (r.next) lines.push(`Next (${r.next.who}): ${r.next.argv?.join(' ') ?? ''}${r.next.why ? ` — ${r.next.why}` : ''}`);
  return lines.join('\n');
}

export async function runCorrectCli(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  if (!args.length || subcommandHelpRequested(args, ROUTERS.correct)) { printUsage(); return; }
  try {
    const { values, words } = parse(args.filter(a => a !== '--json'));
    let params: Record<string, unknown>;
    if (words[0] === 'status' || words[0] === 'resume') {
      if (!words[1]) throw usageError(`gbrain correct ${words[0]} needs a receipt id.`, `Usage: gbrain correct ${words[0]} <receipt>`);
      params = { receipt_id: words[1], ...(words[0] === 'resume' ? { resume: true } : {}) };
    } else {
      const rule = words.join(' ').trim();
      if (!rule) throw usageError('gbrain correct needs the rule text.', 'Example: gbrain correct "Never call alice-example the CTO." --fact-id 42');
      const { question, expect, reject, ...rest } = values;
      const list = (s?: string) => (s ?? '').split(',').map(x => x.trim()).filter(Boolean);
      params = { rule, ...rest, ...(question ? { checks: [{ question, expect: list(expect), reject: list(reject) }] } : {}) };
    }
    const result = await handleToolCall(engine, 'correct', params) as Record<string, unknown>;
    process.stdout.write((json ? JSON.stringify(result, null, 2) : human(result)) + '\n');
  } catch (e) {
    exitCliError(e, 'correct', { json });
  }
}
