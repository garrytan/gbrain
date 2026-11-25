/**
 * gbrain household — household records (agent platform plan, lane 2, H1).
 *
 *   gbrain household due  [--window <days>] [--kinds bill,supply] [--include at_risk|due|all] [--about <slug>]
 *                         [--handled-by <who>] [--as-of YYYY-MM-DD] [--limit N] [--source <id>] [--json]
 *   gbrain household add  <kind> --title <t> [record flags] [--json]
 *   gbrain household mark <slug> <event> [--on YYYY-MM-DD] [--due YYYY-MM-DD] [--note <text>] [--json]
 *   gbrain household list [--source <id>] [--json]
 *   gbrain household replace [--about <slug> [--role <role>]] [--source <id>] [--json]
 *
 * Every path dispatches through the trusted-local op layer (handleToolCall, remote: false), so the CLI and MCP share
 * one behavior. GBrain never acts: nothing here buys, pays, books, calls or sends.
 */
import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import { exitCliError, usageError } from '../cli/cli-error.ts';
import { HOUSEHOLD_SUBCOMMANDS, ROUTERS, subcommandHelpRequested } from '../cli/subcommands.ts';
import { HOUSEHOLD_EVENTS } from '../core/ops/household.ts';
import { HOUSEHOLD_KINDS } from '../core/household/record.ts';

export { HOUSEHOLD_SUBCOMMANDS as SUBCOMMANDS } from '../cli/subcommands.ts';

const ADD_SHAPES: Record<string, string> = {
  bill: 'gbrain household add bill --title "Water" --due 2026-12-03 --recurs monthly --amount 60 USD',
  supply: 'gbrain household add supply --title "Coffee beans" --cadence 14d --last-done 2026-11-20',
  birthday: 'gbrain household add birthday --title "Alice birthday" --on 03-14 --about people/alice-example',
  deadline: 'gbrain household add deadline --title "Field trip form" --due 2026-12-02 --school --about people/robin-example --child',
  appointment: 'gbrain household add appointment --title "Dentist" --cadence 6m --last-done 2026-06-15',
  return: 'gbrain household add return --title "Winter boots" --due 2026-12-03',
  credit: 'gbrain household add credit --title "Store credit" --due 2027-01-31 --amount 25 USD',
};

export function printUsage(): void {
  process.stdout.write([
    'gbrain household — bills, supplies, birthdays, school deadlines, returns and credits',
    '  due     [--window <days>] [--kinds bill,supply] [--include at_risk|due|all] [--about <slug>] [--handled-by <who>]',
    '          [--as-of YYYY-MM-DD] [--limit N] [--source <id>] [--json]     what is overdue, at risk or coming up',
    '  add     <kind> --title <title> [--due D] [--recurs none|weekly|monthly|quarterly|yearly] [--cadence 30d] [--last-done D]',
    '          [--on MM-DD] [--lead-days N] [--amount N CUR] [--about slug,slug] [--about-role adult|child|helper|pet|home|other]',
    '          [--child] [--handled-by who] [--gift none|ideas|bought|given] [--proposed-verb v] [--proposed-note text]',
    '          [--audience adults] [--school] [--note text] [--slug name] [--source <id>] [--json]',
    `  mark    <slug> <event> [--on D] [--due D] [--note text] [--json]   events: ${HOUSEHOLD_EVENTS.join(', ')}`,
    '  list    [--source <id>] [--json]                                     every record, ranked',
    '  replace [--about slug,slug [--role adult|child|helper|pet|home|other]] [--source <id>] [--json]',
    '          recompute record readers from the placement table; --about narrows the records about a subject to adults first',
    '',
    `Kinds: ${HOUSEHOLD_KINDS.join(', ')}. One example per kind:`,
    ...Object.values(ADD_SHAPES).map(s => `  ${s}`),
    '',
    'GBrain never buys, pays, books, calls or sends: every proposed action needs your yes. Docs: docs/guides/household.md',
  ].join('\n') + '\n');
}

/** Every flag the household subcommands read, and the op param each one fills. */
const FLAGS: Readonly<Record<string, string>> = {
  '--title': 'title', '--slug': 'slug', '--about': 'about', '--about-role': 'about_role', '--child': 'child', '--handled-by': 'handled_by',
  '--due': 'due', '--recurs': 'recurs', '--cadence': 'cadence', '--last-done': 'last_done', '--on': 'on', '--lead-days': 'lead_days',
  '--amount': 'amount', '--gift': 'gift', '--proposed-verb': 'proposed_verb', '--proposed-note': 'proposed_note', '--audience': 'audience',
  '--school': 'school', '--note': 'note', '--source': 'source_id', '--request-id': 'request_id', '--window': 'window_days', '--kinds': 'kinds',
  '--include': 'include', '--as-of': 'as_of', '--limit': 'limit', '--role': 'role',
};
const BOOLEAN_FLAGS = new Set(['child', 'school']);
const NUMBER_FLAGS = new Set(['lead_days', 'amount', 'window_days', 'limit']);
const LIST_FLAGS = new Set(['about', 'kinds']);
const ADD_PARAMS = ['title', 'slug', 'about', 'about_role', 'child', 'handled_by', 'due', 'recurs', 'cadence', 'last_done', 'on', 'lead_days', 'amount',
  'currency', 'gift', 'proposed_verb', 'proposed_note', 'audience', 'school', 'note', 'source_id', 'request_id'];

