#!/usr/bin/env bun
/**
 * The public surface stable promises to keep (docs/STABILITY.md "What stays the same on stable"), as one generated
 * manifest: docs/contracts/public-surface.json.
 *
 *   bun scripts/build-public-surface.ts           write the manifest
 *   bun scripts/build-public-surface.ts --check   read-only: exit 1 when the committed manifest is stale (regen:all)
 *
 * Documented surfaces only, each named the way a deprecations.d record names it:
 *   cli-command  `gbrain <command>`: every operation's CLI name and aliases (hidden ones excluded) and every CLI_COMMANDS
 *                record; an operation with no CLI name is an MCP tool only, never a command
 *   cli-flag     `gbrain <command> --<flag>`: the parameters of an operation with a CLI name, and the curated help flags
 *                of CLI-only commands
 *   mcp-tool     `<tool>`: every operation an MCP client can call (not cliOnly)
 *   mcp-param    `<tool>.<param>`
 *   config-key   `<key>`: KNOWN_CONFIG_KEYS
 *   exit-code    `<code>`: the CLI exit code of every registered error code
 *   json-field   `gbrain <command> --json .<field>`: a field of a command's --json output
 * Plus the skill resolver surface that outside skill sets build on (their CI and setup call it): the resolver
 * subcommands of `gbrain skills` with all their flags, `gbrain skillpack health` and `doctor`,
 * `gbrain setup --skill-loading`, the resolver's documented config keys and the turn-output fields it reads. Each is read
 * from the code that accepts it and listed only while the code still does, so dropping one is a removal the check sees;
 * the one exception is `skills.resolver.pins.<catalog>`, which `gbrain skills pin` writes and this list names by hand.
 * scripts/check-public-surface.ts compares the manifest with the base branch's.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATION_MANIFEST } from '../src/core/operation-manifest.generated.ts';
import { CLI_COMMANDS } from '../src/cli/command-table.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { CODES, exitCodeForCode } from '../src/core/error-catalogue.ts';
import { SKILLS_RESOLVER_CLI } from '../src/commands/skill-resolver.ts';
import { SKILLPACK_SUBCOMMANDS } from '../src/commands/skillpack.ts';
import { VALUE_FLAGS as SETUP_VALUE_FLAGS } from '../src/commands/setup.ts';
import { SKILL_RESOLVER_CONFIG_LEAVES } from '../src/core/setup/skill-resolver-config.ts';
import type { Suggestion, TurnOutput } from '../src/core/skills/resolver/resolve.ts';

export const MANIFEST = 'docs/contracts/public-surface.json';
export const SURFACES = ['cli-command', 'cli-flag', 'mcp-tool', 'mcp-param', 'config-key', 'exit-code', 'json-field'] as const;
export type Surface = (typeof SURFACES)[number];
export interface PublicSurface {
  version: 1;
  'cli-command': string[];
  'cli-flag': string[];
  'mcp-tool': string[];
  'mcp-param': string[];
  'config-key': string[];
  'exit-code': Record<string, number>;
  'json-field': string[];
}

const flag = (param: string) => `--${param.replace(/_/g, '-')}`;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

function skillResolverSurface() {
  const commands: string[] = [];
  const flags: string[] = [];
  for (const [name, spec] of Object.entries(SKILLS_RESOLVER_CLI)) {
    const command = `gbrain skills ${name}`;
    commands.push(command, ...spec.subcommands.map(s => `${command} ${s}`));
    for (const f of [...spec.valued, ...spec.booleans]) flags.push(`${command} ${f}`);
  }
  for (const s of ['health', 'doctor']) if ((SKILLPACK_SUBCOMMANDS as readonly string[]).includes(s)) commands.push(`gbrain skillpack ${s}`);
  if (SETUP_VALUE_FLAGS.has('--skill-loading')) flags.push('gbrain setup --skill-loading');
  const leaves = ['top_k', 'top_gate', 'pinned', 'session_token_budget', 'per_harness.<harness>.dirs'].filter(l => (SKILL_RESOLVER_CONFIG_LEAVES as readonly string[]).includes(l));
  const configKeys = [...leaves.map(l => `skills.resolver.${l}`), 'skills.resolver.pins.<catalog>'];
  const turnFields: Array<keyof TurnOutput> = ['block', 'no_skill'];
  const suggestionFields: Array<keyof Suggestion> = ['id'];
  const jsonFields = [...turnFields.map(f => `gbrain skills resolve --json .${f}`), ...suggestionFields.map(f => `gbrain skills resolve --json .suggestions[].${f}`), 'gbrain bundled-skill --json .skills_root'];
  return { commands, flags, configKeys, jsonFields };
}

export async function buildSurface(): Promise<PublicSurface> {
  const resolver = skillResolverSurface();
  const commands: string[] = [];
  const flags: string[] = [];
  const tools: string[] = [];
  const params: string[] = [];
  for (const op of OPERATION_MANIFEST) {
    if (!op.cliOnly) {
      tools.push(op.name);
      for (const p of Object.keys(op.params)) params.push(`${op.name}.${p}`);
    }
    if (op.cliHints?.hidden || !op.cliHints?.name) continue;
    for (const name of [op.cliHints.name, ...(op.cliHints.aliases ?? [])]) {
      commands.push(`gbrain ${name}`);
      for (const p of Object.keys(op.params)) flags.push(`gbrain ${name} ${flag(p)}`);
    }
  }
  for (const record of CLI_COMMANDS) {
    commands.push(`gbrain ${record.name}`);
    if (record.help) for (const f of (await record.help()).help.flags) flags.push(`gbrain ${record.name} ${f.name}`);
  }
  const exits: Record<string, number> = {};
  for (const code of Object.keys(CODES).sort()) exits[code] = exitCodeForCode(code);
  return {
    version: 1,
    'cli-command': sorted([...commands, ...resolver.commands]),
    'cli-flag': sorted([...flags, ...resolver.flags]),
    'mcp-tool': sorted(tools),
    'mcp-param': sorted(params),
    'config-key': sorted([...KNOWN_CONFIG_KEYS, ...resolver.configKeys]),
    'exit-code': exits,
    'json-field': sorted(resolver.jsonFields),
  };
}

export const render = (surface: PublicSurface) => JSON.stringify(surface, null, 2) + '\n';

export async function main(argv: string[], root = process.cwd()): Promise<number> {
  const text = render(await buildSurface());
  const path = join(root, MANIFEST);
  if (argv.includes('--check')) {
    if (existsSync(path) && readFileSync(path, 'utf8') === text) return 0;
    console.error(`FAIL: ${MANIFEST} is stale.\nFix:  bun scripts/build-public-surface.ts (or bun run regen:all), then commit it.\nSee:  docs/STABILITY.md#what-stays-the-same-on-stable`);
    return 1;
  }
  writeFileSync(path, text);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
