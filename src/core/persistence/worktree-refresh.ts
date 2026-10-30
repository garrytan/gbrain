/**
 * F0 `gbrain sources refresh`: the one sanctioned Git writer for a managed
 * checkout. A worktree-wide, drained, fast-forward-only refresh with a
 * durable checkpoint (`persistence_worktree_refreshes`):
 *
 *   precheck (no DB state) -> draining -> fenced -> merged -> syncing -> completed
 *
 * `draining` refuses new checkout writes for every member source at admission
 * while queued work drains; `fenced` (worktree native lock held) stops claims
 * and runs `git merge --ff-only`; `merged` writes the upstream observation;
 * `syncing` runs the managed `--no-pull` sync per member and admits only those
 * sync writes. A crash converges through `resumeWorktreeRefreshes`, which only
 * adopts a HEAD it can verify. Git and network waits never run inside a
 * database transaction; fetch also runs outside the native locks.
 *
 * A per-worktree refresh lock (`locks/refresh-<worktree>.lock`) is held by the
 * refreshing process for its whole run, so recovery never touches the row of a
 * live refresh: holding that native lock proves the previous process exited.
 * #7679: the row records its holder (`outcome.holder`: host, pid, process start),
 * so status can say who holds it, and a row whose lock is free is orphaned: the
 * next plain refresh finishes it through the `--resume` path before refreshing.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { SyncResult } from '../../commands/sync.ts';
import { execFileBounded } from '../brain-repo-durability.ts';
import { loadConfig } from '../config.ts';
import { catalogueError, type CatalogueName } from '../error-catalogue.ts';
import { classifyGitCheckout } from '../git-checkout.ts';
import type { Action } from '../agent-output.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { recordUpstreamObservation } from '../sync-upstream.ts';
import { checkpointRetryCommand } from './checkpoint-validation.ts';
import { existingLocalHostId, localHostId, persistenceHome } from './identity.ts';
import { acquireNativeLock, tryAcquireNativeLock, type NativeLockHandle } from './native-lock.ts';
import { getWorktreeBinding, managedPersistenceEnabled, type WorktreeBinding } from './ownership.ts';
import { isPhysicalRootMetadata } from './physical-root-record.ts';
import { startPersistenceConsumer } from './service.ts';
import { lockTopologyPrincipal, lockTopologyRows, topologyPrincipal, withTopologyLocks } from './topology-locks.ts';
import { ACTIVE_REFRESH_STATES_SQL, CHECKOUT_EFFECT_KINDS_SQL, type WorktreeRefreshState } from './worktree-refresh-schema.ts';
import { gitChildEnv } from '../git-env.ts';
import { classifyOriginUniqueViolation } from './origin-guard.ts';

export interface WorktreeRefreshRow {
  id: string; worktree_id: string; source_ids: string[]; principal_id: string; owner_epoch: string | number;
  topology_generation: string | number; state: WorktreeRefreshState; old_head: string; target_head: string; upstream_ref: string;
  preserved_uncommitted: string[]; outcome: Record<string, unknown>; created_at: string | Date; updated_at: string | Date; completed_at: string | Date | null;
}
export type RefreshBoundary = 'drained' | 'fenced' | 'merged' | 'syncing';
export interface RefreshHooks { boundary?: (point: RefreshBoundary, row: WorktreeRefreshRow) => Promise<void> | void }
export interface RefreshOptions {
  dryRun?: boolean; resume?: boolean; abandon?: boolean;
  /** Flag value; falls back to GBRAIN_REFRESH_DRAIN_WAIT_MS, then `sources.refresh_drain_wait_ms`, then 60 s. */
  waitDrainMs?: number;
  /** Flag value; falls back to GBRAIN_REFRESH_FETCH_TIMEOUT_MS, then `sources.refresh_fetch_timeout_ms`, then 120 s. */
  fetchTimeoutMs?: number;
  hooks?: RefreshHooks;
}
export interface RefreshMemberSync { source_id: string; status: string; last_commit: string | null }
export interface RefreshSyncBlocked { source_id: string; code: string; message: string; resume: string }
export interface WorktreeRefreshResult {
  status: 'already_current' | 'completed' | 'sync_blocked' | 'dry_run' | 'syncing' | 'abandoned' | 'nothing_to_resume';
  refresh_id: string | null; worktree_id: string; source_ids: string[]; old_head: string | null; target_head: string | null;
  upstream_ref: string | null; preserved_uncommitted: string[]; incoming_files?: number;
  synced: RefreshMemberSync[]; sync_blocked?: RefreshSyncBlocked[]; next?: string;
  /** #7679: an orphaned refresh this run finished (or rolled back) through the `--resume` path before its own refresh. */
  recovered?: { refresh_id: string; state: WorktreeRefreshState; status: WorktreeRefreshResult['status']; previous_holder: RefreshHolder | null };
}
/** #7679: the process that holds a refresh's lock, recorded on the row so status can name it. */
export interface RefreshHolder { host_id: string | null; hostname: string; pid: number; started_at: string }
/** `live`: a process holds the refresh lock; `orphaned`: none does; `unknown`: the lock is on another host, or unreadable. */
export type RefreshLiveness = 'live' | 'orphaned' | 'unknown';
const refreshHolder = (): RefreshHolder => ({ host_id: existingLocalHostId(), hostname: hostname(), pid: process.pid,
  started_at: new Date(Date.now() - process.uptime() * 1000).toISOString() });
const holderOf = (row: Pick<WorktreeRefreshRow, 'outcome'>): RefreshHolder | null => (row.outcome?.holder as RefreshHolder | undefined) ?? null;
const describeHolder = (holder: RefreshHolder | null) => holder ? `pid ${holder.pid} on ${holder.hostname} (host ${holder.host_id ?? 'unknown'}), started ${holder.started_at}` : 'a process that recorded no holder';

const DRAIN_POLL_MS = 250;
const MAX_MEMBER_SYNC_PASSES = 20;
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };

function refusal(name: CatalogueName, cause: string, fix: string, refreshId?: string): OperationError {
  const error = catalogueError(name, cause, fix);
  if (refreshId) error.detail = `refresh_id=${refreshId}`;
  return error;
}
/**
 * GBRA-133: the owner check reads this process's host identity without minting one (a cron job with another HOME would
 * otherwise become a new host silently), and its refusal names the identity file it read and the HOME it resolved from.
 */
function assertRefreshOwner<B extends { owner_host_id: string | null; local_path: string | null }>(binding: B, sourceId: string, action: string): asserts binding is B & { local_path: string } {
  const hostId = existingLocalHostId();
  if (binding.owner_host_id === hostId && binding.local_path) return;
  const path = join(persistenceHome(), 'host.json');
  const self = hostId ? `host identity ${hostId} from ${path}` : `no host identity at ${path} (none was created)`;
  throw refusal('refresh_not_owner',
    `Only the registered owner host (${binding.owner_host_id}) of source ${sourceId} may ${action}; this process has ${self}, resolved from HOME=${process.env.HOME ?? '(unset)'} and GBRAIN_HOME=${process.env.GBRAIN_HOME?.trim() || '(unset)'}.`,
    `Run it on the owner host with the HOME or GBRAIN_HOME its writer uses (a cron job often runs with a different HOME, so set GBRAIN_HOME explicitly); check the owner with gbrain sources writer status ${sourceId}`);
}
const writerStatusFix = (why: string, sourceId?: string): Action => readFix(why,
  { argv: ['gbrain', 'sources', 'writer', 'status', ...(sourceId ? ['--source', sourceId] : []), '--json'] });
