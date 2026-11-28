/**
 * The one builder for `[AGENT] … [/AGENT]` blocks with an optional fenced
 * `[SHOW USER] … [/SHOW USER]` relay (agent operator contract v1, A6
 * markers). Every other module asks this one for marker text, so the format
 * cannot fork; a grep test pins that markers come only from here.
 *
 * Every interpolated value passes through inertText(): newlines flatten and
 * marker tokens lose their opening bracket, so a page title or model name
 * cannot open or close a block. Field names come from the fixed vocabulary.
 */
import { commandUnavailable, inertText, invalidArgument, shellQuote, type Decision, type DecisionOption, type RenderedAction, type RenderedNotice } from './agent-output.ts';

/** What a capped line prints instead of a command that does not fit whole (GCH5-05: never a cut command). */
export const COMMAND_TOO_LONG = '(the command is too long for this line; read it from --json)';

/**
 * GCH5-05: `prefix` plus the whole command when the line fits in `max`, else `prefix` plus COMMAND_TOO_LONG. A
 * command is built by shellQuote, so inertText leaves it unchanged; the only thing that could change it is a cut.
 */
export function commandField(prefix: string, command: string, max: number = MAX_FIELD): string {
  return prefix.length + command.length <= max ? `${prefix}${command}` : `${prefix}${COMMAND_TOO_LONG}`;
}

/** The command text for argv a renderer did not build: the unavailable sentence for argv no shell can carry. */
export function argvCommand(argv: readonly string[]): { command: string } | { unavailable: string } {
  const bad = invalidArgument(argv);
  return bad ? { unavailable: commandUnavailable(bad) } : { command: shellQuote(argv) };
}

/** A rendered action's command for a capped line: whole, the too-long note, or the unavailable note when argv has no command. */
export function actionCommandField(prefix: string, fix: Pick<RenderedAction, 'argv' | 'command'>, max: number = MAX_FIELD): string | undefined {
  if (fix.command) return commandField(prefix, fix.command, max);
  if (fix.argv?.length) return `${prefix}(command unavailable; why says which argument, --json shows the exact argv)`;
  return undefined;
}

/** One decision option line body: `<id>: <label>`, plus the command that applies it. */
function optionText(o: DecisionOption): string {
  const head = `${inertText(o.id, 80)}: ${inertText(o.label, MAX_FIELD)}`;
  if (!o.argv?.length) return head;
  const run = argvCommand(o.argv);
  return `${head} (run: ${'command' in run ? commandField('', run.command) : inertText(run.unavailable, MAX_FIELD)})`;
}

export const AGENT_FIELDS = ['ask', 'why', 'risk', 'consent', 'actor', 'next', 'if_yes', 'if_no', 'verify'] as const;
export type AgentField = (typeof AGENT_FIELDS)[number];

const MAX_FIELD = 1_000;
/** The cap agentBlock puts on each field; a caller that fits a command into a field budgets against it. */
export const AGENT_FIELD_MAX = MAX_FIELD;
const MAX_SHOW_USER = 4_000;

/** `[AGENT]` block, fields in vocabulary order, empty ones skipped; the relay text is fenced inside it. */
export function agentBlock(fields: Partial<Record<AgentField, string>>, opts: { showUser?: string; decisions?: readonly Decision[] } = {}): string {
  const lines = ['[AGENT]'];
  for (const name of AGENT_FIELDS) {
    const value = fields[name];
    if (value) lines.push(`${name}: ${inertText(value, MAX_FIELD)}`);
  }
  (opts.decisions ?? []).forEach((d, i) => {
    lines.push(`${i + 1}. ${inertText(d.question, MAX_FIELD)} (id: ${inertText(d.id, 80)})`);
    for (const o of d.options) lines.push(`   - ${optionText(o)}`);
    lines.push(`   default: ${inertText(d.default, 80)} — ${inertText(d.default_reason, MAX_FIELD)}`);
  });
  if (opts.showUser) lines.push('[SHOW USER]', inertText(opts.showUser, MAX_SHOW_USER), '[/SHOW USER]');
  lines.push('[/AGENT]');
  return `${lines.join('\n')}\n`;
}

/**
 * CLI notice channel (A6): TTY → readable stderr lines; non-TTY human → one
 * `[AGENT]` block per notice (stdout, or stderr when the command's stdout is
 * data); `--json` → the caller puts the rendered notices under `notices` in
 * its final document (nothing is written here).
 */
export function renderCliNotices(notices: readonly RenderedNotice[], opts: { json: boolean; tty: boolean; stdoutIsData?: boolean }):
  { stdout?: string; stderr?: string; json?: RenderedNotice[] } {
  if (notices.length === 0) return {};
  if (opts.json) return { json: [...notices] };
  if (opts.tty) {
    const lines = notices.flatMap(n => [
      `Note [${n.code}]: ${n.why}`,
      // No cap on a TTY line, so the command prints whole; argv with no command says so (GCH5-05).
      ...(n.fix ? (f => f ? [f] : [])(actionCommandField('  Fix: ', n.fix, Infinity)) : []),
      ...(n.decisions ?? []).flatMap(d => [
        `  ${inertText(d.question, MAX_FIELD)} (default: ${inertText(d.default, 80)})`,
        ...d.options.map(o => `    - ${optionText(o)}`),
      ]),
    ]);
    return { stderr: `${lines.join('\n')}\n` };
  }
  const blocks = notices.map(n => agentBlock({
    why: `[${n.code}] ${n.why}`,
    next: n.fix ? actionCommandField(`${n.fix.next}: `, n.fix) ?? n.fix.next : undefined,
    consent: n.fix?.consent.length ? n.fix.consent.join(', ') : undefined,
    actor: n.fix?.actor,
  }, { showUser: n.user_message, decisions: n.decisions })).join('');
  return opts.stdoutIsData ? { stderr: blocks } : { stdout: blocks };
}
