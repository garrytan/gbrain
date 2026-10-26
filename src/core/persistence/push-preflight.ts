/**
 * Wave C 1A (spec §4.4, review d8): pushes that scale with what they send. Shared by the Git effect's push
 * (`pushGitRoot`, effect-git.ts) and the `--push-only` publish of `gbrain git commit-push` (commit-push.ts), which the
 * effect runs as a child when the remote moved or the push is over the cap.
 *
 * Timeout. A push gets 20 s plus 1 s per MiB of the objects it sends, capped at 60 minutes. The size is the
 * `--disk-usage` of the objects the tip reaches and the remote's tracking refs do not, measured before the push.
 *
 * Batching. Pending bytes over `git.push_max_pack_bytes` (default 1.5 GiB, at most 2 GiB toward github.com) are pushed
 * as the unpushed first-parent range, in order, in batches whose summed per-commit `--disk-usage` stays under the cap. A
 * remote that has not moved takes each batch on the branch itself (each a fast-forward). A remote that moved (the tip is
 * the in-memory merge over it) takes every batch on a gbrain-owned staging ref, `refs/gbrain/push-staging/<branch>`
 * (forced: gbrain owns it); the merge then goes to the branch last as a small pack, since its objects are already there,
 * and the staging ref is deleted.
 * After each batch the last pushed commit is recorded in `<git common dir>/gbrain-push-progress.json`, so a push stopped
 * between batches resumes after it. A single commit over the cap is held `git_push_pack_too_large`.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OperationError, opError } from '../ops/contract.ts';
import { loadConfigFileOnly, type GBrainConfig } from '../config.ts';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/**
 * Base and per-MiB budget of a push (master's fixed step timeout is `msPerMiB: 0`), and `longPushBytes`: a Git effect
 * push over it runs without the worktree writer lock. Test seams only.
 */
export const pushTiming = { baseMs: 20_000, msPerMiB: 1_000, longPushBytes: 256 * MiB };
export const PUSH_TIMEOUT_CAP_MS = 60 * 60_000;
export const PUSH_MAX_PACK_BYTES_KEY = 'git.push_max_pack_bytes';
export const PUSH_MAX_PACK_BYTES_DEFAULT = 1.5 * GiB;
/** GitHub refuses a push over 2 GiB. */
export const GITHUB_PUSH_MAX_BYTES = 2 * GiB;
/** How the Git effect hands the configured cap to its `gbrain git commit-push` child, which runs before any engine connects. */
export const PUSH_MAX_PACK_BYTES_ENV = 'GBRAIN_PUSH_MAX_PACK_BYTES';
const PROGRESS_NAME = 'gbrain-push-progress.json';

/** The deadline of one push that sends `pendingBytes`. */
export function pushTimeoutMs(pendingBytes: number): number {
  return Math.min(PUSH_TIMEOUT_CAP_MS, pushTiming.baseMs + Math.ceil(Math.max(0, pendingBytes) / MiB) * pushTiming.msPerMiB);
}

/** A byte size: an integer, or a number with a KiB, MiB or GiB suffix; null for anything else. */
export function parseByteSize(value: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB)?\s*$/.exec(value);
  if (!match || (!match[2] && match[1]!.includes('.'))) return null;
  const unit = match[2] === 'GiB' ? GiB : match[2] === 'MiB' ? MiB : match[2] === 'KiB' ? 1024 : 1;
  const bytes = Math.floor(Number(match[1]) * unit);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

/** `gbrain config set git.push_max_pack_bytes` refuses anything but a positive size. */
export function pushMaxPackValueRefusal(value: string): OperationError | null {
  if (parseByteSize(value) !== null) return null;
  const error = opError('config_error', `git.push_max_pack_bytes must be a positive byte count or a size such as 1536MiB or 1.5GiB, not ${JSON.stringify(value)}; nothing was written.`,
    'Re-run with a value such as gbrain config set git.push_max_pack_bytes 1.5GiB.');
  error.reason = 'invalid_size';
  return error;
}

const githubUrl = (url: string) => /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com[:/]/i.test(url.trim());

/** The cap a push to `pushUrls` uses: the configured value (else the default), at most 2 GiB toward github.com. */
export function pushCap(configured: number | null | undefined, pushUrls: readonly string[]): number {
  const cap = configured && configured > 0 ? configured : PUSH_MAX_PACK_BYTES_DEFAULT;
  return pushUrls.some(githubUrl) ? Math.min(cap, GITHUB_PUSH_MAX_BYTES) : cap;
}

/** `git.push_max_pack_bytes` from the host's file plane (~/.gbrain/config.json), read engine-free; null when unset or invalid. */
export function filePushCap(): number | null {
  const raw = loadConfigFileOnly()?.git?.push_max_pack_bytes;
  return raw === undefined || raw === null ? null : parseByteSize(String(raw));
}

