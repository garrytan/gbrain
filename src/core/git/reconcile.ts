/**
 * One checkout brought level with its upstream, the engine-free half of `gbrain sources git-reconcile` (the managed half
 * runs `gbrain sources refresh`). Idempotent: a checkout already level costs one fetch and reports in_sync. Behind:
 * the shared pull (fast-forward, never a rebase). Ahead or diverged: the upstream-rewrite check, then the shared
 * publish with the secret gate (merged in memory, never a rebase or force-push, refusing on a conflict). Concurrent
 * callers serialize on the checkout's commit and publish locks and end level with the same upstream.
 */
import { execFileBounded } from '../bounded-child-exec.ts';
import { classifyGitCheckout } from '../git-checkout.ts';
import { gitChildEnv } from '../git-env.ts';
import { opError } from '../ops/contract.ts';
import { acquireNativeLock } from '../persistence/native-lock.ts';
import { commitAndPush, pullShared } from './commit-push.ts';
import { upstreamBeforeFetch, upstreamRewriteReason, type GitRead } from './upstream-history.ts';

export type CheckoutReconcileStatus = 'in_sync' | 'published' | 'fast_forwarded' | 'lagging' | 'unpublished' | 'no_repo' | 'no_upstream';

export interface CheckoutLevel { branch: string; upstream: string; head: string; target: string; ahead: number; behind: number }

export interface CheckoutReconcile {
  root: string; status: CheckoutReconcileStatus; ahead: number; behind: number;
  /** The upstream tip after the run (what the remote holds), when there is an upstream. */
  sha?: string; integrated?: number; reason?: string;
}

export function gitReader(root: string, timeoutMs = 120_000): GitRead {
  return async (args, ...expected) => {
    const out = await execFileBounded('git', ['-C', root, ...args], { timeout: timeoutMs, env: gitChildEnv({ GIT_TERMINAL_PROMPT: '0' }), maxBuffer: 64 * 1024 * 1024 });
    const code = out.error ? (typeof out.error.code === 'number' ? out.error.code : -1) : 0;
    if (code === 0 || expected.includes(code)) return { stdout: String(out.stdout) };
    throw opError('git_unavailable', `git ${args.join(' ')} failed in ${root}: ${String(out.stderr).trim().split('\n')[0] || `exit ${code}`}`,
      `Run git -C ${root} status, fix what git reports, then retry.`);
  };
}