/** Op params from the flags (--amount takes an optional currency after it), and the bare words in order. */
function parseFlags(args: string[]): { values: Record<string, unknown>; words: string[] } {
  const values: Record<string, unknown> = {};
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) { words.push(a); continue; }
    const name = FLAGS[a];
    if (!name) throw usageError(`Unknown flag for gbrain household: ${a}.`, `Use one of: ${Object.keys(FLAGS).join(', ')}, --json.`, { code: 'unknown_flag' });
    if (BOOLEAN_FLAGS.has(name)) { values[name] = true; continue; }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw usageError(`${a} needs a value.`, `Pass the value right after the flag, e.g. ${ADD_SHAPES.bill}`);
    i++;
    values[name] = NUMBER_FLAGS.has(name) ? Number(value) : LIST_FLAGS.has(name) ? value.split(',').map(s => s.trim()).filter(Boolean) : value;
    if (name === 'amount' && args[i + 1] && /^[A-Za-z]{3}$/.test(args[i + 1]!)) values.currency = args[++i]!;
  }
  return { values, words };
}

const pick = (values: Record<string, unknown>, allowed: readonly string[]) => Object.fromEntries(Object.entries(values).filter(([k]) => allowed.includes(k)));

function print(json: boolean, result: unknown, human: string): void {
  process.stdout.write(json ? JSON.stringify(result, null, 2) + '\n' : human + '\n');
}

export async function runHousehold(engine: BrainEngine, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const json = args.includes('--json');
  if (!sub || subcommandHelpRequested(args, ROUTERS.household)) { printUsage(); return; }
  const { values, words } = parseFlags(rest.filter(a => a !== '--json'));
  try {
    if (sub === 'due' || sub === 'list') {
      const p = sub === 'list' ? { include: 'all', window_days: 366, limit: 100, ...pick(values, ['source_id']) }
        : { ...pick(values, ['window_days', 'kinds', 'include', 'handled_by', 'as_of', 'limit', 'source_id']), ...(Array.isArray(values.about) ? { about: values.about[0] } : {}) };
      const result = await handleToolCall(engine, 'household_due', p) as { text: string; timezone: string };
      print(json, result, result.text);
      return;
    }
    if (sub === 'add') {
      const kind = words[0];
      if (!kind || !(HOUSEHOLD_KINDS as readonly string[]).includes(kind)) {
        throw usageError(`gbrain household add needs a kind: ${HOUSEHOLD_KINDS.join(', ')}.`, `Example: ${ADD_SHAPES.bill}`);
      }
      const result = await handleToolCall(engine, 'household_add', { kind, ...pick(values, ADD_PARAMS) }) as { slug: string; audience: string; records_replaced: string[] };
      print(json, result, `Added ${result.slug} (readable by ${result.audience === 'adults' ? 'adults only' : 'adults, helpers and family chats'}).`
        + (result.records_replaced.length ? ` Re-placed ${result.records_replaced.length} record(s) about the same subject.` : ''));
      return;
    }
    if (sub === 'mark') {
      const [slug, event] = words;
      if (!slug || !event) throw usageError('gbrain household mark needs a record slug and an event.', `Usage: gbrain household mark <slug> <event>; events: ${HOUSEHOLD_EVENTS.join(', ')}.`);
      const result = await handleToolCall(engine, 'household_mark', { slug, event, ...pick(values, ['on', 'due', 'note', 'source_id', 'request_id']) }) as { slug: string; on: string; status: string };
      print(json, result, `Marked ${result.slug} ${event} on ${result.on} (now ${result.status}).`);
      return;
    }
    if (sub === 'replace') {
      const result = await handleToolCall(engine, 'household_replace', pick(values, ['source_id', 'about', 'role'])) as { checked: number; replaced: string[] };
      print(json, result, `Checked ${result.checked} household record(s); re-placed ${result.replaced.length}.`);
      return;
    }
    throw usageError(`Unknown household subcommand: ${sub}.`, 'Use one of: gbrain household due, add, mark, list or replace.', { code: 'unknown_command' });
  } catch (e) {
    exitCliError(e, 'household', { json });
  }
}
