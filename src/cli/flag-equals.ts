/**
 * #7619: `--flag=value` on CLI_ONLY commands. The unknown-flag validator
 * accepts the `=` form of every registered flag, but most handlers read only
 * `--flag value` (`args.includes`, `args[args.indexOf(flag) + 1]`), so the
 * value was dropped with no error: `serve --access=read-only` served every
 * write tool, `auth create --scopes=read` minted a full-access token. The
 * CLI entry never lets an `=` token reach a handler that would drop it:
 *  - refuse (invalid_params, exit 2) a switch: a boolean in the command's own
 *    table (curated help, the sync flag table), a `--no-` negation, the
 *    command's COMMAND_SWITCHES, or a name whose shared-op parameter or
 *    curated flag is boolean. Splitting turns the switch on and keeping drops
 *    the value (`--dry-run=true` would write). Without the command's own
 *    table, that cross-command evidence picks the bare-switch message, so
 *    `--yes=n` is never answered with `--yes <value>`;
 *  - without the command's own table, refuse a true/false word or 0/1
 *    (`--apply=false`) naming both readings, so it never suggests
 *    `--apply false` (which turns a switch on) and says a value never turns
 *    a switch off;
 *  - after a bare `--` the handler reads past, refuse an `=` token that is
 *    not a registered flag: the unknown-flag validator stops at `--`;
 *  - keep the token where the handler on this path reads the `=` form
 *    (EQUALS_READERS, keyed by command or `command sub`), empty values
 *    included: that handler owns refusing them;
 *  - on a path that reads no value flag (NO_VALUE_FLAG_PATHS), refuse a
 *    value flag with advice to leave it out;
 *  - elsewhere, refuse an empty value or one that looks like a flag (`-y`, `--x`);
 *  - split `--flag value` when the command's own table declares a value;
 *  - refuse every other `=` form with the separate-token spelling. Splitting
 *    a flag the subcommand never reads would leave its value as a stray
 *    positional, which handlers that take the first numeric or non-flag token
 *    as their target would act on (`forget --purge --reason=3 34` purging
 *    fact 3). Keeping it whole is safe only where every path of the command
 *    reads the `=` form, and evidence from one module does not show that for
 *    its sibling subcommands (`extract links --source-id=x` walked every
 *    source while `extract --stale` validated the same token).
 * `--json=true` becomes `--json` (the agent contract's JSON spelling, read
 * the same way by jsonRequested). Refusals name `--flag=…`, never the value,
 * which may be a credential. A short flag never takes `=` (`-y=n` is refused,
 * never taken as consent); a quoted argument with whitespace that only starts
 * like one (`capture "-n=3 is the answer"`) is text. `agent run` scans only
 * where parseRunFlags reads flags: the leading flag zone (its switches, its value
 * flags with their value, which passes untouched, and flag-shaped `--x=`
 * tokens, so `--tools=bash, read` still refuses) and, when the prompt holds no
 * bare `--`, the trailing switches it hoists, exact or with an `=` value and
 * no whitespace (`--detach=true` there refuses); the prompt between them is
 * text, except that up to its first bare `--` one of its value flags written
 * with `=` (any value) or a switch written with `=` and no whitespace refuses
 * (`agent run --json --tools=read ...` would hand the job every tool), with
 * advice to write it before the prompt or put `--` before the prompt. OWN_EQUALS_PARSERS pass their argv through. On a
 * command with a registry row, unregistered flags keep the token for the
 * validator to name; on a path with none (the hand-parsed search
 * subcommands), every `=` token but `--json=true` refuses with a neutral
 * message that names the subcommand, echoes no value and vouches for no
 * switch. A bare `--` ends the scan only on a path whose handler stops there
 * (END_OF_OPTIONS, keyed by `command sub`): `serve`, `auth`,
 * `frontmatter generate`, `questions` and `agent logs` read flags after it.
 */
import type { OperationError } from '../core/ops/contract.ts';
import { CLI_FLAG_REGISTRY } from '../core/cli-flag-registry.generated.ts';
import { unknownFlagError, usageError } from './cli-error.ts';
import { loadCuratedHelp } from './help/render.ts';
import { OPERATION_MANIFEST } from '../core/operation-manifest.generated.ts';
import { SYNC_FLAGS } from '../core/sync-flags.ts';
import { parseGlobalFlags, setCliOptions } from '../core/cli-options.ts';

