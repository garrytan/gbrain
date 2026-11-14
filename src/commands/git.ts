/**
 * `gbrain git commit-push` (#6530): the one way an agent, cron or skill
 * commits and pushes in a brain checkout that other writers share. DB-free
 * and trusted-local only (it pushes with this host's git credentials); the
 * protocol lives in src/core/git/commit-push.ts.
 *
 *   gbrain git commit-push [--path <dir>] -m <msg> [--json] [--] <paths…>
 *   gbrain git commit-push --push-only [--keep-checkout] [--path <dir>] [--expect-remote <sha> --resolve <p>=ours|theirs|file:<f>…]
 *   gbrain git commit-push --pull [--path <dir>] [--require-clean]
 *   gbrain git commit-push --untrack [--path <dir>] -m <msg> [--] <paths…>
 *   gbrain git commit-push --dry-run [--untrack] [--path <dir>] [-m <msg>] [--] <paths…>
 *   gbrain git commit-push --pending [--path <dir>] [-m <msg>]
 *   gbrain git guard [--install | --uninstall] [--path <dir>] [--json]
 *   gbrain git scan [--path <dir>] [--from <rev>] [--to <rev>] [--scan-timeout <s>] [--json]
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { commitAndPush, checkoutRoot, previewPaths, previewUntrack, pullShared, scopePaths, COMMIT_LOCK_NAME, SOURCE_ROOT_CONFIG, type Resolution } from '../core/git/commit-push.ts';
import { guardStatus, installGuard, uninstallGuard } from '../core/git/commit-guard.ts';
import { appendPushLog } from '../core/brain-repo-durability.ts';
import { opError } from '../core/ops/contract.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { writeStdoutFinal } from '../core/cli-force-exit.ts';
import { execFileSync } from '../core/spawn.ts';
import { gitChildEnv } from '../core/git-env.ts';
import { GIT_ENV } from '../core/git-transport.ts';
import { managedFilesystemRootFor, staleEnclosingMarker } from '../core/persistence/filesystem-guard.ts';
import { rangeSecretRefusal, scanRange } from '../core/git/range-secret-scan.ts';
import { canonicalFilesystemPath, checkoutGitMetadata, managedRootMarkerFor, registeredManagedRootRecords } from '../core/persistence/root-registry.ts';

const HELP = `Usage: gbrain git commit-push [--path <dir>] -m <msg> [--json] [--] <paths...>
       gbrain git commit-push --push-only [--path <dir>] [--branch <b>]
       gbrain git commit-push --push-only [--keep-checkout] [--path <dir>] --expect-remote <sha> --resolve <path>=ours|theirs|file:<file>...
       gbrain git commit-push --pull [--path <dir>] [--require-clean]
       gbrain git commit-push --pending [--path <dir>] [-m <msg>]
       gbrain git commit-push --untrack [--path <dir>] -m <msg> [--] <paths...>
       gbrain git guard [--install | --uninstall] [--path <dir>] [--json]
       gbrain git scan [--path <dir>] [--from <rev>] [--to <rev>] [--scan-timeout <s>] [--json]

Commit only the named paths and push them, safely, in a checkout other agents
share: a short commit lock and a separate push lock per checkout, no
rebase/stash/reset of the working tree, remote commits merged in memory, and the
checkout advanced fast-forward only. In a managed canonical worktree it only
commits the named paths (committed_local): no fetch, merge, push or checkout
move; the owner's next Git publish, or --push-only --keep-checkout, pushes it.
In a checkout with no Git remote it also only commits the named paths
(committed_local, no_remote); the publishing modes are refused there.

Flags:
  --path <dir>        Checkout to act on (default: the checkout containing the cwd).
  -m, --message <m>   Commit message (required unless --push-only or --pull); repeat it, like git
                      commit, for more paragraphs (a second -m <trailer> is the body).
  --push-only         Publish commits already on the branch; commit nothing.
  --branch <name>     With --push-only: publish HEAD to this remote branch (one exact name).
  --keep-checkout     With --push-only: never move the checkout and skip its pre-push hook. The one
                      publish allowed in a managed canonical worktree (its Git effects' integrate_conflict
                      fix); gbrain sources refresh brings the merged remote files in afterwards.
  --scan-secrets      Accepted for older scripts: every push scans what the unpublished commits add
                      (messages, added lines, merge resolutions) and refuses publish_secret_found on a finding.
  --scan-timeout <s>  The secret scan's time budget in seconds (default 300); a first push of a long
                      history may need more. The scan still reads every commit.
  --pull              Bring remote commits in (fast-forward, or an in-memory merge); never pushes.
  --require-clean     Unattended rule: --pull skips when the checkout has any local edit;
                      a push never advances a checkout that has one, and never waits for
                      another push (it asks that push to publish HEAD too: push_deferred).
  --base <p>=<blob>   Refuse (commit_base_moved) unless path p's blob at HEAD is still <blob> (full object
                      id, or absent for a new file); repeat per path. Each p must also be committed.
  --resolve <p>=<v>   After integrate_conflict: which side wins for path p (ours, theirs, file:<merged copy>).
  --expect-remote <sha>  Required with --resolve: the remote commit the choice was made against
                      (printed by integrate_conflict); a remote that moved since is reported again.
  --pending           Commit the write-through files gbrain wrote but could not commit (the pending
                      ledger doctor's dirty_age reports), then push.
  --allow-outside-source-root  Commit and publish files outside the checkout's source root(s)
                      (git config gbrain.sourceRoot); only after the user agrees.
  --untrack           Remove the named paths from Git (git rm --cached), keeping the files on disk; a
                      directory untracks every file Git holds under it. In a managed canonical worktree
                      only files under a storage.db_only dir that gbrain.yml at HEAD declares and
                      .gitignore ignores; it commits there and never pushes.
  --dry-run           Print the paths, branch and lock that would be used, and the marker that makes the
                      checkout a managed canonical worktree (or none); take no lock, write nothing.
                      The real run's path checks run first and refuse as it would (a path outside the
                      source root or a sparse-checkout definition, a moved --base, another writer's file).
  --json              One JSON result (or the error envelope) on stdout.

Paths are relative to --path when it is given (like git -C), else to the current
directory. Exit 0 on pushed, committed_local, nothing_to_commit, push_deferred and
pushed_checkout_lagging (a notice names the blocking files); 4 when the commit is local but no push was
confirmed (push_unconfirmed); 1 on other failures, each with an "Error [<code>]" line. Guide: docs/guides/shared-checkout-git.md

gbrain git guard [--install | --uninstall]: the opt-in commit guard, a local
prepare-commit-msg hook that refuses commits in this checkout not made through
gbrain (git commit, -a and --no-verify included; merges and commits that finish a
merge, cherry-pick, revert or rebase pass). A person bypasses it once with
GBRAIN_COMMIT_GUARD=off git <command>. Without a flag it prints whether the guard
is installed.

gbrain git scan: the secret scan a push runs, over --from..--to (default: the
upstream as last fetched, ..HEAD), with the checkout's .gbrain-scan-allow. It
fetches, locks, writes and pushes nothing. It prints what a push would refuse
(would_refuse) and each finding's path, line, rule, commit and fingerprint, never
the value; a finding's fingerprint line in .gbrain-scan-allow accepts that value.
Exit 0 when the scan ran, whatever it found.`;

interface Parsed {
  sub?: string; path?: string; message?: string; branch?: string; expectRemote?: string; json: boolean; pushOnly: boolean; pull: boolean;
  requireClean: boolean; dryRun: boolean; help: boolean; keepCheckout: boolean; paths: string[]; resolve: string[]; base: string[]; untrack: boolean;
  pending: boolean; allowOutside: boolean; install: boolean; uninstall: boolean; scanSecrets: boolean; scanTimeout?: string; from?: string; to?: string;
}

function parse(args: string[]): Parsed {
  const p: Parsed = { json: false, pushOnly: false, pull: false, requireClean: false, dryRun: false, help: false, keepCheckout: false, paths: [], resolve: [], base: [], untrack: false,
    pending: false, allowOutside: false, install: false, uninstall: false, scanSecrets: false };
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
    else if (a === '--scan-secrets') p.scanSecrets = true;
    else if (a === '--pull') p.pull = true;
    else if (a === '--require-clean') p.requireClean = true;
    else if (a === '--dry-run') p.dryRun = true;
    else if (a === '--untrack') p.untrack = true;
    else if (a === '--pending') p.pending = true;
    else if (a === '--allow-outside-source-root') p.allowOutside = true;
    else if (a === '--install') p.install = true;
    else if (a === '--uninstall') p.uninstall = true;
    else if (a === '--path' || a.startsWith('--path=') || a === '--repo' || a.startsWith('--repo=')) p.path = take('--path');
    else if (a === '-m' || a === '--message' || a.startsWith('--message=')) { const m = take('--message'); p.message = p.message === undefined ? m : `${p.message}\n\n${m}`; }
    else if (a === '--resolve' || a.startsWith('--resolve=')) p.resolve.push(take('--resolve'));
    else if (a === '--base' || a.startsWith('--base=')) p.base.push(take('--base'));
    else if (a === '--branch' || a.startsWith('--branch=')) p.branch = take('--branch');
    else if (a === '--expect-remote' || a.startsWith('--expect-remote=')) p.expectRemote = take('--expect-remote');
    else if (a === '--scan-timeout' || a.startsWith('--scan-timeout=')) p.scanTimeout = take('--scan-timeout');
    else if (a === '--from' || a.startsWith('--from=')) p.from = take('--from');
    else if (a === '--to' || a.startsWith('--to=')) p.to = take('--to');
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

/**
 * #8662: on a host whose brain records its source checkouts, a checkout resolved from the working directory that is none of
 * them and carries no mark of a gbrain brain checkout is refused before anything is staged (a wrapper that changed into
 * another repository). A legacy source is not in that record, so `gbrain sources harden`'s marks admit it: a
 * gbrain.sourceRoot or gbrain.cliPath entry, or the committed scripts/brain-commit-push.sh (whose own calls pass no --path).
 * An explicit --path names its checkout and is not checked here. GST-1623: a registered checkout must contain the resolved
 * one, or be a directory of it that its HEAD tracks; a repository that only encloses a registered checkout (a nested clone)
 * is not a source checkout, even with the stale marker an older gbrain wrote in its git dir (#7988).
 */
