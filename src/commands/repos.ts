/**
 * CLI: gbrain repos list|add|remove
 * Multi-repo management for code + knowledge indexing.
 */

import { resolve } from 'path';
import { existsSync } from 'fs';
import {
  loadRepoConfigs,
  addRepoConfig,
  removeRepoConfig,
  normalizeRepoName,
  type RepoStrategy,
} from '../core/multi-repo.ts';

export async function handleRepos(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === 'list') {
    return reposList();
  }

  if (sub === 'add') {
    return reposAdd(args.slice(1));
  }

  if (sub === 'remove' || sub === 'rm') {
    return reposRemove(args.slice(1));
  }

  console.error(`Unknown repos subcommand: ${sub}`);
  console.error('Usage: gbrain repos [list|add|remove]');
  process.exit(1);
}

function reposList(): void {
  const repos = loadRepoConfigs();

  if (repos.length === 0) {
    console.log('No repos configured. Use `gbrain repos add <path>` to add one.');
    return;
  }

  console.log(`${repos.length} repo(s) configured:\n`);
  for (const repo of repos) {
    const enabled = repo.syncEnabled !== false ? '✓' : '✗';
    const includes = repo.include?.length ? ` include=[${repo.include.join(',')}]` : '';
    const excludes = repo.exclude?.length ? ` exclude=[${repo.exclude.join(',')}]` : '';
    console.log(`  ${enabled} ${repo.name} (${repo.strategy}) → ${repo.path}${includes}${excludes}`);
  }
}

function reposAdd(args: string[]): void {
  if (args.length === 0) {
    console.error('Usage: gbrain repos add <path> [--name <name>] [--strategy markdown|code|auto]');
    process.exit(1);
  }

  const repoPath = resolve(args[0]);

  if (!existsSync(repoPath)) {
    console.error(`Path does not exist: ${repoPath}`);
    process.exit(1);
  }

  let name = normalizeRepoName(repoPath);
  let strategy: RepoStrategy = 'auto';
  const include: string[] = [];
  const exclude: string[] = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      name = args[++i];
    } else if (args[i] === '--strategy' && args[i + 1]) {
      const s = args[++i];
      if (s === 'markdown' || s === 'code' || s === 'auto') {
        strategy = s;
      } else {
        console.error(`Invalid strategy: ${s}. Must be markdown, code, or auto.`);
        process.exit(1);
      }
    } else if (args[i] === '--include' && args[i + 1]) {
      include.push(args[++i]);
    } else if (args[i] === '--exclude' && args[i + 1]) {
      exclude.push(args[++i]);
    }
  }

  try {
    const repos = addRepoConfig({
      path: repoPath,
      name,
      strategy,
      include: include.length > 0 ? include : undefined,
      exclude: exclude.length > 0 ? exclude : undefined,
      syncEnabled: true,
    });
    console.log(`Added repo "${name}" (${strategy}) → ${repoPath}`);
    console.log(`${repos.length} repo(s) total. Run \`gbrain sync --all\` to index.`);
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

function reposRemove(args: string[]): void {
  if (args.length === 0) {
    console.error('Usage: gbrain repos remove <name>');
    process.exit(1);
  }

  const name = args[0];

  try {
    const repos = removeRepoConfig(name);
    console.log(`Removed repo "${name}". ${repos.length} repo(s) remaining.`);
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
