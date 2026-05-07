import { existsSync, lstatSync, realpathSync, statSync } from 'fs';
import { join, resolve } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import {
  addSubbrainToRegistry,
  loadSubbrainRegistry,
  removeSubbrainFromRegistry,
  saveSubbrainRegistry,
  validateSubbrainId,
} from '../core/subbrains.ts';

interface ParsedAddFlags {
  prefix?: string;
  default?: boolean;
}

export async function runSubbrain(engine: BrainEngine, args: string[]) {
  const action = args[0];
  if (!action || isHelpArg(action)) {
    console.log('Usage: mbrain subbrain <add|list|remove> ...');
    return;
  }

  switch (action) {
    case 'add':
      await add(engine, args.slice(1));
      return;
    case 'list':
      await list(engine, args.slice(1));
      return;
    case 'remove':
      await remove(engine, args.slice(1));
      return;
    default:
      throw new Error('Usage: mbrain subbrain <add|list|remove> ...');
  }
}

async function add(engine: BrainEngine, args: string[]) {
  if (args.some(isHelpArg)) {
    console.log('Usage: mbrain subbrain add <id> <path> [--prefix <prefix>] [--default]');
    return;
  }
  const id = args[0];
  const rawPath = args[1];
  if (!id || !rawPath) {
    throw new Error('Usage: mbrain subbrain add <id> <path> [--prefix <prefix>] [--default]');
  }

  const flags = parseAddFlags(args.slice(2));
  const repoPath = normalizeGitRepoPath(rawPath);
  const registry = addSubbrainToRegistry(await loadSubbrainRegistry(engine), {
    id,
    path: repoPath,
    prefix: flags.prefix,
    default: flags.default,
  });

  await saveSubbrainRegistry(engine, registry);
  const subbrain = registry.subbrains[validateSubbrainId(id)];
  console.log(`Added sub-brain ${subbrain.id}: ${subbrain.path} (prefix: ${subbrain.prefix})`);
}

async function list(engine: BrainEngine, args: string[]) {
  if (args.some(isHelpArg)) {
    console.log('Usage: mbrain subbrain list [--json]');
    return;
  }
  const unknown = args.filter(arg => arg !== '--json');
  if (unknown.length > 0) {
    throw new Error('Usage: mbrain subbrain list [--json]');
  }

  const registry = await loadSubbrainRegistry(engine);
  if (args.includes('--json')) {
    console.log(JSON.stringify(registry, null, 2));
    return;
  }

  const subbrains = Object.values(registry.subbrains);
  if (subbrains.length === 0) {
    console.log('No sub-brains registered.');
    return;
  }

  for (const subbrain of subbrains.sort((a, b) => a.id.localeCompare(b.id))) {
    const suffix = subbrain.default ? ' [default]' : '';
    console.log(`${subbrain.id}\t${subbrain.path}\tprefix=${subbrain.prefix}${suffix}`);
  }
}

async function remove(engine: BrainEngine, args: string[]) {
  if (args.some(isHelpArg)) {
    console.log('Usage: mbrain subbrain remove <id>');
    return;
  }
  const id = args[0];
  if (!id || args.length !== 1) {
    throw new Error('Usage: mbrain subbrain remove <id>');
  }

  const registry = await loadSubbrainRegistry(engine);
  const normalizedId = validateSubbrainId(id);
  if (!registry.subbrains[normalizedId]) {
    throw new Error(`Unknown sub-brain: ${normalizedId}`);
  }

  await saveSubbrainRegistry(engine, removeSubbrainFromRegistry(registry, normalizedId));
  console.log(`Removed sub-brain ${normalizedId}`);
}

function parseAddFlags(args: string[]): ParsedAddFlags {
  const flags: ParsedAddFlags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--default') {
      flags.default = true;
      continue;
    }
    if (arg === '--prefix') {
      const value = args[++i];
      if (!value) throw new Error('--prefix expects a value');
      flags.prefix = value;
      continue;
    }
    if (arg.startsWith('--prefix=')) {
      flags.prefix = arg.slice('--prefix='.length);
      continue;
    }
    throw new Error(`Unknown subbrain add flag: ${arg}`);
  }

  return flags;
}

function isHelpArg(arg: string): boolean {
  return arg === '--help' || arg === '-h';
}

function normalizeGitRepoPath(rawPath: string): string {
  const requested = resolve(rawPath);
  if (!existsSync(requested) || !statSync(requested).isDirectory()) {
    throw new Error(`Sub-brain path does not exist or is not a directory: ${rawPath}`);
  }
  if (lstatSync(requested).isSymbolicLink()) {
    throw new Error(`Sub-brain path must not be a symlink: ${rawPath}`);
  }

  const repoPath = realpathSync(requested);
  if (!existsSync(join(repoPath, '.git'))) {
    throw new Error(`Sub-brain path is not a git repository: ${repoPath}`);
  }
  return repoPath;
}