function assertSourceCheckout(repo: string): void {
  const registered = registeredManagedRootRecords();
  if (!registered.length) return;
  const marker = managedRootMarkerFor(repo);
  if (marker && !staleEnclosingMarker({ root: marker.root, evidence: marker.marker })) return;
  const top = canonicalFilesystemPath(repo);
  const within = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
  const metadata = checkoutGitMetadata(top);
  if (registered.some(record => within(record.root, top) || (within(top, record.root) && metadata !== null && existsSync(record.root) && checkoutGitMetadata(record.root) === metadata))) return;
  if (existsSync(join(repo, 'scripts', 'brain-commit-push.sh'))) return;
  try {
    execFileSync('git', ['-C', repo, 'config', '--local', '--get-regexp', `^(${SOURCE_ROOT_CONFIG}|gbrain.clipath)$`.replace(/\./g, '\\.').toLowerCase()], { env: gitChildEnv({ ...GIT_ENV }), stdio: ['ignore', 'pipe', 'ignore'] });
    return;
  } catch { /* no marker */ }
  const first = registered[0]!.root;
  const listed = registered.slice(0, 5).map(record => `${record.root}${record.source_id ? ` (${record.source_id})` : ''}`).join(', ') + (registered.length > 5 ? ` and ${registered.length - 5} more` : '');
  throw opError('checkout_not_a_source', `${repo} is not a source checkout of this brain; its source checkouts on this host are ${listed}. Nothing was staged.`,
    `Pass the brain checkout with an absolute --path, for example gbrain git commit-push --path ${first} -m <msg> -- <paths>; a script or cron wrapper that changes directory first must name it the same way.`,
    { fix: { argv: ['gbrain', 'git', 'commit-push', '--dry-run', '--path', first], consent: [], actor: 'user', requires_exclusive: false,
      why: 'The dry run shows the checkout, branch and lock commit-push uses with that --path, writing nothing.',
      user_message: `gbrain git commit-push resolved ${repo}, which is not one of this brain's source checkouts (${listed}). Change the script or wrapper that ran it to pass --path with the absolute brain checkout.`,
      verify: { argv: ['gbrain', 'git', 'commit-push', '--dry-run', '--path', first] } } });
}