/** #7685: `refresh_in_progress` carries a structured fix: the writer status read that says whether the holder is alive and, for an orphan, names `--resume`. */
function inProgress(cause: string, sourceId: string, refreshId?: string): OperationError {
  const error = refusal('refresh_in_progress', cause, `Wait for a live refresh to finish; gbrain sources writer status --source ${sourceId} --json says whether its holder is alive, and for an orphaned one names gbrain sources refresh ${sourceId} --resume.`, refreshId);
  error.fix = writerStatusFix(`Shows the active refresh's holder and liveness, read-only: a live one finishes on its own; an orphaned one names gbrain sources refresh ${sourceId} --resume, which the next plain refresh also runs by itself.`, sourceId);
  return error;
}
const q = (value: string) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** Hardened git: no prompts, no user hooks, untranslated output, bounded. */
async function withGit<T>(run: (git: (args: string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }>) => Promise<T>): Promise<T> {
  const base = join(persistenceHome(), 'empty-hooks');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const hooks = mkdtempSync(join(base, 'refresh-'));
  try {
    return await run(async (args, timeoutMs = 30_000) => {
      const { error, stdout, stderr } = await execFileBounded('git', ['-c', 'core.quotepath=false', '-c', `core.hooksPath=${hooks}`, ...args],
        { timeout: timeoutMs, maxBuffer: 32 * 1024 ** 2, env: gitChildEnv(GIT_ENV) });
      const timedOut = !!error && (error.killed || typeof error.code !== 'number');
      return { stdout, stderr, code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, timedOut };
    });
  } finally { rmSync(hooks, { recursive: true, force: true }); }
}
type Git = Parameters<Parameters<typeof withGit>[0]>[0];