export { EQUALS_READERS } from './equals-readers.ts';
import { EQUALS_READERS } from './equals-readers.ts';

/** Commands that run another command's handler on the same argv (`repos` is runSources, cli/commands/repos.ts:18): the = rule reads the target's keys. */
export const READER_ALIASES: Readonly<Record<string, string>> = { repos: 'sources' };

/**
 * Commands and subcommands whose handler parses `--flag value` and
 * `--flag=value` itself on every path, refusing `=` on its own switches:
 * cliOnlyFlagArgs in src/cli/main.ts passes their argv through unchanged
 * (pinned by test/cli-flag-equals.test.ts in both directions against every
 * `indexOf('=')` option parser). The sources lifecycle subcommands are not
 * here: on an unmanaged brain they fall back to runSources, which reads only
 * exact tokens.
 */
export const OWN_EQUALS_PARSERS: ReadonlySet<string> = new Set([
  'append', 'auth local-writer', 'eval longmemeval', 'git', 'google attachments', 'migrate embeddings', 'repair', 'retrieval-upgrade', 'schema add-type', 'skillpack remove',
  'sources connect', 'sources inspect', 'sources reconcile', 'sources reset-upstream', 'sources writer',
  'takes add', 'takes remove', 'takes resolve', 'takes supersede', 'takes update',
]);

/**
 * Switches a command reads with `args.includes` whose name takes a value
 * elsewhere, or that no shared switch evidence (curated help, the operation
 * manifest) covers: `agent` has no curated help, so its `--follow` and
 * `--detach` need an entry here. The command's own reading wins.
 */
export const COMMAND_SWITCHES: Readonly<Record<string, readonly string[]>> = {
  sync: ['--detail'],
  schema: ['--fields'],
  agent: ['--follow', '--detach'],
  dream: ['--unsafe-bypass-dream-guard'],
  embed: ['--stale'],
  'edge-proposals': ['--all-held', '--all-applied'],
};

/** Value flags of a command with no curated help that every path reads as `--flag <value>` (migrate-engine.ts parseArgs, migrate-graduation.ts flagValue and routesToGraduation); their `=` form splits. */
export const COMMAND_VALUES: Readonly<Record<string, readonly string[]>> = {
  migrate: ['--to', '--url'],
};

/**
 * Paths (`command sub`) whose handler reads no value flag, only switches and
 * positionals: an `=` value flag there refuses with advice to drop it, never
 * `--flag <value>`, because the separate value would become the target
 * (edge-proposals.ts takes the first numeric token as the proposal id, so
 * `accept --limit 5 12` acts on proposal 5).
 */
export const NO_VALUE_FLAG_PATHS: ReadonlySet<string> = new Set([
  'edge-proposals show', 'edge-proposals accept', 'edge-proposals reject', 'edge-proposals undo', 'edge-proposals date', 'edge-proposals retry',
]);

/** Paths (`command sub`) whose handler treats a bare `--` as the end of its options; everywhere else the scan continues past it. */
export const END_OF_OPTIONS: ReadonlySet<string> = new Set(['agent run', 'frontmatter validate']);

/** Switch evidence by name: shared-op boolean parameters (handler-free manifest) and boolean flags in any command's curated help. Loaded only when an `=` token needs it. */
let switches: Promise<ReadonlySet<string>> | undefined;
export function knownSwitches(): Promise<ReadonlySet<string>> {
  return switches ??= (async () => {
    const out = new Set<string>();
    for (const op of OPERATION_MANIFEST) for (const [name, p] of Object.entries(op.params)) if (p.type === 'boolean') out.add(`--${name.replace(/_/g, '-')}`);
    for (const command of Object.keys(CLI_FLAG_REGISTRY)) for (const f of (await loadCuratedHelp(command))?.flags ?? []) if (f.type === 'boolean') out.add(f.name);
    return out;
  })();
}