/** `gbrain config set git.push_max_pack_bytes <size>`: validated, then written to the file plane only; the refusal otherwise. */
export function setPushMaxPackConfig(cfg: GBrainConfig, value: string, save: (cfg: GBrainConfig) => void): OperationError | null {
  const refusal = pushMaxPackValueRefusal(value);
  if (refusal) return refusal;
  save({ ...cfg, git: { ...(cfg.git ?? {}), push_max_pack_bytes: value.trim() } });
  console.log(`Set ${PUSH_MAX_PACK_BYTES_KEY} = ${value.trim()} (file plane: ~/.gbrain/config.json). Git pushes from this host batch above it${parseByteSize(value)! > GITHUB_PUSH_MAX_BYTES ? '; a github.com remote still takes at most 2 GiB' : ''}.`);
  return null;
}

/** The cap the Git effect set for its child (PUSH_MAX_PACK_BYTES_ENV); null when unset or invalid. */
export function envPushCap(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[PUSH_MAX_PACK_BYTES_ENV];
  return raw ? parseByteSize(raw) : null;
}

export interface PlannedBatch { end: string; bytes: number }

/**
 * Groups the first-parent commits (oldest first, each with the bytes it adds) into batches under `cap`; a commit that
 * alone is over the cap is returned as `tooLarge`.
 */
export function planBatches(commits: ReadonlyArray<{ sha: string; bytes: number }>, cap: number): { batches: PlannedBatch[] } | { tooLarge: { sha: string; bytes: number } } {
  const batches: PlannedBatch[] = [];
  let open: PlannedBatch | null = null;
  for (const commit of commits) {
    if (commit.bytes > cap) return { tooLarge: commit };
    if (open && open.bytes + commit.bytes <= cap) { open.end = commit.sha; open.bytes += commit.bytes; continue; }
    if (open) batches.push(open);
    open = { end: commit.sha, bytes: commit.bytes };
  }
  if (open) batches.push(open);
  return { batches };
}

/** The gbrain-owned ref a moved remote takes the batches on. */
export function stagingRef(branchRef: string): string {
  return `refs/gbrain/push-staging/${branchRef.replace(/^refs\/heads\//, '')}`;
}

/** The batch push in progress: the remote (by name and push URLs) and ref it goes to, and the last commit that landed. */
export interface PushProgress { remote: string; urls: string[]; ref: string; staging: string | null; tip: string; pushed: string; at: string }

export function readPushProgress(gitDir: string): PushProgress | null {
  const path = join(gitDir, PROGRESS_NAME);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as PushProgress;
    return typeof doc.remote === 'string' && Array.isArray(doc.urls) && typeof doc.ref === 'string' && typeof doc.pushed === 'string' && /^[0-9a-f]{40,64}$/.test(doc.pushed) ? doc : null;
  } catch { return null; }
}

function writePushProgress(gitDir: string, progress: Omit<PushProgress, 'at'>): void {
  const path = join(gitDir, PROGRESS_NAME);
  writeFileSync(`${path}.tmp`, JSON.stringify({ ...progress, at: new Date().toISOString() }));
  renameSync(`${path}.tmp`, path);
}

function clearPushProgress(gitDir: string): void {
  rmSync(join(gitDir, PROGRESS_NAME), { force: true });
}

const mib = (bytes: number) => `${Math.ceil(bytes / MiB)} MiB`;

/** The hold of a single commit whose objects are over the cap. */
export function packTooLarge(sha: string, bytes: number, cap: number, remote: string): OperationError {
  return opError('git_push_pack_too_large', `Commit ${sha.slice(0, 12)} alone adds ${mib(bytes)} of objects, over the push cap of ${mib(cap)} (git.push_max_pack_bytes), so nothing was pushed to ${remote}.`,
    `Batches cannot split one commit. The commits stay local and nothing is lost. Raising git.push_max_pack_bytes above ${mib(bytes)} lets it go in one pack (a github.com remote never takes more than 2 GiB); then retry the parked pushes.`,
    { detail: JSON.stringify({ commit: sha, bytes, cap }), fix: {
      ask_user: true, actor: 'host_admin', consent: [], requires_exclusive: false,
      argv: ['gbrain', 'config', 'set', PUSH_MAX_PACK_BYTES_KEY, String(Math.min(bytes + MiB, GITHUB_PUSH_MAX_BYTES))],
      why: 'A larger cap sends a larger single pack, which the remote and its host limits must accept, so the host owner decides.',
      user_message: `A commit in the brain's checkout adds ${mib(bytes)} in one pack, over the push cap of ${mib(cap)}, so its Git backup is held (nothing is lost; the commit stays local). Raise git.push_max_pack_bytes to at least ${mib(bytes)} (at most 2 GiB toward GitHub), then run gbrain sources writer retry-effects <source> --parked-pushes?`,
      verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] } } });
}

