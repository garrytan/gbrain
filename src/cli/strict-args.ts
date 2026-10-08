/**
 * Strict arguments for destructive subcommands (#6114).
 *
 * A destructive subcommand that ignored a token it did not understand did
 * the destructive thing anyway: `pages purge-deleted --source x` purged
 * brain-wide, `--older-than=9999` silently became 72h. Each subcommand in
 * STRICT_SUBCOMMANDS declares exactly what it consumes; any other token, a
 * flag without its value, a repeated value flag or a value of the wrong
 * shape refuses with `invalid_params` (exit 2) before any engine or file
 * access. cli.ts consults the table after help is resolved (help always
 * wins) and before dispatch. Each refusal's fix is a real read-only command
 * that itself parses under this table, or, where none exists, an ask_user
 * fix naming the command.
 */
import { opError, type OperationError } from '../core/ops/contract.ts';
import type { Action } from '../core/agent-output.ts';

export const OLDER_THAN_RE = /^\d+[hd]?$/;

interface StrictSpec {
  /** Boolean flags (no value). */
  flags?: readonly string[];
  /** Value flags, each with the shape its value must have (null: any non-empty value). */
  values?: Readonly<Record<string, { re: RegExp; shape: string } | null>>;
  /** The most positional arguments it reads (a missing one is the handler's own usage error). */
  maxPositionals: number;
  /** The read-only command an agent runs instead (argv after `gbrain`), or ask_user. */
  fix: { argv: readonly string[]; why: string } | { ask_user: string };
  /** Applies only when this returns true (e.g. `search modes` only with `--reset`). */
  when?: (args: readonly string[]) => boolean;
  /** Extra why for specific refused flags. */
  refusedWhy?: Readonly<Record<string, string>>;
  /** The handler reads value flags only as `--flag value`, so a `--flag=value` form (which it would ignore) refuses. */
  separateValues?: true;
}

const SCHEMA_FIX = { argv: ['schema', 'active', '--json'], why: 'Shows the active schema pack and where it was resolved; changes nothing.' } as const;
const CACHE_FIX = { argv: ['cache', 'stats'], why: 'Shows the cache rows this command would touch; changes nothing.' } as const;
const PACK = { '--pack': null } as const;

export const STRICT_SUBCOMMANDS: Readonly<Record<string, StrictSpec>> = {
  'pages purge-deleted': {
    flags: ['--dry-run', '--json', '--yes'],
    values: { '--older-than': { re: OLDER_THAN_RE, shape: 'hours (72 or 72h) or days (3d)' } },
    maxPositionals: 0,
    fix: { argv: ['pages', 'purge-deleted', '--dry-run', '--json'], why: 'Lists the soft-deleted pages a brain-wide purge would remove; changes nothing.' },
    refusedWhy: {
      '--source': 'The purge is brain-wide: it removes soft-deleted pages from every source, and per-source purge is not supported.',
      '--source-id': 'The purge is brain-wide: it removes soft-deleted pages from every source, and per-source purge is not supported.',
    },
  },
  'cache clear': { flags: ['--yes', '-y'], values: { '--source': null }, separateValues: true, maxPositionals: 0, fix: CACHE_FIX },
  'cache prune': { maxPositionals: 0, fix: CACHE_FIX },
  'schema use': { maxPositionals: 1, fix: SCHEMA_FIX },
  'schema downgrade': { flags: ['--json'], values: { '--to': null }, separateValues: true, maxPositionals: 0, fix: SCHEMA_FIX },
  'schema init': { flags: ['--json'], maxPositionals: 1, fix: SCHEMA_FIX },
  'schema remove-type': { flags: ['--json'], values: PACK, maxPositionals: 1, fix: SCHEMA_FIX },
  'schema remove-alias': { flags: ['--json'], values: PACK, maxPositionals: 2, fix: SCHEMA_FIX },
  'schema remove-prefix': { flags: ['--json'], values: PACK, maxPositionals: 2, fix: SCHEMA_FIX },
  'schema remove-link-type': { flags: ['--json'], values: PACK, maxPositionals: 1, fix: SCHEMA_FIX },
  'integrity auto': {
    flags: ['--dry-run', '--fresh', '--skip-bare-tweet', '--skip-urls'],
    values: {
      '--confidence': { re: /^(?:0|1|0?\.\d+|1\.0+)$/, shape: 'a number from 0 to 1' },
      '--review-lower': { re: /^(?:0|1|0?\.\d+|1\.0+)$/, shape: 'a number from 0 to 1' },
      '--limit': { re: /^\d+$/, shape: 'a whole number' },
    },
    maxPositionals: 0,
    fix: { argv: ['integrity', 'check'], why: 'Reports the bare-tweet and external-link findings the repair loop would act on; changes nothing.' },
  },
  'integrity reset-progress': {
    maxPositionals: 0,
    fix: { ask_user: 'Clear the integrity repair progress log so the next `gbrain integrity auto` starts over?' },
  },
  'search modes': {
    flags: ['--reset', '--json'],
    values: { '--mode': null, '--source': null },
    separateValues: true,
    maxPositionals: 0,
    when: args => args.includes('--reset') || args.includes('--mode') || args.includes('--source'),
    fix: { argv: ['search', 'modes'], why: 'Shows every search.* override and its value; changes nothing.' },
  },
};

