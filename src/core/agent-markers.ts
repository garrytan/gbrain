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
import { inertText, shellQuote, type Decision, type DecisionOption, type RenderedNotice } from './agent-output.ts';

/** One decision option line body: `<id>: <label>`, plus the command that applies it. */
function optionText(o: DecisionOption): string {
  return `${inertText(o.id, 80)}: ${inertText(o.label, MAX_FIELD)}${o.argv?.length ? ` (run: ${inertText(shellQuote(o.argv), MAX_FIELD)})` : ''}`;
}

export const AGENT_FIELDS = ['ask', 'why', 'risk', 'consent', 'actor', 'next', 'if_yes', 'if_no', 'verify'] as const;
export type AgentField = (typeof AGENT_FIELDS)[number];

const MAX_FIELD = 1_000;

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
  if (opts.showUser) lines.push('[SHOW USER]', inertText(opts.showUser, MAX_FIELD), '[/SHOW USER]');
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
      ...(n.fix?.command ? [`  Fix: ${n.fix.command}`] : []),
      ...(n.decisions ?? []).flatMap(d => [
        `  ${inertText(d.question, MAX_FIELD)} (default: ${inertText(d.default, 80)})`,
        ...d.options.map(o => `    - ${optionText(o)}`),
      ]),
    ]);
    return { stderr: `${lines.join('\n')}\n` };
  }
  const blocks = notices.map(n => agentBlock({
    why: `[${n.code}] ${n.why}`,
    next: n.fix ? `${n.fix.next}${n.fix.command ? `: ${n.fix.command}` : ''}` : undefined,
    consent: n.fix?.consent.length ? n.fix.consent.join(', ') : undefined,
    actor: n.fix?.actor,
  }, { showUser: n.user_message, decisions: n.decisions })).join('');
  return opts.stdoutIsData ? { stderr: blocks } : { stdout: blocks };
}