/** `gbrain git scan`: the push's secret scan over a range, read-only, so an operator can see what a push would refuse. */
function runScan(p: Parsed): number {
  const repo = checkoutRoot(p.path ?? process.cwd());
  if (p.scanTimeout !== undefined && !/^[1-9]\d{0,5}$/.test(p.scanTimeout)) {
    throw opError('commit_paths_invalid', `--scan-timeout ${p.scanTimeout} is not a number of seconds.`, 'Pass whole seconds, for example --scan-timeout 1800.');
  }
  const rev = (spec: string, flag: string): string => {
    try { return execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${spec}^{commit}`], { env: gitChildEnv({ ...GIT_ENV }) }).toString().trim(); }
    catch { throw opError('commit_paths_invalid', `${flag} ${spec} names no commit in ${repo}.`, 'Pass a commit, for example --from $(git rev-list -1 --before="30 days ago" HEAD); with no upstream, --from is required.'); }
  };
  const from = rev(p.from ?? '@{upstream}', '--from');
  const to = rev(p.to ?? 'HEAD', '--to');
  const timeoutMs = p.scanTimeout ? Number(p.scanTimeout) * 1000 : undefined;
  const started = Date.now();
  const scan = scanRange(repo, from, to, timeoutMs, line => process.stderr.write(`[gbrain] ${line}\n`));
  const refusal = rangeSecretRefusal(repo, from, to, scan, { timeoutMs });
  const commits = Number(execFileSync('git', ['-C', repo, 'rev-list', '--count', `${from}..${to}`], { env: gitChildEnv({ ...GIT_ENV }) }).toString().trim());
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const items = [...scan.findings.map(f => `  ${f.commit.slice(0, 7)} ${f.path}:${f.line} ${f.pattern} ${f.fingerprint}`),
    ...scan.unscanned.map(u => `  ${u.commit.slice(0, 7)} ${u.path} too large to scan`), ...scan.gate_changes.map(g => `  ${g.commit.slice(0, 7)} ${g.path} changes what the scan sees`)];
  emit(p.json, { repo, from, to, commits, seconds, would_refuse: refusal?.code ?? null, findings: scan.findings, unscanned: scan.unscanned, gate_changes: scan.gate_changes,
    unreadable: scan.unreadable ?? null }, [`scanned ${commits} commit(s) ${from.slice(0, 12)}..${to.slice(0, 12)} in ${seconds} s: ${refusal ? `a push would refuse (${refusal.code})` : 'a push would not refuse'}`,
    ...(scan.unreadable !== undefined ? [`  not read in full: ${scan.unreadable}`] : []), ...items].join('\n'));
  return 0;
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
    if (p.sub === 'guard') return runGuard(p);
    if (p.sub === 'scan') return runScan(p);
    if (p.sub !== 'commit-push') throw opError('commit_paths_invalid', `Unknown subcommand: gbrain git ${p.sub}.`, HELP.split('\n')[0]);
    if (p.install || p.uninstall) throw opError('commit_paths_invalid', '--install and --uninstall belong to gbrain git guard.', 'Run gbrain git guard --install.');
    const repo = checkoutRoot(p.path ?? process.cwd());
    if (!p.path) assertSourceCheckout(repo);
    const cwd = p.path ? realpathSync(p.path) : process.cwd();
    if ((p.pull && p.pushOnly) || (p.pull && (p.message || p.paths.length || p.resolve.length || p.branch)) || (p.untrack && (p.pull || p.pushOnly || p.pending))
      || (p.pushOnly && (p.message || p.paths.length)) || ((p.resolve.length || p.branch || p.expectRemote || p.keepCheckout) && !p.pushOnly) || (p.scanTimeout !== undefined && p.pull)
      || (p.pending && (p.pull || p.pushOnly || p.paths.length)) || (p.allowOutside && p.pull) || (p.base.length && (p.pull || p.pushOnly || p.pending))) {
      throw opError('commit_paths_invalid', 'These flags do not combine.',
        'Use one mode: -m <msg> -- <paths> (commit + push), --untrack -m <msg> -- <paths>, --pending [-m <msg>], --push-only [--keep-checkout] [--branch <b>] [--expect-remote <sha> --resolve ...], or --pull [--require-clean].');
    }
    const bases = new Map(p.base.map(spec => {
      const eq = spec.lastIndexOf('=');
      const [path, blob] = [spec.slice(0, eq), spec.slice(eq + 1)];
      if (eq <= 0 || !(blob === 'absent' || /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(blob))) throw opError('commit_paths_invalid', `--base ${spec} is not <path>=<blob>.`,
        'Pass the full object id git rev-parse HEAD:<path> printed when you read the file, or absent for a new file.');
      return [path, blob] as const;
    }));
    if (p.scanTimeout !== undefined && !/^[1-9]\d{0,5}$/.test(p.scanTimeout)) {
      throw opError('commit_paths_invalid', `--scan-timeout ${p.scanTimeout} is not a number of seconds.`, 'Pass whole seconds, for example --scan-timeout 1800.');
    }
    if ((p.resolve.length && !p.expectRemote) || (p.expectRemote && !/^[0-9a-f]{7,64}$/i.test(p.expectRemote))) {
      throw opError('commit_paths_invalid', '--resolve and --expect-remote <sha> go together.',
        'Copy both from the integrate_conflict report: --expect-remote names the remote commit your choice was made against.');
    }

    if (p.dryRun) {
      const lock = execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', COMMIT_LOCK_NAME], { env: gitChildEnv({ ...GIT_ENV }) }).toString().trim();
      const branch = execFileSync('git', ['-C', repo, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { env: gitChildEnv({ ...GIT_ENV }) }).toString().trim();
      const paths = p.pull || p.pushOnly || !p.paths.length ? [] : scopePaths(repo, p.paths, cwd);
      const managed = managedFilesystemRootFor(repo);
      const untracked = p.untrack && paths.length ? previewUntrack(repo, paths, { allowOutsideSourceRoot: p.allowOutside }) : undefined;
      if (!p.untrack && paths.length) previewPaths(repo, paths, { allowOutsideSourceRoot: p.allowOutside, bases, cwd });
      emit(json, { dry_run: true, repo, branch, lock, paths, mode: p.pull ? 'pull' : p.pushOnly ? 'push-only' : p.untrack ? 'untrack' : 'commit-push', managed, ...(untracked ? { untracked } : {}) },
        `dry run: ${p.pull ? 'pull' : p.pushOnly ? 'push-only' : `${p.untrack ? 'untrack' : 'commit'} ${paths.join(' ')}`} on ${branch} in ${repo} (lock ${lock}); ${managed ? `managed canonical worktree (${managed.evidence})` : 'not a managed worktree'}; nothing written`);
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
      repo, cwd, paths: p.paths, pushOnly: p.pushOnly, advanceOnlyWhenClean: p.requireClean,
      message: p.pending ? p.message ?? 'gbrain: commit pending write-through files' : p.message,
      ...(p.pending ? { pending: true } : {}),
      ...(p.allowOutside ? { allowOutsideSourceRoot: true } : {}),
      ...(p.keepCheckout ? { keepCheckout: true } : {}),
      ...(p.scanTimeout ? { scanTimeoutMs: Number(p.scanTimeout) * 1000 } : {}),
      scanProgress: (line: string) => process.stderr.write(`[gbrain] ${line}\n`),
      ...(p.untrack ? { untrack: true } : {}),
      ...(p.branch ? { branch: p.branch } : {}),
      ...(p.resolve.length ? { resolutions: parseResolutions(p.resolve) } : {}),
      ...(p.expectRemote ? { expectRemote: p.expectRemote } : {}),
      ...(bases.size ? { bases } : {}),
    });
    if (result.outcome === 'push_deferred') {
      emit(json, { ...result, repo }, `push deferred: another push is running in ${repo} and will publish HEAD too`);
      return 0;
    }
    if (result.no_remote) {
      emit(json, { ...result, repo }, result.committed ? `committed ${result.committed.slice(0, 7)} on ${result.branch}; not pushed: ${repo} has no Git remote (add one with git remote add origin <url>, then gbrain git commit-push --push-only)`
        : `nothing to commit; not pushed: ${repo} has no Git remote`);
      return 0;
    }
    if (result.managed) {
      const upstream = result.upstream;
      const state = !upstream ? `${result.branch} has no upstream`
        : result.unpublished === 0 ? `${result.branch} is on ${upstream} as last fetched`
        : `${result.unpublished ?? 'an unknown number of'} commit(s) on ${result.branch} ${result.unpublished === null ? 'may not be' : 'are not'} on ${upstream} as last fetched; a managed checkout publishes through its owner (gbrain git commit-push --push-only --keep-checkout --scan-secrets --path ${repo} publishes them)`;
      emit(json, { ...result, repo }, `${result.committed ? `committed ${result.committed.slice(0, 7)} on ${result.branch}` : 'nothing to commit'}; not pushed: ${state}`);
      return 0;
    }
    appendPushLog(result.outcome === 'nothing_to_commit' || result.confirmed === 'remote' ? 'nothing' : result.integrated ? 'ok-after-merge' : 'ok',
      p.branch?.replace(/^refs\/heads\//, '') ?? result.branch, result.sha ?? '');
    if (result.outcome === 'pushed_checkout_lagging') appendPushLog('checkout-lagging', result.branch, result.sha ?? '', result.lagging_reason);
    const short = result.sha ? result.sha.slice(0, 7) : '-';
    emit(json, { ...result, repo },
      result.outcome === 'nothing_to_commit' ? `nothing to commit; ${result.remote}/${result.branch} at ${short}`
        : `pushed ${short} to ${result.remote}/${result.branch}${result.integrated ? `; merged ${result.integrated} remote commit(s)` : ''}; checkout ${result.checkout}`);
    if (result.quarantined && !json) {
      process.stderr.write(`[gbrain notice] quarantine: the remote also changed ${result.quarantined.paths.join(', ')}; its version was published and this machine's version is kept under ${result.quarantined.ref}. gbrain doctor lists it (quarantined_changes).\n`);
    }
    if (result.superseded_remote_paths && !json) {
      process.stderr.write(`[gbrain notice] kept this machine's version of ${result.superseded_remote_paths.join(', ')}: the remote held a version this checkout had already replaced. See docs/guides/shared-checkout-git.md#conflicts.\n`);
    }
    if (result.outcome === 'pushed_checkout_lagging' && !json) {
      process.stderr.write(`[gbrain notice] the push landed but this checkout was not advanced: ${result.lagging_reason}. The next commit-push or --pull catches it up.\n`);
    }
    return 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    let failed = e as { code?: string | null; detail?: string | null };
    if (code === 'commit_paths_skipped' || code === 'writer_coordinator_required') {
      // GST-2116: the other named paths may have been pushed before the run failed, or their push failed (`publish`); the push log records either.
      try {
        const d = JSON.parse(String((e as { detail?: string }).detail ?? '{}')) as { pushed?: string; branch?: string; publish?: { code: string | null; detail: string | null } };
        if (d.pushed && d.branch) appendPushLog('ok', d.branch, d.pushed);
        if (d.publish) failed = d.publish;
      } catch { /* best-effort */ }
    }
    if (failed.code === 'push_unconfirmed' || failed.code === 'integrate_conflict' || failed.code === 'commit_outside_source_root'
      || failed.code === 'publish_secret_found' || failed.code === 'publish_scan_unreadable') {
      try {
        const bi = args.indexOf('--branch');
        const branch = bi !== -1 && args[bi + 1] ? args[bi + 1].replace(/^refs\/heads\//, '') : currentBranchOf(args);
        if (failed.code.startsWith('publish_')) appendPushLog('refused', branch, '', failed.code);
        else appendPushLog(failed.code === 'integrate_conflict' ? 'conflict' : 'local-only', branch, failed.detail ?? '');
      } catch { /* best-effort */ }
    }
    return writeCliError(e, 'git commit-push', { json });
  }
}

function runGuard(p: Parsed): number {
  if (p.install && p.uninstall) throw opError('commit_paths_invalid', '--install and --uninstall do not combine.', 'Pass one of them, or neither for the status.');
  const repo = checkoutRoot(p.path ?? process.cwd());
  const s = p.install ? installGuard(repo) : p.uninstall ? uninstallGuard(repo) : { ...guardStatus(repo), changed: false };
  emit(p.json, { ...s }, p.install ? `commit guard ${s.changed ? 'installed' : 'already current'}: ${s.hook}`
    : p.uninstall ? (s.changed ? `commit guard removed: ${s.hook}` : 'commit guard was not installed')
    : s.installed ? `commit guard installed: ${s.hook}` : s.foreign ? `not installed; ${s.hook} is another tool's hook` : 'commit guard not installed (gbrain git guard --install)');
  return 0;
}

function currentBranchOf(args: string[]): string {
  const i = args.findIndex(a => a === '--path' || a === '--repo');
  const dir = i !== -1 ? args[i + 1] : process.cwd();
  return execFileSync('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { env: gitChildEnv({ ...GIT_ENV }), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}
