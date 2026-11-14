/**
 * GST-2476 G2: what gbrain git commit-push may do under GBRAIN_ENFORCED_MEMBER. Named-path commits, --dry-run and
 * --pull run (their output withheld by the caller); every other publishing mode is refused, and a named-path commit
 * refuses when the brain's access.enforced_member_writes is refuse. Each named path (a directory expands to its changed
 * files) must map to a source the member reads, must not be an access policy file, must not be a page the member cannot
 * read or a new page under a folder rule it does not satisfy, and its access and privacy labels must equal those at HEAD.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { execFileSync } from '../core/spawn.ts';
import type { BrainEngine } from '../core/engine.ts';
import { enforcedAccess, enforcedWritesMode, markdownLabels, memberPageView, refuseEnforced, refuseWritesOff } from './enforced-member.ts';

const VALUE_FLAGS = new Set(['-m', '--message', '--path', '--repo', '--base', '--branch', '--resolve', '--expect-remote']);
const REFUSED_FLAGS = new Set(['--pending', '--push-only', '--resolve', '--expect-remote', '--allow-outside-source-root', '--keep-checkout', '--branch', '--scan-secrets', '--install', '--uninstall', '--untrack']);

function gitOut(repo: string, args: string[]): string | null {
  try { return execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return null; }
}

export async function checkEnforcedCommitPush(engine: BrainEngine, args: readonly string[]): Promise<void> {
  const command = 'git commit-push';
  const ea = await enforcedAccess(engine, command);
  let path: string | undefined;
  let rest = false;
  let pull = false;
  let dryRun = false;
  const named: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (rest) { named.push(a); continue; }
    if (a === '--') { rest = true; continue; }
    const flag = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (REFUSED_FLAGS.has(flag)) return refuseEnforced(command, 'arguments_not_allowed', { engine });
    if (flag === '--pull') { pull = true; continue; }
    if (flag === '--dry-run') { dryRun = true; continue; }
    if (VALUE_FLAGS.has(flag)) {
      const v = a.includes('=') && a.startsWith('--') ? a.slice(a.indexOf('=') + 1) : args[++i];
      if (flag === '--path' || flag === '--repo') path = v;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (a === 'commit-push' && !named.length) continue;
    named.push(a);
  }
  if (pull && !named.length) return;
  if (!named.length) return dryRun ? undefined : refuseEnforced(command, 'arguments_not_allowed', { engine });
  if (!dryRun && await enforcedWritesMode(engine) === 'refuse') return refuseWritesOff(engine, command, 'refuse');
  const { checkoutRoot, scopePaths } = await import('../core/git/commit-push.ts');
  let repo: string;
  let files: string[];
  try {
    repo = realpathSync(checkoutRoot(path ?? process.cwd()));
    const cwd = path ? realpathSync(path) : process.cwd();
    files = [];
    for (const rel of scopePaths(repo, named, cwd)) {
      const abs = join(repo, rel);
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        const out = gitOut(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', rel]) ?? '';
        const parts = out.split('\0').filter(Boolean);
        for (let i = 0; i < parts.length; i++) {
          const entry = parts[i]!;
          files.push(entry.slice(3));
          if (entry[0] === 'R' || entry[0] === 'C') files.push(parts[++i]!);
        }
      } else files.push(rel);
    }
  } catch {
    return refuseEnforced(command, 'arguments_not_allowed', { engine });
  }
  const sources = await engine.executeRaw<{ id: string; local_path: string | null }>('SELECT id, local_path FROM sources WHERE local_path IS NOT NULL');
  const roots = sources.flatMap(s => {
    try { return s.local_path && isAbsolute(s.local_path) ? [{ id: s.id, root: realpathSync(s.local_path) }] : []; } catch { return []; }
  }).sort((a, b) => b.root.length - a.root.length);
  const { resolveSlugForPath } = await import('../core/sync.ts');
  for (const rel of files) {
    const abs = join(repo, rel);
    const owner = roots.find(r => abs === r.root || abs.startsWith(r.root + sep));
    if (!owner) return refuseEnforced(command, 'target_not_readable', { engine });
    const inSource = relative(owner.root, abs).split(sep).join('/');
    if (inSource === '.gbrain' || inSource.startsWith('.gbrain/')) return refuseEnforced(command, 'label_change', { engine });
    const slug = resolveSlugForPath(inSource);
    if (await memberPageView(engine, ea, owner.id, slug) === 'hidden') return refuseEnforced(command, 'target_not_readable', { engine });
    if (!/\.mdx?$/i.test(rel) || !existsSync(abs)) continue;
    const before = gitOut(repo, ['show', 'HEAD:' + rel]);
    if (await markdownLabels(before, slug) !== await markdownLabels(readFileSync(abs, 'utf8'), slug)) return refuseEnforced(command, 'label_change', { engine });
  }
}
