/**
 * Argument parsing for `gbrain schema add-type` (#6135).
 *
 *   gbrain schema add-type <name> --primitive <p> (--prefix <dir/> | --no-prefix)
 *     [--extractable] [--expert] [--alias <a>]... [--pack <name>] [--json]
 *
 * The type name is the first positional that is not a flag value (so
 * `--primitive concept archive` names the type `archive`). A type needs a path
 * prefix or an explicit `--no-prefix` (a frontmatter-only type); leaving out
 * both stays refused so a forgotten `--prefix` never creates a type nothing
 * infers. Every refusal is an agent-first `invalid_params` (exit 2) thrown
 * before the pack is touched.
 */
import type { OperationError } from '../core/ops/contract.ts';
import { PACK_PRIMITIVES, type PackPrimitive } from '../core/schema-pack/manifest-v1.ts';
import { usageError } from '../cli/cli-error.ts';

export interface AddTypeArgs {
  name: string;
  primitive: PackPrimitive;
  prefix?: string;
  noPrefix: boolean;
  extractable: boolean;
  expert: boolean;
  aliases: string[];
}

export const NO_PREFIX_NOTE = 'No path prefix: pages get this type only from frontmatter `type:`; it is never inferred from a file path.';

const USAGE = 'gbrain schema add-type <name> --primitive <p> (--prefix <dir/> | --no-prefix) [--extractable] [--expert] [--alias <a>] [--pack <name>] [--json]';
const VALUE_FLAGS = new Set(['--primitive', '--prefix', '--alias', '--pack', '--source', '--source-id']);
const NO_PREFIX_CONFLICTS: Record<string, string> = {
  '--extractable': 'Extractable types are checked through their path prefixes (lint rule extractable_empty_corpus), so a type without one cannot be extractable.',
  '--expert': 'Expert routing without a path prefix silently misses content (lint rule expert_routing_without_prefix).',
  '--expert-routing': 'Expert routing without a path prefix silently misses content (lint rule expert_routing_without_prefix).',
};

const INPUT_HOW: Record<string, string> = {
  NAME: 'The new type name, a slug such as researcher or archive.',
  PRIMITIVE: `One of ${PACK_PRIMITIVES.join(', ')}.`,
  PREFIX: 'The directory the type\'s pages live in, ending in / (for example people/researchers/). For a type set by frontmatter only, use --no-prefix instead of --prefix <PREFIX>.',
};

/** Drop a value flag (both `--f v` and `--f=v`) from argv. */
function withoutFlag(args: string[], flag: string): string[] {
  return args.filter((a, i) => !(a === flag || a.startsWith(`${flag}=`) || args[i - 1] === flag));
}

/** One complete corrected command: every missing piece becomes a `<PLACEHOLDER>` named in `inputs`. */
function refusal(message: string, suggestion: string, why: string, argv: string[]): OperationError {
  const inputs = Object.keys(INPUT_HOW).filter(n => argv.includes(`<${n}>`)).map(name => ({ name, how: INPUT_HOW[name]! }));
  return usageError(message, suggestion, {
    why,
    fix: { argv: ['gbrain', 'schema', 'add-type', ...argv], ...(inputs.length ? { inputs } : {}), consent: [], actor: 'agent', requires_exclusive: false,
      why: 'The corrected command adds the type.' },
  });
}

/** Parse `schema add-type` args; throws an `invalid_params` OperationError on any refusal. */
export function parseAddTypeArgs(args: string[]): AddTypeArgs {
  const positional: string[] = [];
  const aliases: string[] = [];
  const values: Record<string, string | undefined> = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (!flag.startsWith('--')) { positional.push(a); continue; }
    seen.add(flag);
    if (!VALUE_FLAGS.has(flag)) continue;
    const value = flag !== a ? a.slice(eq + 1) : args[++i];
    if (flag === '--alias') { if (value !== undefined) aliases.push(value); } else values[flag] = value;
  }
  const name = positional[0];
  const primitive = values['--primitive'];
  const validPrimitive = !!primitive && (PACK_PRIMITIVES as readonly string[]).includes(primitive);
  const prefix = values['--prefix'];
  const noPrefix = seen.has('--no-prefix');
  const repaired = [
    ...(name ? [] : ['<NAME>']),
    ...(validPrimitive ? args : withoutFlag(args, '--primitive')),
    ...(validPrimitive ? [] : ['--primitive', '<PRIMITIVE>']),
    ...(prefix || noPrefix ? [] : ['--prefix', '<PREFIX>']),
  ];
  if (!name) {
    throw refusal('schema add-type needs a type name.', `Usage: ${USAGE}`, 'The type name is the first argument that is not a flag value.', repaired);
  }
  if (!validPrimitive) {
    throw refusal(`--primitive must be one of ${PACK_PRIMITIVES.join('|')}`, `Usage: ${USAGE}`, 'Every page type maps to one primitive.', repaired);
  }
  const withoutNoPrefix = args.filter(a => a !== '--no-prefix');
  if (noPrefix && prefix !== undefined) {
    throw refusal('--prefix and --no-prefix cannot be combined.', 'Keep --prefix <dir/> for a type inferred from file paths, or only --no-prefix for a type set by frontmatter only.',
      '--no-prefix declares a type with no path prefix, which contradicts --prefix.', withoutNoPrefix);
  }
  const conflict = noPrefix ? Object.keys(NO_PREFIX_CONFLICTS).find(f => seen.has(f)) : undefined;
  if (conflict) {
    throw refusal(`--no-prefix cannot be combined with ${conflict}.`, `Give the type a prefix (--prefix people/researchers/) or drop ${conflict}.`,
      NO_PREFIX_CONFLICTS[conflict]!, [...withoutNoPrefix, '--prefix', '<PREFIX>']);
  }
  if (!prefix && !noPrefix) {
    throw refusal('schema add-type needs --prefix <dir/> or --no-prefix.',
      `Pass the directory its pages live in (--prefix people/researchers/), or --no-prefix for a type set by frontmatter only: gbrain schema add-type ${name} --primitive ${primitive} --no-prefix`,
      'A path prefix lets gbrain infer the type from where a file lives; --no-prefix declares a type pages get only from frontmatter `type:`. Leaving out both is refused so a forgotten --prefix never creates a type nothing infers.',
      repaired);
  }
  return {
    name, primitive: primitive as PackPrimitive, prefix, noPrefix,
    extractable: seen.has('--extractable'), expert: seen.has('--expert') || seen.has('--expert-routing'), aliases,
  };
}