/** Fetch the branch's upstream (logging the tracking ref's move, so a later rewrite check has a record) and count both sides; null without an upstream. */
export async function fetchLevel(root: string, read: GitRead, fetchTimeoutMs = 120_000): Promise<CheckoutLevel | null> {
  const branch = (await read(['symbolic-ref', '--quiet', '--short', 'HEAD'], 1)).stdout.trim();
  if (!branch) return null;
  const upstream = (await read(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 128)).stdout.trim();
  if (!upstream) return null;
  const remote = (await read(['config', '--get', `branch.${branch}.remote`], 1)).stdout.trim();
  const merge = (await read(['config', '--get', `branch.${branch}.merge`], 1)).stdout.trim();
  if (remote && remote !== '.') {
    let fetched = await execFileBounded('git', ['-C', root, '-c', 'core.logAllRefUpdates=true', 'fetch', '--no-tags', '--quiet', remote, merge || branch],
      { timeout: fetchTimeoutMs, env: gitChildEnv({ GIT_TERMINAL_PROMPT: '0' }) });
    for (let attempt = 1; fetched.error && attempt < 4 && /cannot lock ref|unable to update local ref/.test(String(fetched.stderr)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
      fetched = await execFileBounded('git', ['-C', root, '-c', 'core.logAllRefUpdates=true', 'fetch', '--no-tags', '--quiet', remote, merge || branch],
        { timeout: fetchTimeoutMs, env: gitChildEnv({ GIT_TERMINAL_PROMPT: '0' }) });
    }
    if (fetched.error) throw opError('fetch_failed', `git fetch ${remote} failed in ${root} (${String(fetched.stderr).trim().split('\n')[0] || fetched.error.message}); nothing changed.`,
      'Check the remote and its credentials, then retry.', { retryable: true });
  }
  const head = (await read(['rev-parse', 'HEAD'])).stdout.trim();
  const target = (await read(['rev-parse', '@{upstream}'])).stdout.trim();
  const [behind, ahead] = (await read(['rev-list', '--left-right', '--count', `${target}...${head}`])).stdout.trim().split(/\s+/).map(Number);
  return { branch, upstream, head, target, ahead, behind };
}

/** One reconcile of a checkout at a time: concurrent callers wait (up to `waitMs`), then find it level. Only reconcile takes this lock, and it takes it outermost, so it never waits on a lock held by a publish that waits on it. */
export async function withReconcileLock<T>(root: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
  const path = (await gitReader(root)(['rev-parse', '--path-format=absolute', '--git-path', 'gbrain-reconcile.lock'])).stdout.trim();
  const lock = await acquireNativeLock(path, { timeoutMs: waitMs, pollMs: 100 });
  if (!lock) throw opError('commit_lock_busy', `Another reconcile of ${root} held its lock for ${Math.round(waitMs / 1000)}s; nothing changed.`,
    'Retry: the running reconcile brings the checkout level, after which a new one reports in_sync.', { retryable: true });
  try { return await fn(); } finally { await lock.release(); }
}

export interface ReconcileCheckoutOptions {
  fetchTimeoutMs?: number; dryRun?: boolean; waitMs?: number;
  /** False leaves local commits where they are and reports them unpublished (the user turned automatic publishing off); behind still fast-forwards. */
  publish?: boolean;
}

export async function reconcileCheckout(root: string, opts: ReconcileCheckoutOptions = {}): Promise<CheckoutReconcile> {
  if (classifyGitCheckout(root) === 'not_git') return { root, status: 'no_repo', ahead: 0, behind: 0 };
  return withReconcileLock(root, opts.waitMs ?? 300_000, () => reconcileLocked(root, opts));
}

async function reconcileLocked(root: string, opts: ReconcileCheckoutOptions): Promise<CheckoutReconcile> {
  const read = gitReader(root);
  const hasUpstream = (await read(['rev-parse', '--verify', '-q', '@{upstream}'], 1, 128)).stdout.trim();
  if (!hasUpstream) return { root, status: 'no_upstream', ahead: 0, behind: 0 };
  const before = await upstreamBeforeFetch(read);
  const level = await fetchLevel(root, read, opts.fetchTimeoutMs);
  if (!level) return { root, status: 'no_upstream', ahead: 0, behind: 0 };
  const { ahead, behind, target, head, upstream } = level;
  if (!ahead && !behind) return { root, status: 'in_sync', ahead, behind, sha: target };
  if (ahead && opts.publish === false) return { root, status: 'unpublished', ahead, behind, sha: target, reason: 'automatic publishing is off (sources.refresh_publish_diverged false)' };
  if (opts.dryRun) return { root, status: ahead ? 'published' : 'fast_forwarded', ahead, behind, sha: target, reason: 'dry run: nothing changed' };
  if (!ahead) {
    const pulled = pullShared(root);
    return pulled.status === 'lagging' ? { root, status: 'lagging', ahead, behind, sha: target, ...(pulled.reason ? { reason: pulled.reason } : {}) }
      : { root, status: 'fast_forwarded', ahead, behind, sha: pulled.to ?? target };
  }
  const rewrite = await upstreamRewriteReason(read, before, upstream, target, head);
  if (rewrite) throw opError('upstream_rewritten', `${rewrite} Nothing was pushed from ${root}.`,
    `Ask the user: git -C ${root} log --stat ${upstream}..HEAD lists the local commits; publishing them anyway is gbrain git commit-push --push-only --scan-secrets --path ${root}.`);
  const pushed = commitAndPush({ repo: root, cwd: root, paths: [], pushOnly: true, scanSecrets: true });
  return { root, status: pushed.checkout === 'lagging' ? 'lagging' : 'published', ahead, behind, sha: pushed.sha ?? undefined, integrated: pushed.integrated,
    ...(pushed.lagging_reason ? { reason: pushed.lagging_reason } : {}) };
}