const EQUALS_TOKEN = /^(--[a-z0-9][a-z0-9-]*|-[A-Za-z])=([\s\S]*)$/;

export async function splitFlagEquals(command: string, args: readonly string[]): Promise<{ args: string[] } | { refusal: OperationError }> {
  if (!args.some(a => /^-[^=\s]*=/.test(a))) return { args: [...args] };
  const legal = CLI_FLAG_REGISTRY[command];
  const keyed = READER_ALIASES[command] ?? command;
  const sub = command === 'sync' && args[0] !== 'unblock' && args[0] !== 'trigger' && args.includes('--status') ? 'status' : command === 'forget' && args.includes('--purge') ? '--purge' : args[0];
  const readers = [...EQUALS_READERS[keyed] ?? [], ...EQUALS_READERS[`${keyed} ${sub}`] ?? []];
  let types: Map<string, string> | undefined;
  const out: string[] = [];
  const where = args[0] && !args[0].startsWith('-') ? `gbrain ${command} ${args[0]}` : `gbrain ${command}`;
  let pastDashDash = false;
  let promptAt = -1;
  let tailAt = args.length;
  const values = new Set<number>();
  if (command === 'agent' && args[0] === 'run') {
    const { RUN_VALUE_FLAGS, BOOLEAN_TAIL_FLAGS } = await import('../commands/agent.ts');
    for (promptAt = 1; promptAt < args.length; promptAt++) {
      const t = args[promptAt]!;
      if (RUN_VALUE_FLAGS.has(t)) values.add(++promptAt);
      else if (!BOOLEAN_TAIL_FLAGS.has(t) && !(t.startsWith('--') && EQUALS_TOKEN.test(t))) break;
    }
    const dashAt = args.indexOf('--', promptAt);
    if (dashAt < 0) while (tailAt > promptAt && BOOLEAN_TAIL_FLAGS.has(args[tailAt - 1]!.split('=')[0]!) && !/\s/.test(args[tailAt - 1]!)) tailAt--;
    const stray = args.slice(promptAt, dashAt < 0 ? tailAt : dashAt).map(t => /^(--[a-z0-9][a-z0-9-]*)=([\s\S]*)$/.exec(t)).find(m => m !== null && (RUN_VALUE_FLAGS.has(m[1]!) || BOOLEAN_TAIL_FLAGS.has(m[1]!) && !/\s/.test(m[2]!)))?.[1];
    if (stray) return { refusal: usageError(`gbrain agent: \`${stray}=…\`: agent run reads its flags before the prompt, so this would be prompt text.`, `Write ${RUN_VALUE_FLAGS.has(stray) ? `${stray} <value>` : stray} before the prompt and ahead of any word agent run does not read (such as --json or --yes), or put -- before the prompt to keep it as text.`) };
  }
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--' && END_OF_OPTIONS.has(`${command} ${args[0]}`)) return { args: [...out, ...args.slice(i)] };
    if (values.has(i)) { out.push(token); continue; }
    if (i === promptAt && promptAt < tailAt) { out.push(...args.slice(i, tailAt)); i = tailAt - 1; continue; }
    pastDashDash ||= token === '--';
    const m = EQUALS_TOKEN.exec(token);
    const flag = m?.[1];
    if (flag !== undefined && !flag.startsWith('--') && !/\s/.test(token)) {
      return { refusal: usageError(`gbrain ${command}: \`${flag}=…\`: a short flag takes no =.`, `Write ${flag} on its own, or ${flag} <value> with the value as the next argument.`) };
    }
    const registered = flag !== undefined && (!legal || legal.includes(flag) || flag.startsWith('--no-') && legal.includes(`--${flag.slice(5)}`));
    const unvalidated = pastDashDash && !registered && /^--[^=\s]+=/.exec(token);
    if (unvalidated) return { refusal: usageError(`gbrain ${command}: \`${unvalidated[0]}…\`: not a flag of this command, and its handler reads flags after --.`, 'Check the spelling: flags are lowercase words joined by hyphens.') };
    if (!m || !registered || readers.includes(flag)) { out.push(token); continue; }
    const value = m[2]!;
    if (flag === '--json' && value === 'true') { out.push(flag); continue; }
    types ??= new Map((await loadCuratedHelp(command))?.flags.map(f => [f.name, f.type]));
    const own = types.get(flag) ?? (command === 'sync' ? (SYNC_FLAGS as Record<string, { arity: string }>)[flag]?.arity : undefined) ?? (COMMAND_VALUES[command]?.includes(flag) ? 'string' : undefined);
    const isSwitch = own !== undefined ? own === 'boolean' : flag.startsWith('--no-') || COMMAND_SWITCHES[command]?.includes(flag) || (await knownSwitches()).has(flag);
    const refusal = !legal
      ? [`${where} reads no = form`, `Check the flag in ${where} --help: write a switch on its own (a value never turns it off), or a value as the next argument.`]
      : isSwitch
      ? [`${flag} is a switch and takes no value`, `Write ${flag} on its own, or leave it out.`]
      : NO_VALUE_FLAG_PATHS.has(`${keyed} ${sub}`)
      ? [`${where} does not read ${flag}`, `Leave ${flag} out: written as ${flag} <value>, the value would be read as a positional argument (such as an id).`]
      : value === '' || /^-[-A-Za-z]/.test(value)
        ? [`the value is empty or looks like a flag`, `Write ${flag} <value> with the value as the next argument.`]
        : own === undefined && /^(true|false|yes|no|y|n|on|off|0|1)$/i.test(value)
          ? [`write ${flag} on its own if it is a switch, or with its value as the next argument`, `If ${flag} is a switch, write it on its own to turn it on, or leave it out to turn it off: a value never turns it off. If it takes a value, put the value in the next argument.`]
          : own === undefined
          ? [`this command takes ${flag} <value> as two arguments`, `Write ${flag} <value>, or ${flag} on its own if it is a switch.`]
          : null;
    if (refusal) return { refusal: usageError(`gbrain ${command}: \`${flag}=…\`: ${refusal[0]}.`, refusal[1]!) };
    out.push(flag, value);
  }
  return { args: out };
}

