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
 * scripts/check-public-surface.ts compares the manifest with the base branch's.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATION_MANIFEST } from '../src/core/operation-manifest.generated.ts';
import { CLI_COMMANDS } from '../src/cli/command-table.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { CODES, exitCodeForCode } from '../src/core/error-catalogue.ts';

export const MANIFEST = 'docs/contracts/public-surface.json';
export const SURFACES = ['cli-command', 'cli-flag', 'mcp-tool', 'mcp-param', 'config-key', 'exit-code'] as const;
export type Surface = (typeof SURFACES)[number];
export interface PublicSurface {
  version: 1;
  'cli-command': string[];
  'cli-flag': string[];
  'mcp-tool': string[];
  'mcp-param': string[];
  'config-key': string[];
  'exit-code': Record<string, number>;
}

const flag = (param: string) => `--${param.replace(/_/g, '-')}`;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

export async function buildSurface(): Promise<PublicSurface> {
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
    'cli-command': sorted(commands),
    'cli-flag': sorted(flags),
    'mcp-tool': sorted(tools),
    'mcp-param': sorted(params),
    'config-key': sorted(KNOWN_CONFIG_KEYS),
    'exit-code': exits,
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
