/**
 * `gbrain sources host-repo` (G7b-2, docs/designs/GIT_CANONICAL_MEMORY.md "Remote and hosted writes"): a hosted brain
 * keeps one bare repository per source, which is what a user clones and what pushes to the user's own remote. gbrain
 * checks it out once as a linked worktree it owns (`git worktree add`) and claims that worktree as the source's canonical
 * worktree through the ordinary claim, with every physical-root and manifest check. From then on the one door applies
 * unchanged: a door commit moves the branch the worktree shares with the bare repository; recovery, receipts, remote
 * writes and the push effect are the ones every strict source has.
 *
 * Nothing but the door moves the hosted branch. Git already refuses a push to a branch a worktree has checked out, but
 * that stops once the worktree is gone and pruned, so a pre-receive hook refuses every push itself. The door's commits
 * are local ref updates and never pass through receive-pack, and the push effect is outgoing, so the hook stops neither.
 *
 * Preview first: the dry run (the default without --expect) prints the plan in words, including that the source becomes
 * strict (`canonical: git`), and its plan_hash; the apply recomputes the plan and refuses `preview_changed` when it
 * moved. It starts only from an empty, unbound source and an absent or empty directory (`hosted_repo_refused`); adopting
 * existing pages is conversion (G8). On an already hosted source the preview reports the hook and the worktree link, and
 * the apply reinstalls a missing or changed hook. Trusted local CLI only: no operation exposes it.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { GIT_ENV } from '../git-remote.ts';
import { gitChildEnv } from '../git-env.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { execFileSync } from '../spawn.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { isValidSourceId } from '../source-id.ts';
import { containsPath, managedPersistenceEnabled } from './ownership.ts';
import { assertLinkedWorktreeIntact, linkedWorktreeProblem } from './worktree-link.ts';

export const HOSTED_BRANCH = 'main';
const HOOK_BANNER = '# gbrain hosted-repo pre-receive hook (G7b-2)';

export interface HostRepoOptions { sourceId: string; dir: string; pushRemote?: string; dryRun: boolean; expect?: string }
export type HookState = 'install' | 'ok' | 'missing' | 'changed';
export interface HostRepoPlan {
  source_id: string; dry_run: boolean; action: 'host' | 'reinstall_hook' | 'none';
  source: { registered: boolean; canonical: { before: string | null; after: 'git' } };
  repository: string; worktree: string; branch: string; push_remote: string | null;
  hook: { path: string; state: HookState }; worktree_link: 'ok' | 'broken' | 'absent';
  summary: string[]; next: string[][]; plan_hash: string; apply?: string[];
  claim?: Record<string, unknown>;
}
interface SourceRow { incarnation: string; archived: boolean; local_path: string | null; config: unknown }

const git = (cwd: string, args: string[], input?: string) => execFileSync('git', ['-C', cwd, ...args],
  { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000, env: gitChildEnv({ ...GIT_ENV }) }).trim();
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** The hook every hosted repository carries: it refuses every push and names the way in. */
export function hostedHookScript(sourceId: string): string {
  return ['#!/bin/sh', HOOK_BANNER,
    '# The branches of this repository move only through the gbrain door. Door commits are local ref updates and the',
    '# push to the user remote is outgoing, so neither passes this hook; every incoming push is refused.',
    `echo "gbrain: this repository holds source ${sourceId}; only the gbrain writer moves its branches, so this push was refused and nothing changed." >&2`,
    `echo "gbrain: write pages with gbrain put --source ${sourceId} or put_page over MCP, then fetch from here." >&2`,
    'exit 1', ''].join('\n');
}

/** Whether the repository's pre-receive hook is the one host-repo installs, and Git runs it from where it was installed. */
export function hostedHookState(repository: string, sourceId: string): Exclude<HookState, 'install'> {
  const path = join(repository, 'hooks', 'pre-receive');
  let stat;
  try { stat = statSync(path); } catch { return 'missing'; }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) return 'missing';
  if (readFileSync(path, 'utf8') !== hostedHookScript(sourceId)) return 'changed';
  let hooks: string;
  try { hooks = git(repository, ['rev-parse', '--git-path', 'hooks']); } catch { return 'changed'; }
  return real(resolve(repository, hooks)) === real(join(repository, 'hooks')) ? 'ok' : 'changed';
}