export interface StrictArgsProblem { token: string; problem: string }

/** The first problem with `args` (the tokens after the subcommand) under `spec`, or null. */
export function strictArgsProblem(spec: StrictSpec, args: readonly string[]): StrictArgsProblem | null {
  const flags = new Set(spec.flags ?? []);
  const values = spec.values ?? {};
  const seen = new Set<string>();
  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith('-')) {
      positionals++;
      if (positionals > spec.maxPositionals) return { token, problem: spec.maxPositionals === 0 ? 'takes no positional arguments' : `takes at most ${spec.maxPositionals} positional argument(s)` };
      continue;
    }
    const eq = token.indexOf('=');
    const name = token.startsWith('--') && eq > 0 ? token.slice(0, eq) : token;
    if (flags.has(name)) {
      if (name !== token) return { token, problem: `${name} takes no value` };
      continue;
    }
    if (!(name in values)) return { token, problem: 'is not an argument this subcommand reads' };
    if (spec.separateValues && name !== token) return { token, problem: `is not read in this form; write it as ${name} <value>` };
    if (seen.has(name)) return { token, problem: `${name} was given more than once` };
    seen.add(name);
    const value = name !== token ? token.slice(eq + 1) : args[i + 1];
    if (name === token) {
      if (value === undefined || value.startsWith('--')) return { token, problem: `${name} needs a value` };
      i++;
    }
    const shape = values[name];
    if (!value || (shape && !shape.re.test(value))) return { token: value || token, problem: `is not a valid ${name} value${shape ? ` (expected ${shape.shape})` : ''}` };
  }
  return null;
}

/** The `invalid_params` refusal for `gbrain <command> <sub> ...rest`, or null when the subcommand is not strict or the arguments parse. */
export function strictArgsRefusal(command: string, subArgs: readonly string[]): OperationError | null {
  const key = `${command} ${subArgs[0] ?? ''}`;
  const spec = STRICT_SUBCOMMANDS[key];
  if (!spec) return null;
  const rest = subArgs.slice(1);
  if (spec.when && !spec.when(rest)) return null;
  const p = strictArgsProblem(spec, rest);
  if (!p) return null;
  const name = p.token.split('=')[0]!;
  const why = [`gbrain ${key} refuses an argument it would ignore, because an ignored argument would still run the destructive command. Nothing was changed.`,
    spec.refusedWhy?.[name]].filter(Boolean).join(' ');
  const fix: Action = 'ask_user' in spec.fix
    ? { argv: ['gbrain', ...key.split(' ')], consent: ['destructive'], actor: 'agent', requires_exclusive: false,
      user_message: spec.fix.ask_user, why: 'No read-only form exists; run it without extra arguments only after the user agrees.' }
    : { argv: ['gbrain', ...spec.fix.argv], consent: [], actor: 'agent', requires_exclusive: false, why: spec.fix.why };
  return opError('invalid_params', `gbrain ${key}: \`${p.token}\` ${p.problem}.`,
    `Run \`gbrain ${key} --help\` for the accepted arguments.`, { why, fix });
}