/** CLI_ONLY lane: token scan against the generated legal set. */
export function findUnknownFlag(args: string[], legal: ReadonlySet<string>): string | null {
  for (const a of args) {
    if (a === '--') break;
    const m = /^--([a-z0-9][a-z0-9-]*)(?:=[\s\S]*)?$/i.exec(a);
    if (!m) continue;
    // Casing typo = unknown flag: every handler in the repo is
    // case-sensitive-lowercase, so `--MIGRATE-ONLY` passing validation would
    // just be silently ignored downstream — the exact class this validator
    // exists to kill.
    if (/[A-Z]/.test(m[1])) return `--${m[1]}`;
    const name = `--${m[1]}`;
    if (legal.has(name)) continue;
    // --no-<flag> negation of a known flag is legal.
    if (name.startsWith('--no-') && legal.has(`--${name.slice(5)}`)) continue;
    return name;
  }
  return null;
}

/** auth.ts's direct `bun run` entry, in main's order: global flags stripped and applied, the `=` rule (`command sub` own `=` parsers pass through; auth has no whole-command own parser, strict spec or exempt path), and main's unknown-flag check with its envelope (legacy keys included). */
export async function directEntryArgs(command: string, raw: string[]): Promise<{ args: string[] } | { refusal: OperationError; legacy?: Record<string, string> }> {
  const { cliOpts, rest } = parseGlobalFlags(raw);
  setCliOptions(cliOpts);
  const split = OWN_EQUALS_PARSERS.has(`${command} ${rest[0]}`) ? { args: rest } : await splitFlagEquals(command, rest);
  if ('refusal' in split) return split;
  const unknown = findUnknownFlag(split.args, new Set(CLI_FLAG_REGISTRY[command]));
  if (!unknown) return split;
  const message = `unknown flag ${unknown} for 'gbrain ${command}'`;
  const known = (await loadCuratedHelp(command))?.flags.map(f => f.name) ?? CLI_FLAG_REGISTRY[command] ?? [];
  return { refusal: unknownFlagError(command, unknown, message, known), legacy: { status: 'error', reason: 'invalid_flag', message } };
}