/** Synchronous Git access for {@link pushRange}: git calls in the checkout, and one push (with the caller's flags) to the remote. */
export interface PushIO {
  gitDir: string;
  remote: string;
  /** The remote's push URLs: recorded progress is reused only toward the same ones. */
  urls: string[];
  git(args: string[]): { code: number; stdout: string; stderr: string };
  push(refspecs: string[], timeoutMs: number): { code: number; stdout: string; stderr: string };
}

/** Test seam: runs after each batch but the last has pushed and its progress is recorded. */
export const pushSeams: { afterBatch?: (index: number, end: string) => void } = {};

/**
 * Bytes of the objects `tip` reaches and none of `exclude` does (`--disk-usage`, git 2.31+); null when git cannot tell.
 * An unmeasured push goes as one push with the longest deadline (never batched); an unmeasured batch plan pushes nothing.
 */
export function pendingBytes(io: Pick<PushIO, 'git'>, tip: string, exclude: readonly string[]): number | null {
  const usage = io.git(['rev-list', '--objects', '--disk-usage', tip, '--not', ...exclude]);
  const bytes = Number(usage.stdout.trim());
  return usage.code === 0 && usage.stdout.trim() !== '' && Number.isFinite(bytes) ? bytes : null;
}

const unmeasured = (what: string) => ({ code: 1, stdout: '', stderr: `gbrain could not measure ${what} before pushing (git rev-list failed), so nothing was pushed.` });

/**
 * Pushes `tip` to `ref` (header): one push when its objects fit the cap, else ordered batches. `remoteTip` is the
 * branch's tip on the remote as last fetched (null when unknown or the branch is new). Returns the last push's result: a
 * non-fast-forward or transport failure is the caller's to handle, as for a single push.
 */
export function pushRange(io: PushIO, opts: { tip: string; ref: string; cap: number; remoteTip: string | null }): { code: number; stdout: string; stderr: string } {
  const { tip, ref, cap } = opts;
  const isAncestor = (a: string, b: string) => io.git(['merge-base', '--is-ancestor', a, b]).code === 0;
  let progress = readPushProgress(io.gitDir);
  const sameRemote = progress && progress.remote === io.remote && progress.urls.join('\n') === io.urls.join('\n') && progress.ref === ref;
  const landed = progress && (progress.staging || isAncestor(progress.pushed, `refs/remotes/${io.remote}/${ref.replace(/^refs\/heads\//, '')}`));
  if (progress && (!sameRemote || !landed || !isAncestor(progress.pushed, tip))) { clearPushProgress(io.gitDir); progress = null; }
  const exclude = [`--remotes=${io.remote}`, ...(progress ? [progress.pushed] : [])];
  const finish = (staging: string | null) => {
    if (staging) io.push([`:${staging}`], pushTimeoutMs(0));
    clearPushProgress(io.gitDir);
  };
  const pending = pendingBytes(io, tip, exclude);
  if (pending === null || pending <= cap) {
    const pushed = io.push([`${tip}:${ref}`], pending === null ? PUSH_TIMEOUT_CAP_MS : pushTimeoutMs(pending));
    if (pushed.code === 0 && progress) finish(progress.staging);
    return pushed;
  }
  const listed = io.git(['rev-list', '--first-parent', '--reverse', tip, '--not', ...exclude]);
  const chain = listed.stdout.split('\n').filter(Boolean);
  if (listed.code !== 0 || !chain.length) return unmeasured(`the commits ${tip.slice(0, 12)} adds over ${io.remote}`);
  const sizes = chain.map((sha, i) => ({ sha, bytes: pendingBytes(io, sha, [...exclude, ...(i ? [chain[i - 1]!] : [])]) }));
  if (sizes.some(commit => commit.bytes === null)) return unmeasured(`the commits ${tip.slice(0, 12)} adds over ${io.remote}`);
  const plan = planBatches(sizes as Array<{ sha: string; bytes: number }>, cap);
  if ('tooLarge' in plan) throw packTooLarge(plan.tooLarge.sha, plan.tooLarge.bytes, cap, io.remote);
  const staging = progress?.staging ?? (opts.remoteTip && chain.length && !isAncestor(opts.remoteTip, chain[0]!) ? stagingRef(ref) : null);
  let result = { code: 0, stdout: '', stderr: '' };
  for (const [i, batch] of plan.batches.entries()) {
    result = io.push([staging ? `+${batch.end}:${staging}` : `${batch.end}:${ref}`], pushTimeoutMs(batch.bytes));
    if (result.code !== 0) {
      if (progress && i === 0) clearPushProgress(io.gitDir);
      return result;
    }
    if (batch.end === tip) break;
    writePushProgress(io.gitDir, { remote: io.remote, urls: io.urls, ref, staging, tip, pushed: batch.end });
    pushSeams.afterBatch?.(i, batch.end);
  }
  if (staging) {
    result = io.push([`${tip}:${ref}`], pushTimeoutMs(0));
    if (result.code !== 0) return result;
  }
  finish(staging);
  return result;
}
