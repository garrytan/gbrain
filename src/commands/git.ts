/**
 * `gbrain git commit-push` (#6530): the one way an agent, cron or skill
 * commits and pushes in a brain checkout that other writers share. DB-free
 * and trusted-local only (it pushes with this host's git credentials); the
 * protocol lives in src/core/git/commit-push.ts.
 *
 *   gbrain git commit-push [--path <dir>] -m <msg> [--json] [--] <paths…>
 *   gbrain git commit-push --push-only [--keep-checkout] [--path <dir>] [--expect-remote <sha> --resolve <p>=ours|theirs|file:<f>…]
 *   gbrain git commit-push --pull [--path <dir>] [--require-clean]
 *   gbrain git commit-push --dry-run [--path <dir>] [-m <msg>] [--] <paths…>
 */
import { commitAndPush, checkoutRoot, pullShared, scopePaths, COMMIT_LOCK_NAME, type Resolution } from '../core/git/commit-push.ts';
import { appendPushLog } from '../core/brain-repo-durability.ts';
import { opError } from '../core/ops/contract.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { writeStdoutFinal } from '../core/cli-force-exit.ts';
import { execFileSync } from '../core/spawn.ts';
import { gitChildEnv } from '../core/git-env.ts';
import { GIT_ENV } from '../core/git-transport.ts';

const HELP = `Usage: gbrain git commit-push [--path <dir>] -m <msg> [--json] [--] <paths...>
       gbrain git commit-push --push-only [--path <dir>] [--branch <b>]
       gbrain git commit-push --push-only [--keep-checkout] [--path <dir>] --expect-remote <sha> --resolve <path>=ours|theirs|file:<file>...
       gbrain git commit-push --pull [--path <dir>] [--require-clean]

Commit only the named paths and push them, safely, in a checkout other agents
share: a short commit lock and a separate push lock per checkout, no
rebase/stash/reset of the working tree, remote commits merged in memory, and the
checkout advanced fast-forward only.

Flags:
  --path <dir>        Checkout to act on (default: the checkout containing the cwd).
  -m, --message <m>   Commit message (required unless --push-only or --pull).
  --push-only         Publish commits already on the branch; commit nothing.
  --branch <name>     With --push-only: publish HEAD to this remote branch (one exact name).
  --keep-checkout     With --push-only: never move the checkout and skip its pre-push hook. The one
                      publish allowed in a managed canonical worktree (its Git effects' integrate_conflict
                      fix); gbrain sources refresh brings the merged remote files in afterwards.
  --pull              Bring remote commits in (fast-forward, or an in-memory merge); never pushes.
  --require-clean     Unattended rule: --pull skips when the checkout has any local edit;
                      a push never advances a checkout that has one, and never waits for
                      another push (it asks that push to publish HEAD too: push_deferred).
  --resolve <p>=<v>   After integrate_conflict: which side wins for path p (ours, theirs, file:<merged copy>).
  --expect-remote <sha>  Required with --resolve: the remote commit the choice was made against
                      (printed by integrate_conflict); a remote that moved since is reported again.
  --dry-run           Print the paths, branch and lock that would be used; take no lock, write nothing.
  --json              One JSON result (or the error envelope) on stdout.

Paths are relative to --path when it is given (like git -C), else to the current
directory. Exit 0 on pushed, nothing_to_commit, push_deferred and
pushed_checkout_lagging (a notice names the blocking files); 4 when the commit is local but no push was
confirmed (push_unconfirmed); 1 on other failures, each with an "Error [<code>]" line. Guide: docs/guides/shared-checkout-git.md`;

interface Parsed {
  sub?: string; path?: string; message?: string; branch?: string; expectRemote?: string; json: boolean; pushOnly: boolean; pull: boolean;
  requireClean: boolean; dryRun: boolean; help: boolean; keepCheckout: boolean; paths: string[]; resolve: string[];
}