function installHook(repository: string, sourceId: string): void {
  mkdirSync(join(repository, 'hooks'), { recursive: true });
  const path = join(repository, 'hooks', 'pre-receive');
  writeFileSync(path, hostedHookScript(sourceId), { mode: 0o755 });
  chmodSync(path, 0o755);
  git(repository, ['config', 'core.hooksPath', join(repository, 'hooks')]);
}

function refused(reason: string, message: string, suggestion: string) {
  return opError('hosted_repo_refused', message, suggestion, { reason,
    fix: readFix('Lists the registered sources with their paths, read-only.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
}

function hasPassword(url: string): boolean {
  try { return !!new URL(url).password; } catch { return false; }
}

function hostedConfig(config: Record<string, unknown>): { repository: string; worktree: string; branch: string } | null {
  const hosted = config.hosted_repo as Record<string, unknown> | undefined;
  return hosted && typeof hosted.repository === 'string' && typeof hosted.worktree === 'string' && typeof hosted.branch === 'string'
    ? { repository: hosted.repository, worktree: hosted.worktree, branch: hosted.branch } : null;
}

/** The plan for `opts`, with every refusal a preview and an apply share. */
export async function planHostRepo(engine: BrainEngine, opts: HostRepoOptions): Promise<{ plan: HostRepoPlan; incarnation: string | null }> {
  if (!isValidSourceId(opts.sourceId)) throw opError('invalid_params', 'A valid source ID is required.',
    'Name the source by its ID: lowercase letters, digits and inner hyphens, at most 32 characters.');
  if (!isAbsolute(opts.dir) || opts.dir.includes('\0')) throw opError('invalid_params', '--dir must be an absolute path on this host.',
    'Pass the directory that will hold the hosted repository as an absolute path; nothing was created.');
  if (opts.pushRemote !== undefined && (!opts.pushRemote.trim() || hasPassword(opts.pushRemote))) throw opError('invalid_params',
    '--push-remote must be a repository URL without a password.',
    `Pass the URL alone, and after hosting wire a credential with gbrain sources writer git-durability ${opts.sourceId} --pat-file and a token file; nothing was created.`);
  if (!await managedPersistenceEnabled(engine)) throw opError('strict_requires_managed',
    `host-repo makes source ${opts.sourceId} git-canonical, which needs managed persistence on this brain; nothing was created.`,
    'Ask the user whether to turn on managed persistence for this brain (gbrain sources writer activate) before hosting a repository.');
  const dir = resolve(opts.dir);
  const [source] = await engine.executeRaw<SourceRow>('SELECT incarnation::text AS incarnation, archived, local_path, config FROM sources WHERE id=$1', [opts.sourceId]);
  const config = source ? parseSourceConfig(source.config) : {};
  const [binding] = await engine.executeRaw<{ worktree_id: string }>('SELECT worktree_id::text AS worktree_id FROM persistence_source_bindings WHERE source_id=$1', [opts.sourceId]);
  const hosted = hostedConfig(config);
  const before = typeof config.canonical === 'string' ? config.canonical : null;

  if (source?.archived) throw refused('source_archived', `Source ${opts.sourceId} is archived.`,
    `Restore it first (gbrain sources restore ${opts.sourceId}) or pick a new source ID; nothing was created.`);
  if (hosted && binding) {
    if (real(join(dir, 'repo.git')) !== real(hosted.repository)) throw refused('source_bound', `Source ${opts.sourceId} is already hosted at ${dirname(hosted.repository)}.`,
      `Preview it at its own directory with gbrain sources host-repo ${opts.sourceId} --dir ${dirname(hosted.repository)} --dry-run; nothing was changed.`);
    const state = hostedHookState(hosted.repository, opts.sourceId);
    const link = !existsSync(hosted.worktree) ? 'absent' : linkedWorktreeProblem(hosted.worktree) ? 'broken' : 'ok';
    const action = state === 'ok' ? 'none' : 'reinstall_hook';
    const plan_hash = sha256(JSON.stringify({ v: 1, action, source_id: opts.sourceId, incarnation: source!.incarnation, repository: hosted.repository, state }));
    return { incarnation: source!.incarnation, plan: {
      source_id: opts.sourceId, dry_run: opts.dryRun, action, source: { registered: true, canonical: { before, after: 'git' } },
      repository: hosted.repository, worktree: hosted.worktree, branch: hosted.branch, push_remote: null,
      hook: { path: join(hosted.repository, 'hooks', 'pre-receive'), state }, worktree_link: link,
      summary: [
        `Source ${opts.sourceId} is hosted at ${hosted.repository} and is git-canonical (strict).`,
        state === 'ok' ? 'The pre-receive hook that refuses every push is in place.'
          : `The pre-receive hook that refuses every push is ${state}; the apply reinstalls it.`,
        link === 'ok' ? 'The worktree gbrain commits through is linked to the repository.'
          : `The worktree gbrain commits through is ${link === 'absent' ? 'missing' : 'no longer linked to the repository'}; writes to this source cannot commit until it is restored (git worktree repair, or git worktree add).`,
      ], next: [], plan_hash } };
  }
  if (binding || hosted) throw refused('source_bound', `Source ${opts.sourceId} already has a canonical worktree.`,
    'host-repo starts a new hosted repository for an unbound source, and a bound source keeps its checkout; nothing was created.');
  if (source?.local_path) throw refused('source_has_path', `Source ${opts.sourceId} already has a directory (${source.local_path}).`,
    'host-repo gives a source a new repository; pick a new source ID, or keep this source on its directory. Nothing was created.');
  const [pages] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [opts.sourceId]);
  if (Number(pages?.n ?? 0) > 0) throw refused('source_has_pages', `Source ${opts.sourceId} already has ${pages!.n} page(s).`,
    'Moving existing pages into a hosted repository is conversion, which is not available yet (git-canonical wave G8); host a new, empty source instead. Nothing was created.');
  let dirState: 'absent' | 'empty' = 'absent';
  if (existsSync(dir)) {
    if (!lstatSync(dir).isDirectory() || readdirSync(dir).length) throw refused('dir_not_empty', `${dir} exists and is not an empty directory.`,
      'Pass a directory that does not exist yet, or an empty one; nothing was created.');
    dirState = 'empty';
  }
  let ancestor = dir; while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  let checkout: string | null = null;
  try { checkout = git(ancestor, ['rev-parse', '--show-toplevel']) || null; } catch { checkout = null; }
  if (checkout || linkedWorktreeProblem(ancestor)) throw opError('overlapping_path', `${dir} is inside the Git checkout ${checkout ?? ancestor}.`,
    "A hosted repository needs a directory outside every checkout, the brain's own and other sources' worktrees included; nothing was created.");
  const roots = await engine.executeRaw<{ id: string; path: string }>(
    `SELECT id, local_path AS path FROM sources WHERE local_path IS NOT NULL UNION ALL SELECT b.source_id AS id, h.local_path AS path
       FROM persistence_host_bindings h JOIN persistence_source_bindings b ON b.worktree_id=h.worktree_id WHERE h.local_path IS NOT NULL`);
  const target = join(real(ancestor), dir.slice(ancestor.length));
  const overlap = roots.find(row => containsPath(real(row.path), target) || containsPath(target, real(row.path)));
  if (overlap) throw opError('overlapping_path', `${dir} overlaps the directory of source ${overlap.id} (${overlap.path}).`,
    "Pick a directory outside every source's worktree; nothing was created.");

  const repository = join(dir, 'repo.git'), worktree = join(dir, 'worktree');
  const plan_hash = sha256(JSON.stringify({ v: 1, action: 'host', source_id: opts.sourceId, incarnation: source?.incarnation ?? null, canonical: before,
    dir, dir_state: dirState, branch: HOSTED_BRANCH, push: opts.pushRemote ? sha256(opts.pushRemote) : null, hook: sha256(hostedHookScript(opts.sourceId)) }));
  return { incarnation: source?.incarnation ?? null, plan: {
    source_id: opts.sourceId, dry_run: opts.dryRun, action: 'host', source: { registered: !!source, canonical: { before, after: 'git' } },
    repository, worktree, branch: HOSTED_BRANCH, push_remote: opts.pushRemote ?? null,
    hook: { path: join(repository, 'hooks', 'pre-receive'), state: 'install' }, worktree_link: 'absent',
    summary: [
      `Source ${opts.sourceId} becomes git-canonical (strict, canonical: git${before ? `, was ${before}` : ''}): every page write commits to Git through the door before the database indexes it, and the database is derived from the commits.`,
      `${source ? 'The source' : `A new source ${opts.sourceId}`} gets a bare repository at ${repository} on branch ${HOSTED_BRANCH} with one commit (an empty .gitignore); users clone it and fetch from it.`,
      `gbrain checks it out at ${worktree} as a linked worktree and claims it as the source's canonical worktree on this host.`,
      'A pre-receive hook refuses every push into the repository, so only the door moves its branch.',
      opts.pushRemote ? `Commits are pushed to ${opts.pushRemote} by the push effect once Git durability is enabled (the next step).` : 'No push remote: commits stay in the hosted repository.',
    ], next: opts.pushRemote ? [['gbrain', 'sources', 'writer', 'git-durability', opts.sourceId, '--enable', '--dry-run']] : [], plan_hash } };
}

/** Preview or apply the plan; the apply needs the plan_hash its preview printed. */
export async function hostRepo(engine: BrainEngine, opts: HostRepoOptions): Promise<HostRepoPlan> {
  const { plan, incarnation } = await planHostRepo(engine, opts);
  const preview = ['gbrain', 'sources', 'host-repo', opts.sourceId, '--dir', resolve(opts.dir), ...(opts.pushRemote ? ['--push-remote', opts.pushRemote] : [])];
  if (opts.dryRun || opts.expect === undefined) return { ...plan, dry_run: true, ...(plan.action === 'none' ? {} : { apply: [...preview, '--expect', plan.plan_hash] }) };
  if (opts.expect !== plan.plan_hash) throw opError('preview_changed', `The host-repo plan for source ${opts.sourceId} changed since its preview; nothing was changed.`,
    'Preview again and apply the plan_hash it prints.', { fix: readFix('Prints the current plan and its plan_hash; changes nothing.', { argv: [...preview, '--dry-run', '--json'] }) });
  if (plan.action === 'none') return plan;
  if (plan.action === 'reinstall_hook') { installHook(plan.repository, opts.sourceId); return { ...plan, hook: { ...plan.hook, state: 'ok' } }; }

  const dir = resolve(opts.dir), created = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  try {
    git(dir, ['init', '-q', '--bare', `--initial-branch=${plan.branch}`, plan.repository]);
    for (const [key, value] of [['receive.denyCurrentBranch', 'refuse'], ['receive.denyDeletes', 'true'], ['receive.denyNonFastForwards', 'true'],
      ['user.name', 'gbrain'], ['user.email', 'gbrain@localhost']] as const) git(plan.repository, ['config', key, value]);
    installHook(plan.repository, opts.sourceId);
    const blob = git(plan.repository, ['hash-object', '-w', '--stdin'], '');
    const tree = git(plan.repository, ['mktree'], `100644 blob ${blob}\t.gitignore\n`);
    const commit = git(plan.repository, ['commit-tree', tree, '-m', `gbrain: host source ${opts.sourceId}`]);
    git(plan.repository, ['update-ref', `refs/heads/${plan.branch}`, commit, '']);
    if (opts.pushRemote) {
      git(plan.repository, ['remote', 'add', 'origin', opts.pushRemote]);
      git(plan.repository, ['config', `branch.${plan.branch}.remote`, 'origin']);
      git(plan.repository, ['config', `branch.${plan.branch}.merge`, `refs/heads/${plan.branch}`]);
    }
    git(plan.repository, ['worktree', 'add', '-q', plan.worktree, plan.branch]);
    assertLinkedWorktreeIntact(plan.worktree);
    const { runManagedSourceLifecycle } = await import('./source-lifecycle.ts');
    const claim = await runManagedSourceLifecycle(engine, { operation: plan.source.registered ? 'claim' : 'add', sourceId: opts.sourceId, path: plan.worktree,
      ...(incarnation ? { expectedIncarnation: incarnation } : {}),
      config: { canonical: 'git', hosted_repo: { repository: plan.repository, worktree: plan.worktree, branch: plan.branch } } });
    return { ...plan, dry_run: false, hook: { ...plan.hook, state: 'ok' }, worktree_link: 'ok', claim };
  } catch (error) {
    if (created) rmSync(dir, { recursive: true, force: true });
    else for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
    throw error;
  }
}