async function revParse(git: Git, root: string, rev: string): Promise<string | null> {
  const out = await git(['-C', root, 'rev-parse', '--verify', '-q', `${rev}^{commit}`]);
  return out.code === 0 ? out.stdout.trim() : null;
}
async function isAncestor(git: Git, root: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(['-C', root, 'merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
}

/** Uncommitted paths (ignored files excluded) split into those the incoming diff touches and the rest. */
async function dirtyOverlap(git: Git, root: string, from: string, to: string): Promise<{ overlap: string[]; preserved: string[]; incoming: number }> {
  const status = await git(['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (status.code !== 0) {
    throw opError('storage_error', `git status failed in ${root}: ${status.stderr.trim().split('\n')[0]}`,
      `Git could not read the checkout at ${root}, so the refresh stopped before merging and the checkout was not changed. Fix what git status reports there, check the refresh state, then rerun gbrain sources refresh for that source with --resume or --abandon.`,
      { fix: writerStatusFix('Shows any refresh holding these sources in draining or fenced state, read-only.') });
  }
  const dirty: string[] = [];
  const fields = status.stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    dirty.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') dirty.push(fields[++i]);
  }
  const diff = await git(['-C', root, 'diff', '--name-only', '-z', '--no-renames', from, to]);
  if (diff.code !== 0) {
    throw opError('storage_error', `git diff failed in ${root}: ${diff.stderr.trim().split('\n')[0]}`,
      `Git could not compare ${from} with ${to} in ${root}, so the refresh stopped before merging and the checkout was not changed. Make sure both commits exist locally (fetch again if needed), check the refresh state, then rerun gbrain sources refresh for that source with --resume or --abandon.`,
      { fix: writerStatusFix('Shows any refresh holding these sources in draining or fenced state, read-only.') });
  }
  const incoming = diff.stdout.split('\0').filter(Boolean);
  const touches = (path: string) => incoming.some(file => file === path || (path.endsWith('/') && file.startsWith(path)) || path.startsWith(`${file}/`));
  const ours = (path: string) => isPhysicalRootMetadata(path.replace(/\/$/, '')) || path === '.gbrain-managed' || path.startsWith('.gbrain-managed/');
  const unique = [...new Set(dirty)].filter(path => !ours(path)).sort();
  return { overlap: unique.filter(touches), preserved: unique.filter(path => !touches(path)), incoming: incoming.length };
}

async function configuredMs(engine: BrainEngine, flag: number | undefined, env: string, key: string, fallback: number, max = Infinity): Promise<number> {
  const raw = flag ?? (process.env[env] !== undefined && process.env[env] !== '' ? Number(process.env[env]) : undefined) ?? await engine.getConfig(key).then(v => v == null ? undefined : Number(v));
  if (raw === undefined) return fallback;
  if (!Number.isFinite(raw) || raw < 0 || raw > max) throw new OperationError('invalid_params', `${key} (or ${env}) must be a whole number of milliseconds${max < Infinity ? ` no greater than ${max} (the timer limit)` : ''}; got ${raw}.`,
    `Run gbrain config set ${key} ${fallback} (or unset ${env}), then retry.`);
  return Math.floor(raw);
}

export function refreshLockPath(worktreeId: string): string { return join(persistenceHome(), 'locks', `refresh-${worktreeId}.lock`); }

async function readActiveRefresh(engine: BrainEngine, worktreeId: string): Promise<WorktreeRefreshRow | null> {
  const [row] = await engine.executeRaw<WorktreeRefreshRow>(`SELECT * FROM persistence_worktree_refreshes
    WHERE worktree_id=$1::uuid AND state IN ${ACTIVE_REFRESH_STATES_SQL}`, [worktreeId]);
  return row ?? null;
}
async function readRefresh(engine: BrainEngine, id: string): Promise<WorktreeRefreshRow> {
  const [row] = await engine.executeRaw<WorktreeRefreshRow>('SELECT * FROM persistence_worktree_refreshes WHERE id=$1::uuid', [id]);
  if (!row) {
    throw opError('not_found', 'The worktree refresh record disappeared.',
      `Refresh ${id}'s record is gone, so another process finished or removed it. Check the writer status before refreshing again.`,
      { fix: writerStatusFix('Shows the current refresh and drain state of every managed source, read-only.') });
  }
  return row;
}
/** Conditional transition: returns false when another process already moved the row. */
async function transition(tx: BrainEngine, row: WorktreeRefreshRow, from: WorktreeRefreshState[], to: WorktreeRefreshState, outcome: Record<string, unknown> = {}): Promise<boolean> {
  const terminal = to === 'completed' || to === 'aborted';
  const changed = await tx.executeRaw(`UPDATE persistence_worktree_refreshes SET state=$3,outcome=outcome||$4::text::jsonb,updated_at=now(),
    completed_at=CASE WHEN $5::boolean THEN now() ELSE completed_at END WHERE id=$1::uuid AND state=ANY($2::text[]) RETURNING id`,
  [row.id, from, to, JSON.stringify(outcome), terminal]);
  return changed.length === 1;
}
function refusalOutcome(error: OperationError): Record<string, unknown> {
  return { refusal: { code: error.code, cause: error.message, fix: error.suggestion, docs: error.docs } };
}
async function abort(engine: BrainEngine, row: WorktreeRefreshRow, from: WorktreeRefreshState[], error: OperationError, extra: Record<string, unknown> = {}): Promise<never> {
  await engine.transaction(tx => transition(tx, row, from, 'aborted', { ...refusalOutcome(error), ...extra }));
  error.detail = `refresh_id=${row.id}`;
  throw error;
}
async function markRecoveryRequired(engine: BrainEngine, row: WorktreeRefreshRow, head: string | null, root: string): Promise<OperationError> {
  const source = row.source_ids[0];
  const error = refusal('refresh_recovery_required',
    `The checkout HEAD (${head ?? 'unreadable'}) is neither the pre-refresh commit ${row.old_head} nor the verified upstream commit ${row.target_head}; writes to this worktree stay fenced.`,
    `Inspect with gbrain sources writer status ${source}. Ask the user before resetting the checkout (destructive): git -C ${q(root)} reset --hard ${row.old_head} then gbrain sources refresh ${source} --abandon, or git -C ${q(root)} reset --hard ${row.target_head} then gbrain sources refresh ${source} --resume.`,
    row.id);
  await engine.transaction(tx => transition(tx, row, ['draining', 'fenced', 'merged', 'syncing', 'recovery_required'], 'recovery_required',
    { ...refusalOutcome(error), observed_head: head }));
  return error;
}

interface Plan {
  binding: WorktreeBinding; root: string; members: string[]; upstreamRef: string; oldHead: string; targetHead: string;
  overlap: string[]; preserved: string[]; incoming: number;
}

/** Steps 1.3/1: refusals before any database state; fetch moves only remote-tracking refs. */
async function precheck(engine: BrainEngine, git: Git, sourceId: string, fetchTimeoutMs: number): Promise<Plan> {
  if (!await managedPersistenceEnabled(engine)) throw refusal('refresh_not_managed',
    'This brain is not managed, so gbrain sync pulls the checkout itself; there is no worktree fence to coordinate.', `gbrain sync --source ${sourceId}`);
  const binding = await getWorktreeBinding(engine, sourceId, existingLocalHostId());
  if (!binding) throw refusal('refresh_not_managed',
    `Source ${sourceId} has no claimed canonical worktree, so gbrain sync pulls it without a refresh.`, `gbrain sync --source ${sourceId}`);
  assertRefreshOwner(binding, sourceId, 'move its checkout');
  const root = binding.local_path;
  const active = await readActiveRefresh(engine, binding.worktree_id);
  if (active?.state === 'recovery_required') {
    const stored = (active.outcome.refusal ?? {}) as { cause?: string; fix?: string };
    throw refusal('refresh_recovery_required', stored.cause ?? `Refresh ${active.id} could not verify the checkout HEAD, so no refresh recovers it on its own.`,
      stored.fix ?? `gbrain sources writer status ${sourceId}, then gbrain sources refresh ${sourceId} --resume`, active.id);
  }
  if (binding.state !== 'active' || await worktreeRecoveryPending(engine, binding)) throw refusal('refresh_recovery_required',
    'Publication or topology recovery is pending on this worktree; the checkout must not move until it is recovered.',
    `gbrain sources writer status ${sourceId}, let the owner finish recovery, then gbrain sources refresh ${sourceId}`);
  if (active) throw inProgress(`Refresh ${active.id} of this worktree is ${active.state}, held by ${describeHolder(holderOf(active))}; only one refresh per worktree runs at a time.`,
    sourceId, active.id);
  const members = (await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid ORDER BY source_id',
    [binding.worktree_id])).map(row => row.source_id);
  await assertNoUnfinishedSync(engine, members);
  if (classifyGitCheckout(root) === 'not_git') throw refusal('refresh_no_upstream',
    `The checkout ${root} is not a Git checkout, so there is no upstream to fast-forward to; gbrain never initializes Git on its own.`,
    'Nothing to refresh: only a Git checkout whose branch tracks an upstream can be fast-forwarded, and turning this directory into one is the user\'s call.');
  const read = async (args: string[], ...expected: number[]) => {
    const out = await git(['-C', root, ...args]);
    if (out.code === 0 || expected.includes(out.code)) return out;
    throw opError('git_unavailable', `git ${args.join(' ')} ${out.timedOut ? 'did not finish within its bound or could not start'
      : `failed (${out.stderr.trim().split('\n')[0] || `exit ${out.code}`})`}, so the checkout's branch, upstream and remote are unknown; nothing changed.`,
      `Check that git works in the checkout (git -C ${q(root)} status), then retry gbrain sources refresh ${sourceId}.`,
      { fix: readFix('Git prints why it cannot read this checkout; read-only.', { argv: ['git', '-C', root, 'status'] }) });
  };
  const branch = (await read(['symbolic-ref', '--quiet', '--short', 'HEAD'], 1)).stdout.trim();
  const upstream = branch ? await git(['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) : null;
  if (!branch || !upstream || upstream.code !== 0) {
    const remote = (await read(['remote'])).stdout.split('\n').map(v => v.trim()).filter(Boolean)[0] ?? 'origin';
    throw refusal('refresh_no_upstream', `The checkout ${branch ? `branch ${branch}` : '(detached HEAD)'} has no upstream branch, so there is nothing to fast-forward to.`,
      branch ? `git -C ${q(root)} branch --set-upstream-to ${remote}/${branch}` : `git -C ${q(root)} switch <branch>, then git -C ${q(root)} branch --set-upstream-to ${remote}/<branch>`);
  }
  const upstreamRef = upstream.stdout.trim();
  const remote = (await read(['config', '--get', `branch.${branch}.remote`], 1)).stdout.trim();
  const merge = (await read(['config', '--get', `branch.${branch}.merge`], 1)).stdout.trim();
  if (remote && remote !== '.') {
    const fetched = await git(['-C', root, 'fetch', '--no-tags', '--quiet', remote, merge || branch], fetchTimeoutMs);
    if (fetched.code !== 0) throw refusal('fetch_failed',
      fetched.timedOut ? `git fetch ${remote} did not finish within ${fetchTimeoutMs} ms; nothing changed.`
        : `git fetch ${remote} failed (${fetched.stderr.trim().split('\n')[0] || `exit ${fetched.code}`}); nothing changed.`,
      `Retry gbrain sources refresh ${sourceId}; for a slow remote raise the bound: gbrain sources refresh ${sourceId} --fetch-timeout-ms ${Math.min(Math.max(fetchTimeoutMs * 2, 120_000), 2 ** 31 - 1)} (or gbrain config set sources.refresh_fetch_timeout_ms <ms>).`);
  }
  const oldHead = await revParse(git, root, 'HEAD');
  const targetHead = await revParse(git, root, '@{upstream}');
  if (!oldHead || !targetHead) throw refusal('refresh_no_upstream', `The checkout HEAD or its upstream ${upstreamRef} does not resolve to a commit.`,
    `git -C ${q(root)} fetch ${remote || 'origin'}, then gbrain sources refresh ${sourceId}`);
  if (oldHead !== targetHead && !await isAncestor(git, root, oldHead, targetHead)) throw await divergedRefusal(git, root, sourceId, upstreamRef, oldHead, targetHead);
  const dirt = await dirtyOverlap(git, root, oldHead, targetHead);
  if (dirt.overlap.length) throw dirtyRefusal(sourceId, dirt.overlap);
  return { binding, root, members, upstreamRef, oldHead, targetHead, ...dirt };
}
/**
 * Q1: a diverged checkout is reconciled without moving it: `gbrain git commit-push --push-only --keep-checkout` merges the
 * upstream into HEAD in memory and pushes the merge (refusing on a conflict, never touching the checkout), after which HEAD
 * is an ancestor of the upstream and the refresh fast-forwards. It publishes the local commits, so the user decides.
 */
async function divergedRefusal(git: Git, root: string, sourceId: string, upstreamRef: string, oldHead: string, targetHead: string): Promise<OperationError> {
  const count = Number((await git(['-C', root, 'rev-list', '--count', `${targetHead}..${oldHead}`])).stdout.trim()) || 0;
  const local = count ? `${count} local commit(s)` : 'the local commits';
  const argv = ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', root, '--json'];
  const error = refusal('refresh_diverged',
    `The checkout HEAD ${oldHead} is not an ancestor of ${upstreamRef} (${targetHead}); a fast-forward is impossible and nothing changed.`,
    `Publish ${local} merged with ${upstreamRef}: ${argv.map(q).join(' ')} (it merges in memory, refuses on a conflict and never moves the checkout), then retry gbrain sources refresh ${sourceId}. Ask the user first, because it pushes those commits (git -C ${q(root)} log --stat ${upstreamRef}..HEAD lists them). gbrain sources reclone ${sourceId} replaces the checkout instead and drops them.`);
  error.fix = { argv, consent: [], actor: 'user', ask_user: true, requires_exclusive: false,
    why: `HEAD has ${local} that ${upstreamRef} lacks while ${upstreamRef} moved on; pushing HEAD merged with it makes HEAD an ancestor of the upstream, so the refresh can fast-forward.`,
    user_message: `The checkout of source ${sourceId} has ${local} that were never pushed while its remote moved on. Push them, merged with the remote, so gbrain can bring the checkout up to date? Conflicting files stop the push and change nothing.`,
    docs: 'docs/guides/write-refusals.md#refresh_diverged' };
  return error;
}
function dirtyRefusal(sourceId: string, overlap: string[], refreshId?: string): OperationError {
  const named = overlap.slice(0, 20).join(', ') + (overlap.length > 20 ? ` and ${overlap.length - 20} more` : '');
  return refusal('refresh_dirty', `Uncommitted or untracked paths overlap the incoming upstream changes: ${named}. Nothing changed.`,
    `Commit or discard those paths (check gbrain sources writer status ${sourceId} --json for pending git effects first), then retry gbrain sources refresh ${sourceId}.`, refreshId);
}
/**
 * Recovery no live execution will finish. A publisher holds the worktree native
 * lock from its claim until it clears its recovery record, and that clear runs
 * after the receipt commits (coordinator `completeWrite`, then
 * `clearResolvedRecovery`). So a request or effect record is in flight, and left
 * to the drain step, while it is under an unexpired running claim or while the
 * worktree lock is held; only a record still present while this probe holds
 * that lock (no live process can finish it) refuses.
 * Topology recovery always refuses.
 */
async function worktreeRecoveryPending(engine: BrainEngine, binding: WorktreeBinding): Promise<boolean> {
  const probe = async () => (await engine.executeRaw<{ publication: boolean; topology: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL
      AND NOT (state='running' AND claim_expires_at > now()))
    OR EXISTS (SELECT 1 FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL
      AND NOT (state='running' AND claim_expires_at > now())) AS publication,
    EXISTS (SELECT 1 FROM persistence_topology_changes WHERE recovery IS NOT NULL AND recovery->>'worktreeId'=$1::text) AS topology`, [binding.worktree_id]))[0];
  const first = await probe();
  if (first?.topology === true) return true;
  if (first?.publication !== true || !binding.coordination_path) return first?.publication === true;
  const lock = await tryAcquireNativeLock(binding.coordination_path);
  if (!lock) return false;
  // Holding the lock, no publisher is mid-flight: a record that is still here has no live owner.
  try { const held = await probe(); return held?.publication === true || held?.topology === true; }
  finally { await lock.release(); }
}
/**
 * Never wait on a sync: an unexhausted cursor names its own resume command. #6712 PR 4b (design v3.2 §3.3): a
 * non-company source's pass is never stranded by a checkout move (it reconciles whatever HEAD it pins next), so only
 * cursors refuse: a company brain's, and a legacy one the first pass has not retired yet.
 */
async function assertNoUnfinishedSync(engine: BrainEngine, members: string[]): Promise<void> {
  const [cursor] = await engine.executeRaw<{ source_id: string; header: Record<string, unknown> }>(`SELECT c.completed_keys->0->>'sourceId' AS source_id,
    c.completed_keys->0 AS header
    FROM op_checkpoints c WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
    AND c.completed_keys->0->>'sourceId'=ANY($1::text[]) ORDER BY c.updated_at LIMIT 1`, [members]);
  if (!cursor) return;
  const header = cursor.header as { processingOptions?: Record<string, boolean>; syncOptions?: Parameters<typeof checkpointRetryCommand>[0]['syncOptions'] };
  const resume = checkpointRetryCommand({ sourceId: cursor.source_id, processingOptions: header.processingOptions, syncOptions: header.syncOptions ?? null });
  throw refusal('sync_in_progress', `Source ${cursor.source_id} has an unfinished managed sync cursor; moving the checkout now would strand it.`,
    `${resume}, then retry the refresh.`);
}

async function drainCounts(engine: BrainEngine, worktreeId: string): Promise<{ requests: number; effects: number; recovery: number }> {
  const [row] = await engine.executeRaw<{ requests: number; effects: number; recovery: number }>(`SELECT
    (SELECT count(*) FROM persistence_requests WHERE worktree_id=$1::uuid AND state IN ('queued','running','recovering'))::int AS requests,
    (SELECT count(*) FROM persistence_effects WHERE worktree_id=$1::uuid AND kind IN ${CHECKOUT_EFFECT_KINDS_SQL} AND state IN ('queued','running'))::int AS effects,
    ((SELECT count(*) FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL)
      +(SELECT count(*) FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL))::int AS recovery`, [worktreeId]);
  return { requests: Number(row.requests), effects: Number(row.effects), recovery: Number(row.recovery) };
}

async function headOf(git: Git, root: string): Promise<string | null> { return revParse(git, root, 'HEAD'); }

/** Step 5: `merged` and the lane B upstream observation, then `syncing`, in one transaction. */
async function bookkeeping(engine: BrainEngine, row: WorktreeRefreshRow): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    if (!await transition(tx, row, ['fenced', 'merged', 'recovery_required'], 'merged')) {
      throw opError('source_changed', 'The refresh record changed under its own lock.',
        `Another process moved refresh ${row.id} for ${row.source_ids.join(', ')} while this one held its lock, so this run stopped after the merge without recording it. Check the writer status, then converge with gbrain sources refresh ${row.source_ids[0]} --resume, which adopts only a HEAD it can verify.`,
        { fix: writerStatusFix(`Shows refresh ${row.id}'s state and the member sources' heads, read-only.`, row.source_ids[0]) });
    }
    await tx.executeRaw(`UPDATE sources SET upstream_checked_at=now(),upstream_commit=$2,upstream_behind=0 WHERE id=ANY($1::text[])`, [row.source_ids, row.target_head]);
    await transition(tx, row, ['merged'], 'syncing');
  });
}

/** #6712: a member has synced the refresh once its `last_commit` is the target or a descendant of it (a commit landed on top of the target). */
async function reachedTarget(git: Git, root: string, row: WorktreeRefreshRow, commit: string | null): Promise<boolean> {
  return commit === row.target_head || (!!commit && commit !== row.old_head && await isAncestor(git, root, row.target_head, commit));
}

/** Steps 6-7: the managed `--no-pull` sync per member, then completion when every member reached target_head (or a descendant). */
async function syncMembers(engine: BrainEngine, git: Git, row: WorktreeRefreshRow, root: string): Promise<{ synced: RefreshMemberSync[]; blocked: RefreshSyncBlocked[]; atTarget: boolean }> {
  const { performManagedSync } = await import('./sync-run.ts');
  const synced: RefreshMemberSync[] = [], blocked: RefreshSyncBlocked[] = [];
  for (const sourceId of row.source_ids) {
    let status = 'up_to_date';
    for (let pass = 0; pass < MAX_MEMBER_SYNC_PASSES; pass++) {
      if (await reachedTarget(git, root, row, await lastCommit(engine, sourceId))) break;
      let result: SyncResult;
      try { result = await performManagedSync(engine, { sourceId, noPull: true }); }
      catch (error) {
        const failure = error instanceof OperationError ? error : opError('storage_error', error instanceof Error ? error.message : String(error),
          `The managed sync of source ${sourceId} failed during refresh ${row.id}. Check its writer status, fix the cause, then resume with gbrain sync --source ${sourceId} --no-pull.`);
        blocked.push({ source_id: sourceId, code: failure.code, message: failure.message, resume: `gbrain sync --source ${sourceId} --no-pull` });
        status = 'blocked';
        break;
      }
      status = result.status;
      if (result.status === 'blocked_by_failures') {
        blocked.push({ source_id: sourceId, code: result.managedWrite?.write_error ?? result.failureCodes?.[0]?.code ?? 'sync_blocked',
          message: result.managedWrite?.message ?? 'The managed sync is blocked by a failed write.', resume: `gbrain sync --source ${sourceId} --no-pull` });
        break;
      }
      if (result.status === 'partial') await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_MS));
    }
    await recordUpstreamObservation(engine, sourceId);
    synced.push({ source_id: sourceId, status, last_commit: await lastCommit(engine, sourceId) });
  }
  let atTarget = true;
  for (const member of synced) if (!await reachedTarget(git, root, row, member.last_commit)) { atTarget = false; break; }
  if (atTarget || blocked.length) await engine.transaction(tx => transition(tx, row, ['syncing'], 'completed',
    { synced, ...(blocked.length ? { sync_blocked: blocked } : {}) }));
  return { synced, blocked, atTarget };
}
async function lastCommit(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]);
  return row?.last_commit ?? null;
}

function finished(row: WorktreeRefreshRow, sync: { synced: RefreshMemberSync[]; blocked: RefreshSyncBlocked[]; atTarget: boolean }, preserved = row.preserved_uncommitted): WorktreeRefreshResult {
  const status = sync.blocked.length ? 'sync_blocked' : sync.atTarget ? 'completed' : 'syncing';
  return { status, refresh_id: row.id, worktree_id: row.worktree_id, source_ids: row.source_ids, old_head: row.old_head, target_head: row.target_head,
    upstream_ref: row.upstream_ref, preserved_uncommitted: preserved, synced: sync.synced,
    ...(sync.blocked.length ? { sync_blocked: sync.blocked, next: sync.blocked.map(item => item.resume).join(' ; ') } : {}),
    ...(status === 'syncing' ? { next: `gbrain sources refresh ${row.source_ids[0]} --resume` } : {}) };
}

/**
 * `gbrain sources refresh <source>`. Trusted local CLI on the registered owner
 * host only; refusals throw catalogue errors (`code`, cause, literal fix, docs).
 */
export async function refreshWorktree(engine: BrainEngine, sourceId: string, opts: RefreshOptions = {}): Promise<WorktreeRefreshResult> {
  if (opts.resume || opts.abandon) return resumeOrAbandon(engine, sourceId, opts);
  const fetchTimeoutMs = await configuredMs(engine, opts.fetchTimeoutMs, 'GBRAIN_REFRESH_FETCH_TIMEOUT_MS', 'sources.refresh_fetch_timeout_ms', 120_000, 2 ** 31 - 1);
  const waitDrainMs = await configuredMs(engine, opts.waitDrainMs, 'GBRAIN_REFRESH_DRAIN_WAIT_MS', 'sources.refresh_drain_wait_ms', 60_000);
  const recovered = opts.dryRun ? null : await adoptOrphanedRefresh(engine, sourceId);
  if (recovered && recovered.status !== 'completed' && recovered.status !== 'abandoned') return recovered;
  const result = await refreshOnce(engine, sourceId, opts, fetchTimeoutMs, waitDrainMs);
  return recovered?.recovered ? { ...result, recovered: recovered.recovered } : result;
}

async function refreshOnce(engine: BrainEngine, sourceId: string, opts: RefreshOptions, fetchTimeoutMs: number, waitDrainMs: number): Promise<WorktreeRefreshResult> {
  return withGit(async git => {
    const plan = await precheck(engine, git, sourceId, fetchTimeoutMs);
    const base = { refresh_id: null, worktree_id: plan.binding.worktree_id, source_ids: plan.members, old_head: plan.oldHead,
      target_head: plan.targetHead, upstream_ref: plan.upstreamRef, preserved_uncommitted: plan.preserved, incoming_files: plan.incoming };
    if (opts.dryRun) return { ...base, status: 'dry_run', synced: [],
      next: plan.oldHead === plan.targetHead ? `Already at ${plan.upstreamRef}; nothing to fast-forward.` : `gbrain sources refresh ${sourceId}` };
    if (plan.oldHead === plan.targetHead) {
      const synced: RefreshMemberSync[] = [], blocked: RefreshSyncBlocked[] = [];
      const { performManagedSync } = await import('./sync-run.ts');
      for (const member of plan.members) {
        await recordUpstreamObservation(engine, member);
        if (await lastCommit(engine, member) === plan.oldHead) { synced.push({ source_id: member, status: 'up_to_date', last_commit: plan.oldHead }); continue; }
        try {
          const result = await performManagedSync(engine, { sourceId: member, noPull: true });
          if (result.status === 'blocked_by_failures') blocked.push({ source_id: member, code: result.managedWrite?.write_error ?? 'sync_blocked',
            message: result.managedWrite?.message ?? 'The managed sync is blocked by a failed write.', resume: `gbrain sync --source ${member} --no-pull` });
          synced.push({ source_id: member, status: result.status, last_commit: await lastCommit(engine, member) });
        } catch (error) {
          blocked.push({ source_id: member, code: (error as OperationError).code ?? 'storage_error', message: (error as Error).message, resume: `gbrain sync --source ${member} --no-pull` });
        }
      }
      return { ...base, status: blocked.length ? 'sync_blocked' : 'already_current', synced, ...(blocked.length ? { sync_blocked: blocked, next: blocked.map(b => b.resume).join(' ; ') } : {}) };
    }
    const refreshLock = await acquireNativeLock(refreshLockPath(plan.binding.worktree_id), { timeoutMs: 1000 });
    if (!refreshLock) throw inProgress('Another process is refreshing this worktree right now.', sourceId);
    try {
      const principal = await topologyPrincipal(engine);
      const row = await fenceDraining(engine, sourceId, plan, principal);
      const config = loadConfig() ?? { engine: engine.kind };
      // The owner keeps claiming what is already queued; this process may be that owner.
      startPersistenceConsumer(engine, config);
      const deadline = performance.now() + waitDrainMs;
      for (;;) {
        const counts = await drainCounts(engine, row.worktree_id);
        if (counts.requests + counts.effects + counts.recovery === 0) break;
        if (performance.now() >= deadline) {
          await abort(engine, row, ['draining'], refusal('refresh_drain_timeout',
            `The worktree queue did not drain within ${waitDrainMs} ms (${counts.requests} request(s), ${counts.effects} checkout effect(s), ${counts.recovery} recovery record(s) pending); the fence was lifted and nothing moved.`,
            `Retry gbrain sources refresh ${sourceId}, or wait longer: gbrain sources refresh ${sourceId} --wait-drain ${Math.ceil(Math.max(waitDrainMs * 2, 120_000) / 1000)}. Inspect the queue with gbrain sources writer status ${sourceId} --json.`), { counts });
        }
        await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_MS));
      }
      await opts.hooks?.boundary?.('drained', row);
      const merged = await fenceAndMerge(engine, git, sourceId, plan, row, opts.hooks);
      await opts.hooks?.boundary?.('syncing', merged);
      const sync = await syncMembers(engine, git, merged, plan.root);
      return finished(await readRefresh(engine, row.id), sync, plan.preserved);
    } finally { await refreshLock.release(); }
  });
}

/** Step 2: native topology + worktree locks, then one transaction inserting the `draining` row. */
async function fenceDraining(engine: BrainEngine, sourceId: string, plan: Plan, principal: string): Promise<WorktreeRefreshRow> {
  return withTopologyLocks(engine, sourceId, async bindings => engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','5s',true)");
    await lockTopologyPrincipal(tx, principal);
    const sources = await lockTopologyRows(tx, sourceId, bindings);
    const current = bindings.find(binding => binding.worktree_id === plan.binding.worktree_id);
    if (!current || String(current.owner_epoch) !== String(plan.binding.owner_epoch) || String(current.topology_generation) !== String(plan.binding.topology_generation)
      || sources.join(',') !== plan.members.join(',')) {
      throw refusal('refresh_source_changed', 'The worktree ownership or source membership changed after the refresh precheck; nothing moved.', `Retry gbrain sources refresh ${sourceId}`);
    }
    const [row] = await tx.executeRaw<WorktreeRefreshRow>(`INSERT INTO persistence_worktree_refreshes
      (worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref,preserved_uncommitted,outcome)
      VALUES($1::uuid,$2::text[],$3::uuid,$4,$5,'draining',$6,$7,$8,$9::text[],$10::text::jsonb) RETURNING *`,
    [plan.binding.worktree_id, plan.members, principal, String(current.owner_epoch), String(current.topology_generation),
      plan.oldHead, plan.targetHead, plan.upstreamRef, plan.preserved, JSON.stringify({ holder: refreshHolder() })]);
    return row;
  })).catch(error => {
    if ((error as { code?: string }).code === '23505' && !classifyOriginUniqueViolation(error)) throw inProgress('Another refresh of this worktree started first.', sourceId);
    throw error;
  });
}

/** Steps 3-5 under the worktree native lock: recheck drained, fence, verify HEAD, ff-only merge, bookkeeping. */
async function fenceAndMerge(engine: BrainEngine, git: Git, sourceId: string, plan: Plan, row: WorktreeRefreshRow, hooks?: RefreshHooks): Promise<WorktreeRefreshRow> {
  let fenced: WorktreeRefreshRow;
  try {
    fenced = await withTopologyLocks(engine, sourceId, async bindings => {
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','5s',true)");
        const sources = await lockTopologyRows(tx, sourceId, bindings, row.id);
        const current = bindings.find(binding => binding.worktree_id === row.worktree_id);
        if (!current || String(current.owner_epoch) !== String(row.owner_epoch) || String(current.topology_generation) !== String(row.topology_generation)
          || sources.join(',') !== row.source_ids.join(',')) {
          throw refusal('refresh_source_changed', 'The worktree ownership or source membership changed while the refresh drained; nothing moved.', `Retry gbrain sources refresh ${sourceId}`, row.id);
        }
        const counts = await drainCounts(tx, row.worktree_id);
        if (counts.requests + counts.effects + counts.recovery > 0) throw refusal('refresh_source_changed',
          `Work reached the worktree after the drain check (${counts.requests} request(s), ${counts.effects} checkout effect(s), ${counts.recovery} recovery record(s)); nothing moved.`,
          `Retry gbrain sources refresh ${sourceId}`, row.id);
        if (!await transition(tx, row, ['draining'], 'fenced')) throw refusal('refresh_source_changed', 'The refresh record was moved by recovery while draining.', `gbrain sources refresh ${sourceId} --resume`, row.id);
      });
      const current = await readRefresh(engine, row.id);
      await hooks?.boundary?.('fenced', current);
      const head = await headOf(git, plan.root);
      if (head !== row.old_head) {
        if (head === null) throw await markRecoveryRequired(engine, current, head, plan.root);
        await abort(engine, current, ['fenced'], refusal('refresh_source_changed',
          `The checkout HEAD moved from ${row.old_head} to ${head} after the precheck (an external commit or checkout); nothing was merged.`, `Retry gbrain sources refresh ${sourceId}`));
      }
      const dirt = await dirtyOverlap(git, plan.root, row.old_head, row.target_head);
      if (dirt.overlap.length) await abort(engine, current, ['fenced'], dirtyRefusal(sourceId, dirt.overlap));
      const merge = await git(['-C', plan.root, 'merge', '--ff-only', '--no-edit', '--quiet', row.target_head], 120_000);
      const after = await headOf(git, plan.root);
      if (merge.code !== 0 || after !== row.target_head) {
        if (after === row.old_head) await abort(engine, current, ['fenced'], refusal('refresh_dirty',
          `git merge --ff-only refused (${merge.stderr.trim().split('\n')[0] || `exit ${merge.code}`}); HEAD is unchanged at ${row.old_head}.`,
          `Commit or discard the paths git names (check gbrain sources writer status ${sourceId} --json for pending git effects), then retry gbrain sources refresh ${sourceId}.`));
        throw await markRecoveryRequired(engine, current, after, plan.root);
      }
      await hooks?.boundary?.('merged', current);
      await bookkeeping(engine, current);
      return readRefresh(engine, row.id);
    }, undefined, 30_000);
  } catch (error) {
    const stored = await readRefresh(engine, row.id);
    if (stored.state === 'draining' && error instanceof OperationError) {
      await engine.transaction(tx => transition(tx, stored, ['draining'], 'aborted', refusalOutcome(error)));
      error.detail ??= `refresh_id=${row.id}`;
    }
    throw error;
  }
  return fenced;
}

async function hostRoot(engine: BrainEngine, worktreeId: string, hostId = localHostId()): Promise<string | null> {
  const [row] = await engine.executeRaw<{ local_path: string | null }>(
    'SELECT local_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid', [worktreeId, hostId]);
  return row?.local_path ?? null;
}

/**
 * Section 1.5: deterministic, bounded convergence of one interrupted refresh.
 * The caller holds the refresh lock. Returns the row after the step.
 */
async function recoverOne(engine: BrainEngine, git: Git, row: WorktreeRefreshRow, root: string, unattended = false): Promise<WorktreeRefreshRow> {
  const head = await headOf(git, root);
  if (head === null && unattended && row.state !== 'draining') throw inProgress(`Refresh ${row.id} is orphaned, but the checkout HEAD could not be read, so it stays ${row.state}; once git can read HEAD again, the next refresh retries it.`, row.source_ids[0], row.id);
  if (row.state === 'draining') {
    await engine.transaction(tx => transition(tx, row, ['draining'], 'aborted', { refusal: { code: 'refresh_interrupted', cause: 'The refreshing process stopped while draining; no merge was started.' } }));
  } else if (row.state === 'fenced' && head === row.old_head) {
    await engine.transaction(tx => transition(tx, row, ['fenced'], 'aborted', { refusal: { code: 'refresh_interrupted', cause: 'The refreshing process stopped before merging; HEAD is unchanged.' } }));
  } else if (['fenced', 'merged', 'recovery_required'].includes(row.state) && head === row.target_head && await isAncestor(git, root, row.old_head, row.target_head)) {
    await bookkeeping(engine, row);
  } else if (row.state === 'syncing' && head !== null && (head === row.target_head || await isAncestor(git, root, row.target_head, head))) {
    // stays syncing; the member syncs run from --resume or any later cycle sync.
  } else if (row.state !== 'recovery_required') {
    await markRecoveryRequired(engine, row, head, root);
  }
  return readRefresh(engine, row.id);
}

/**
 * Owner recovery (the consumer's topology scan): every interrupted refresh on
 * this host's worktrees whose refreshing process has exited (its refresh lock
 * is free) is converged one step, so the scan finds nothing on the next tick.
 * Member syncs are not run here. #7679: an orphaned `syncing` row whose members
 * all synced to the target or a descendant of it (a later cycle sync caught
 * them up) and whose HEAD is still at the target is completed here (a lagging one is re-checked after a member moves or a minute passes); one whose members lag is finished by the next
 * plain `gbrain sources refresh`, which runs the `--resume` path, or by `--resume`.
 */
/**
 * A lagging orphaned `syncing` row, keyed by refresh id, with the member `last_commit`s it lagged at and when: the scan re-checks it once a
 * member moves, or after LAGGING_RECHECK_MS (a git failure reads as lagging, so a cached verdict never outlives a transient one).
 */
const laggingSyncing = new Map<string, { commits: string; at: number }>();
const LAGGING_RECHECK_MS = 60_000;

export async function resumeWorktreeRefreshes(engine: BrainEngine, opts: { hostId?: string } = {}): Promise<number> {
  const host = opts.hostId ?? localHostId();
  const rows = await engine.executeRaw<WorktreeRefreshRow>(`SELECT f.* FROM persistence_worktree_refreshes f
    JOIN persistence_worktrees w ON w.id=f.worktree_id WHERE w.owner_host_id=$1::uuid AND f.state IN ('draining','fenced','merged','syncing')
    AND (f.state<>'syncing' OR NOT EXISTS (SELECT 1 FROM sources s WHERE s.id=ANY(f.source_ids) AND (s.last_commit IS NULL OR s.last_commit=f.old_head)))
    ORDER BY f.state='syncing', f.created_at LIMIT 16`, [host]);
  let moved = 0;
  for (const row of rows) {
    const root = await hostRoot(engine, row.worktree_id, host);
    if (!root) continue;
    const commits = row.state === 'syncing' ? (await engine.executeRaw<{ last_commit: string | null }>(
      'SELECT last_commit FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [row.source_ids])).map(source => source.last_commit ?? '').join(',') : null;
    const lagging = commits === null ? undefined : laggingSyncing.get(row.id);
    if (lagging?.commits === commits && Date.now() - lagging.at < LAGGING_RECHECK_MS) continue;
    const lock = await tryAcquireNativeLock(refreshLockPath(row.worktree_id));
    if (!lock) continue;
    try {
      await withGit(async git => {
        if (commits !== null && !await membersAtTarget(engine, git, row, root)) { laggingSyncing.set(row.id, { commits, at: Date.now() }); return; }
        const after = await withTopologyLocks(engine, row.source_ids[0], async () => {
          const current = await readRefresh(engine, row.id);
          return current.state === 'syncing' ? completeSyncedOrphan(engine, git, current, root) : recoverOne(engine, git, current, root, true);
        }, undefined, 0);
        if (after.state !== row.state) moved++;
      });
    } catch (error) {
      // GBRA-130 A-34: one refresh's unexpected failure leaves that row for the next topology scan and never stops the others or the scan.
      if (!(error instanceof OperationError && ['write_pending', 'recovery_required', 'refresh_recovery_required', 'refresh_in_progress', 'owner_unavailable'].includes(error.code))) {
        console.error(`[gbrain] worktree refresh ${row.id} (${row.source_ids.join(', ')}) did not converge in the owner's topology scan (${String((error as { code?: unknown } | null)?.code ?? (error as Error)?.name ?? 'error')}); it stays ${row.state} and the owner's next topology scan retries it. Check it with gbrain sources writer status ${row.source_ids[0]}.`);
      }
    } finally { await lock.release(); }
  }
  return moved;
}

/**
 * #7679: an orphaned `syncing` row completes once every member's `last_commit` reached the target (or a descendant) and the
 * checkout HEAD is still the target or a descendant of it; otherwise it is left as it is (an unrelated or unreadable HEAD
 * waits for an attended --resume, which names both ways out).
 */
async function completeSyncedOrphan(engine: BrainEngine, git: Git, row: WorktreeRefreshRow, root: string): Promise<WorktreeRefreshRow> {
  const synced = await membersAtTarget(engine, git, row, root);
  if (!synced) return row;
  const head = await headOf(git, root);
  if (head === null || (head !== row.target_head && !await isAncestor(git, root, row.target_head, head))) return row;
  await engine.transaction(tx => transition(tx, row, ['syncing'], 'completed', { synced, completed_by: 'owner_recovery' }));
  return readRefresh(engine, row.id);
}

/** Every member's sync at the target (or a descendant), or null while one lags. Read-only, so the scan checks it before taking any topology lock. */
async function membersAtTarget(engine: BrainEngine, git: Git, row: WorktreeRefreshRow, root: string): Promise<RefreshMemberSync[] | null> {
  const synced: RefreshMemberSync[] = [];
  for (const sourceId of row.source_ids) {
    const commit = await lastCommit(engine, sourceId);
    if (!await reachedTarget(git, root, row, commit)) return null;
    synced.push({ source_id: sourceId, status: 'up_to_date', last_commit: commit });
  }
  return synced;
}

async function resumeOrAbandon(engine: BrainEngine, sourceId: string, opts: RefreshOptions): Promise<WorktreeRefreshResult> {
  const binding = await getWorktreeBinding(engine, sourceId, existingLocalHostId());
  if (!await managedPersistenceEnabled(engine) || !binding) throw refusal('refresh_not_managed',
    `Source ${sourceId} has no claimed canonical worktree on a managed brain, so there is no refresh to resume.`, `gbrain sync --source ${sourceId}`);
  assertRefreshOwner(binding, sourceId, 'resume its refresh');
  const root = binding.local_path;
  const active = await readActiveRefresh(engine, binding.worktree_id);
  const empty: WorktreeRefreshResult = { status: 'nothing_to_resume', refresh_id: null, worktree_id: binding.worktree_id, source_ids: [sourceId],
    old_head: null, target_head: null, upstream_ref: null, preserved_uncommitted: [], synced: [], next: `gbrain sources refresh ${sourceId}` };
  if (!active) return empty;
  const lock = await acquireNativeLock(refreshLockPath(binding.worktree_id), { timeoutMs: 1000 }).catch(() => null as NativeLockHandle | null);
  if (!lock) throw inProgress(`Refresh ${active.id} is still running in another process (${describeHolder(holderOf(active))}).`, sourceId, active.id);
  try {
    return await withGit(async git => {
      const head = await headOf(git, root);
      if (opts.abandon) {
        const row = await readRefresh(engine, active.id);
        if (row.state === 'syncing') throw refusal('refresh_in_progress', 'The checkout already holds the upstream commit; abandoning now would leave files ahead of the database.',
          `gbrain sources refresh ${sourceId} --resume`, row.id);
        if (row.state !== 'draining' && head !== row.old_head) {
          if (head === row.target_head) throw refusal('refresh_in_progress', `The checkout is at the refresh target ${row.target_head}; finish it instead of abandoning.`,
            `gbrain sources refresh ${sourceId} --resume`, row.id);
          throw await markRecoveryRequired(engine, row, head, root);
        }
        await engine.transaction(tx => transition(tx, row, ['draining', 'fenced', 'merged', 'recovery_required'], 'aborted',
          { refusal: { code: 'refresh_abandoned', cause: `The operator abandoned the refresh with HEAD at ${head}.` } }));
        return { ...empty, status: 'abandoned', refresh_id: row.id, source_ids: row.source_ids, old_head: row.old_head, target_head: row.target_head,
          upstream_ref: row.upstream_ref, preserved_uncommitted: row.preserved_uncommitted, next: `gbrain sources refresh ${sourceId}` };
      }
      return resumeHeld(engine, git, sourceId, active.id, root, head, empty);
    });
  } finally { await lock.release(); }
}

/**
 * `--resume` under the refresh lock the caller holds: one recovery step, then the member syncs of a `syncing` row.
 * #7679: the caller becomes the row's holder; `previous_holder` keeps the first holder replaced (the refresher that died), so a refused --resume never hides it.
 */
async function resumeHeld(engine: BrainEngine, git: Git, sourceId: string, refreshId: string, root: string, head: string | null, empty: WorktreeRefreshResult, unattended = false): Promise<WorktreeRefreshResult> {
  await engine.executeRaw(`UPDATE persistence_worktree_refreshes SET outcome=outcome||jsonb_build_object('holder',$2::text::jsonb,'previous_holder',COALESCE(outcome->'previous_holder',outcome->'holder'))
    WHERE id=$1::uuid AND state IN ${ACTIVE_REFRESH_STATES_SQL}`, [refreshId, JSON.stringify(refreshHolder())]);
  let row = await withTopologyLocks(engine, sourceId, async () => recoverOne(engine, git, await readRefresh(engine, refreshId), root, unattended), undefined, 30_000);
  if (row.state === 'recovery_required' && head === row.old_head) throw refusal('refresh_recovery_required',
    `The checkout is back at the pre-refresh commit ${row.old_head}; nothing remains to resume.`, `gbrain sources refresh ${sourceId} --abandon`, row.id);
  if (row.state === 'recovery_required') {
    const stored = (row.outcome.refusal ?? {}) as { cause?: string; fix?: string };
    throw refusal('refresh_recovery_required', stored.cause ?? 'The refresh could not verify the checkout HEAD.',
      stored.fix ?? `gbrain sources writer status ${sourceId}, then gbrain sources refresh ${sourceId} --resume`, row.id);
  }
  const recovered = { refresh_id: row.id, state: row.state, previous_holder: (row.outcome.previous_holder as RefreshHolder | null | undefined) ?? null };
  if (row.state !== 'syncing') return { ...empty, status: 'abandoned', refresh_id: row.id, source_ids: row.source_ids, old_head: row.old_head,
    target_head: row.target_head, upstream_ref: row.upstream_ref, next: `The interrupted refresh was rolled back without moving HEAD; start again with gbrain sources refresh ${sourceId}`,
    recovered: { ...recovered, status: 'abandoned' } };
  startPersistenceConsumer(engine, loadConfig() ?? { engine: engine.kind });
  const sync = await syncMembers(engine, git, row, root);
  row = await readRefresh(engine, row.id);
  const result = finished(row, sync);
  return { ...result, recovered: { ...recovered, state: row.state, status: result.status } };
}

/**
 * #7679: a plain `gbrain sources refresh` that finds an active refresh whose lock no process holds (its refresher died,
 * for example a container replaced mid-refresh) finishes it through the `--resume` path instead of refusing
 * `refresh_in_progress` on every scheduled run. Returns null when there is nothing to adopt: no active row, a
 * `recovery_required` row (the user decides how to reset), publication or topology recovery pending on the worktree,
 * a live holder (the lock stays busy for a second), a caller that is not the owner, or a checkout HEAD git cannot read
 * (an unattended run never escalates on it); the precheck then refuses each case by name.
 */
async function adoptOrphanedRefresh(engine: BrainEngine, sourceId: string): Promise<WorktreeRefreshResult | null> {
  if (!await managedPersistenceEnabled(engine)) return null;
  const hostId = existingLocalHostId();
  const binding = await getWorktreeBinding(engine, sourceId, hostId);
  if (!binding || !hostId || binding.owner_host_id !== hostId || !binding.local_path) return null;
  const active = await readActiveRefresh(engine, binding.worktree_id);
  if (!active || active.state === 'recovery_required') return null;
  if (binding.state !== 'active' || await worktreeRecoveryPending(engine, binding)) return null;
  // A holder recorded on another host is never adopted: this host's lock cannot say whether it is alive.
  if ((holderOf(active)?.host_id ?? hostId) !== hostId) return null;
  const lock = await acquireNativeLock(refreshLockPath(binding.worktree_id), { timeoutMs: 1000 });
  if (!lock) return null;
  try {
    const orphan = await readActiveRefresh(engine, binding.worktree_id);
    if (!orphan || orphan.state === 'recovery_required' || (holderOf(orphan)?.host_id ?? hostId) !== hostId) return null;
    const root = binding.local_path;
    const empty: WorktreeRefreshResult = { status: 'nothing_to_resume', refresh_id: null, worktree_id: binding.worktree_id, source_ids: orphan.source_ids,
      old_head: null, target_head: null, upstream_ref: null, preserved_uncommitted: [], synced: [] };
    return await withGit(async git => {
      const head = await headOf(git, root);
      return head === null ? null : resumeHeld(engine, git, sourceId, orphan.id, root, head, empty, true);
    });
  } finally { await lock.release(); }
}

/**
 * A managed sync started elsewhere (cycle, autopilot, `gbrain sync`) while a
 * refresh drains or holds the fence is refused before discovery, so it never
 * freezes a cursor against the pre-refresh HEAD; the next cycle retries.
 */
export async function assertManagedSyncAllowed(engine: BrainEngine, worktreeId: string, sourceId: string): Promise<void> {
  const [refresh] = await engine.executeRaw<{ id: string; state: string }>(`SELECT id,state FROM persistence_worktree_refreshes
    WHERE worktree_id=$1::uuid AND state IN ('draining','fenced','merged','recovery_required')`, [worktreeId]);
  if (!refresh) return;
  if (refresh.state === 'recovery_required') throw refusal('refresh_recovery_required',
    `Refresh ${refresh.id} could not verify the checkout HEAD of source ${sourceId}; sync stays fenced.`,
    `gbrain sources writer status ${sourceId}, then gbrain sources refresh ${sourceId} --resume`, refresh.id);
  const error = refusal('worktree_refreshing', `Source ${sourceId}'s checkout is being fast-forwarded by refresh ${refresh.id} (${refresh.state}); this sync did not start.`,
    `Retry after retry_after_ms: 1000; the refresh runs this sync itself. Check progress with gbrain sources writer status ${sourceId}.`);
  error.detail = 'retry_after_ms=1000';
  throw error;
}

/**
 * #7679: whether a process still holds an active refresh's lock. The lock lives on the host that ran the refresh (the
 * recorded holder's, else the worktree owner's), so only that host can tell; a free lock means the refresher exited.
 * The probe takes the lock for an instant and releases it; a refresh starting at that instant waits a second for it.
 */
export async function refreshLiveness(worktreeId: string, holderHostId: string | null): Promise<RefreshLiveness> {
  const local = existingLocalHostId();
  if (!local || holderHostId !== local) return 'unknown';
  const lock = await tryAcquireNativeLock(refreshLockPath(worktreeId)).catch(() => undefined);
  if (lock === undefined) return 'unknown';
  if (!lock) return 'live';
  await lock.release();
  return 'orphaned';
}

/** #7679: the holder of an active refresh, whether it is orphaned, and the step that moves it on (`fix` names `--resume` whenever no process will). */
export async function refreshHolderReport(engine: BrainEngine, row: Pick<WorktreeRefreshRow, 'id' | 'worktree_id' | 'state' | 'source_ids' | 'outcome'> & { owner_host_id: string | null }):
  Promise<{ holder: RefreshHolder | null; liveness: RefreshLiveness; orphaned: boolean | null; auto_recovery: 'next_refresh' | 'none' | 'unknown'; fix: Action | null }> {
  const holder = holderOf(row);
  const holderHost = holder?.host_id ?? row.owner_host_id;
  const liveness = await refreshLiveness(row.worktree_id, holderHost);
  const source = row.source_ids[0];
  const resume = ['gbrain', 'sources', 'refresh', source, '--resume'];
  const verify = { argv: ['gbrain', 'sources', 'writer', 'status', '--source', source, '--json'] };
  const base = { holder, liveness, orphaned: liveness === 'unknown' ? null : liveness === 'orphaned' };
  if (row.state === 'recovery_required') return { ...base, auto_recovery: 'none', fix: { argv: resume, consent: [], actor: 'agent', requires_exclusive: false, verify,
    why: `Refresh ${row.id} could not verify the checkout HEAD, so nothing recovers it on its own. --resume changes nothing here: it prints the two ways out (reset to the start commit and --abandon, or to the upstream commit and --resume); resetting is destructive, so ask the user first.` } };
  if (liveness === 'live') return { ...base, auto_recovery: 'none', fix: null };
  const binding = liveness === 'orphaned' ? await getWorktreeBinding(engine, source, holderHost) : null;
  if (binding && (binding.state !== 'active' || await worktreeRecoveryPending(engine, binding))) return { ...base, auto_recovery: 'none', fix: { argv: verify.argv, consent: [], actor: 'agent', requires_exclusive: false, verify,
    why: `No process holds refresh ${row.id}'s lock, but publication or topology recovery is pending on its worktree, so no refresh adopts it until the owner finishes that recovery (this read shows it, read-only). Then the next gbrain sources refresh ${source} finishes the refresh on its own.` } };
  if (liveness === 'orphaned') return { ...base, auto_recovery: 'next_refresh', fix: { argv: resume, consent: [], actor: 'agent', requires_exclusive: false, verify,
    why: `No process holds refresh ${row.id}'s lock (recorded holder: ${describeHolder(holder)}), so it is orphaned. The next gbrain sources refresh ${source} finishes it on its own through the --resume path`
      + `${row.state === 'syncing' ? ', and the owner completes it once every member has synced to its target' : ''}; --resume finishes it now.` } };
  return { ...base, auto_recovery: 'unknown', fix: { argv: verify.argv, consent: [], actor: 'host_admin', requires_exclusive: false,
    why: `Refresh ${row.id}'s lock lives on host ${holderHost ?? 'unknown'}, not this one, so only that host can tell whether ${describeHolder(holder)} is alive. Run this there; if it reports the refresh orphaned, or that host is gone for good, gbrain sources refresh ${source} --resume on the owner host finishes it (a plain refresh does not adopt another host's refresh).` } };
}

/** `gbrain sources writer status`: active refreshes (optionally of one source's worktree) with their holder and the command that moves each on. */
export async function activeWorktreeRefreshes(engine: BrainEngine, sourceId?: string): Promise<Array<Record<string, unknown>>> {
  const rows = await engine.executeRaw<WorktreeRefreshRow & { owner_host_id: string | null }>(`SELECT f.*,w.owner_host_id::text AS owner_host_id FROM persistence_worktree_refreshes f
    LEFT JOIN persistence_worktrees w ON w.id=f.worktree_id WHERE f.state IN ${ACTIVE_REFRESH_STATES_SQL}
    AND ($1::text IS NULL OR $1=ANY(f.source_ids)) ORDER BY f.created_at`, [sourceId ?? null]);
  return Promise.all(rows.map(async row => {
    const report = await refreshHolderReport(engine, row);
    return { refresh_id: row.id, worktree_id: row.worktree_id, state: row.state, source_ids: row.source_ids,
      old_head: row.old_head, target_head: row.target_head, upstream_ref: row.upstream_ref, updated_at: new Date(row.updated_at).toISOString(),
      ...(row.outcome.refusal ? { refusal: row.outcome.refusal } : {}), ...report,
      next: report.liveness === 'live' && row.state === 'draining' ? 'Writes to this worktree are refused while queued work drains; retry them after about a second.'
        : report.liveness === 'live' ? `Wait for it: ${describeHolder(report.holder)} holds the refresh lock and finishes it.`
        : report.fix?.argv?.join(' ') ?? `gbrain sources refresh ${row.source_ids[0]} --resume` };
  }));
}

/** Doctor `worktree_refresh_stuck`: active refreshes older than `minutes`. */
export async function stuckWorktreeRefreshes(engine: BrainEngine, minutes = 15): Promise<Array<Pick<WorktreeRefreshRow, 'id' | 'state' | 'source_ids' | 'updated_at'>>> {
  return engine.executeRaw(`SELECT id,state,source_ids,updated_at FROM persistence_worktree_refreshes
    WHERE state IN ${ACTIVE_REFRESH_STATES_SQL} AND created_at < now()-($1::double precision*interval '1 minute') ORDER BY created_at`, [minutes]);
}