function parse(args: string[]): Parsed {
  const p: Parsed = { json: false, pushOnly: false, pull: false, requireClean: false, dryRun: false, help: false, keepCheckout: false, paths: [], resolve: [] };
  let rest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (rest) { p.paths.push(a); continue; }
    const take = (name: string): string => {
      const eq = a.indexOf('=');
      if (a.startsWith('--') && eq !== -1) return a.slice(eq + 1);
      const v = args[++i];
      if (v === undefined) throw opError('commit_paths_invalid', `${name} needs a value.`, HELP.split('\n')[0]);
      return v;
    };
    if (a === '--') rest = true;
    else if (a === '--help' || a === '-h') p.help = true;
    else if (a === '--json') p.json = true;
    else if (a === '--push-only') p.pushOnly = true;
    else if (a === '--keep-checkout') p.keepCheckout = true;
    else if (a === '--pull') p.pull = true;
    else if (a === '--require-clean') p.requireClean = true;
    else if (a === '--dry-run') p.dryRun = true;
    else if (a === '--path' || a.startsWith('--path=') || a === '--repo' || a.startsWith('--repo=')) p.path = take('--path');
    else if (a === '-m' || a === '--message' || a.startsWith('--message=')) p.message = take('--message');
    else if (a === '--resolve' || a.startsWith('--resolve=')) p.resolve.push(take('--resolve'));
    else if (a === '--branch' || a.startsWith('--branch=')) p.branch = take('--branch');
    else if (a === '--expect-remote' || a.startsWith('--expect-remote=')) p.expectRemote = take('--expect-remote');
    else if (!p.sub) p.sub = a;
    else if (a.startsWith('-')) throw opError('commit_paths_invalid', `Unknown flag ${a}.`, HELP.split('\n')[0]);
    else p.paths.push(a);
  }
  return p;
}

function parseResolutions(specs: string[]): Map<string, Resolution> {
  const out = new Map<string, Resolution>();
  for (const spec of specs) {
    const eq = spec.lastIndexOf('=');
    const path = eq > 0 ? spec.slice(0, eq) : '';
    const choice = eq > 0 ? spec.slice(eq + 1) : '';
    if (!path) throw opError('commit_paths_invalid', `--resolve ${spec} is not <path>=ours|theirs|file:<file>.`, 'Example: --resolve people/alice-example.md=theirs');
    if (choice === 'ours' || choice === 'theirs') out.set(path, { kind: choice });
    else if (choice.startsWith('file:') && choice.length > 5) out.set(path, { kind: 'file', path: choice.slice(5) });
    else throw opError('commit_paths_invalid', `--resolve ${spec}: choose ours, theirs or file:<merged copy>.`, 'Example: --resolve people/alice-example.md=theirs');
  }
  return out;
}

function emit(json: boolean, doc: Record<string, unknown>, human: string): void {
  if (json) void writeStdoutFinal(`${JSON.stringify(doc)}\n`);
  else console.log(human);
}

export async function runGit(args: string[]): Promise<number> {
  let json = args.includes('--json');
  try {
    const p = parse(args);
    json = p.json;
    if (p.help || !p.sub) { console.log(HELP); return p.sub || p.help ? 0 : 2; }
    if (p.sub !== 'commit-push') throw opError('commit_paths_invalid', `Unknown subcommand: gbrain git ${p.sub}.`, HELP.split('\n')[0]);
    const repo = checkoutRoot(p.path ?? process.cwd());
    const cwd = p.path ? repo : process.cwd();
    if ((p.pull && p.pushOnly) || (p.pull && (p.message || p.paths.length || p.resolve.length || p.branch))
      || (p.pushOnly && (p.message || p.paths.length)) || ((p.resolve.length || p.branch || p.expectRemote || p.keepCheckout) && !p.pushOnly)) {
      throw opError('commit_paths_invalid', 'These flags do not combine.',
        'Use one mode: -m <msg> -- <paths> (commit + push), --push-only [--keep-checkout] [--branch <b>] [--expect-remote <sha> --resolve ...], or --pull [--require-clean].');
    }
    if (Boolean(p.resolve.length) !== Boolean(p.expectRemote) || (p.expectRemote && !/^[0-9a-f]{7,64}$/i.test(p.expectRemote))) {
      throw opError('commit_paths_invalid', '--resolve and --expect-remote <sha> go together.',
        'Copy both from the integrate_conflict report: --expect-remote names the remote commit your choice was made against.');
    }

    if (p.dryRun) {
      const lock = execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', COMMIT_LOCK_NAME], { env: gitChildEnv({ ...GIT_ENV }) }).toString().trim();
      const branch = execFileSync('git', ['-C', repo, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { env: gitChildEnv({ ...GIT_ENV }) }).toString().trim();
      const paths = p.pull || p.pushOnly ? [] : scopePaths(repo, p.paths, cwd);
      emit(json, { dry_run: true, repo, branch, lock, paths, mode: p.pull ? 'pull' : p.pushOnly ? 'push-only' : 'commit-push' },
        `dry run: ${p.pull ? 'pull' : p.pushOnly ? 'push-only' : `commit ${paths.join(' ')}`} on ${branch} in ${repo} (lock ${lock}); nothing written`);
      return 0;
    }

    if (p.pull) {
      const r = pullShared(repo, { requireClean: p.requireClean });
      emit(json, { ...r, repo }, r.status === 'advanced' ? `advanced ${r.from!.slice(0, 7)}→${r.to!.slice(0, 7)}${r.merged ? ' (merged)' : ''}`
        : r.status === 'lagging' ? `not advanced: ${r.reason}` : r.status === 'skipped_dirty' ? 'skipped: the checkout has local edits (--require-clean)' : r.status.replace('_', ' '));
      if (r.status === 'lagging' && !json) process.stderr.write(`[gbrain notice] checkout not advanced: ${r.reason}. Rerun --pull once those edits are committed.\n`);
      return 0;
    }

    const result = commitAndPush({
      repo, cwd, paths: p.paths, message: p.message, pushOnly: p.pushOnly, advanceOnlyWhenClean: p.requireClean,
      ...(p.keepCheckout ? { keepCheckout: true } : {}),
      ...(p.branch ? { branch: p.branch } : {}),
      ...(p.resolve.length ? { resolutions: parseResolutions(p.resolve), expectRemote: p.expectRemote } : {}),
    });
    if (result.outcome === 'push_deferred') {
      emit(json, { ...result, repo }, `push deferred: another push is running in ${repo} and will publish HEAD too`);
      return 0;
    }
    appendPushLog(result.outcome === 'nothing_to_commit' || result.confirmed === 'remote' ? 'nothing' : result.integrated ? 'ok-after-merge' : 'ok',
      p.branch?.replace(/^refs\/heads\//, '') ?? result.branch, result.sha ?? '');
    if (result.outcome === 'pushed_checkout_lagging') appendPushLog('checkout-lagging', result.branch, result.sha ?? '', result.lagging_reason);
    const short = result.sha ? result.sha.slice(0, 7) : '-';
    emit(json, { ...result, repo },
      result.outcome === 'nothing_to_commit' ? `nothing to commit; ${result.remote}/${result.branch} at ${short}`
        : `pushed ${short} to ${result.remote}/${result.branch}${result.integrated ? `; merged ${result.integrated} remote commit(s)` : ''}; checkout ${result.checkout}`);
    if (result.outcome === 'pushed_checkout_lagging' && !json) {
      process.stderr.write(`[gbrain notice] the push landed but this checkout was not advanced: ${result.lagging_reason}. The next commit-push or --pull catches it up.\n`);
    }
    return 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'push_unconfirmed' || code === 'integrate_conflict') {
      try {
        const bi = args.indexOf('--branch');
        const branch = bi !== -1 && args[bi + 1] ? args[bi + 1].replace(/^refs\/heads\//, '') : currentBranchOf(args);
        appendPushLog(code === 'integrate_conflict' ? 'conflict' : 'local-only', branch, (e as { detail?: string }).detail ?? '');
      } catch { /* best-effort */ }
    }
    return writeCliError(e, 'git commit-push', { json });
  }
}

function currentBranchOf(args: string[]): string {
  const i = args.findIndex(a => a === '--path' || a === '--repo');
  const dir = i !== -1 ? args[i + 1] : process.cwd();
  return execFileSync('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { env: gitChildEnv({ ...GIT_ENV }), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}
