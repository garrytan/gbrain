/**
 * `gbrain sources git-reconcile [<source-id>...] [--dry-run] [--wait <seconds>] [--json]`: bring every source checkout on
 * this host level with its upstream, idempotently, so any thread, agent, cron or hook can call it as often and as
 * concurrently as it likes. A level checkout costs one fetch and reports in_sync. A managed checkout (a persistence
 * worktree) is reconciled by `gbrain sources refresh`, which publishes its local commits (secret gate, rewrite check,
 * Git durability) and fast-forwards; a refresh already running is waited for, then the checkout is checked again. Any
 * other checkout goes through reconcileCheckout (src/core/git/reconcile.ts). Merges are in memory; nothing rebases or
 * force-pushes. A brain with no Git checkout reports no_repo and exits 0.
 *
 * Exit: 0 when every checkout is level (or has nothing to reconcile), 1 when one needs the user (a conflict, a
 * secret, a rewritten upstream, durability off), 4 when one failed in a way a retry can fix (network, a busy lock).
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { reconcileCheckout, fetchLevel, gitReader, withReconcileLock, type CheckoutReconcileStatus } from '../core/git/reconcile.ts';
import { isTruthy } from '../core/connectors/config-keys.ts';
import { existsSync, realpathSync } from 'node:fs';
import { classifyGitCheckout } from '../core/git-checkout.ts';
import { gitTopLevel } from '../core/persistence/git-gap.ts';
import { isOwnedClone } from '../core/url-clone.ts';
import { isSyncDisabledConfig } from '../core/sync-policy.ts';
import { OperationError } from '../core/ops/contract.ts';
import { classifyItemFailure, type ClassifiedItemFailure } from '../core/item-failure.ts';
import { existingHostIdFor } from '../core/persistence/identity.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from '../core/persistence/ownership.ts';
import { REFRESH_PUBLISH_DIVERGED_KEY, publishOptedOut, refreshWorktree } from '../core/persistence/worktree-refresh.ts';
import { listSources } from '../core/sources-ops.ts';

const USAGE = 'Usage: gbrain sources git-reconcile [<source-id>...] [--dry-run] [--wait <seconds>] [--json]';
const RETRYABLE = new Set(['fetch_failed', 'push_unconfirmed', 'commit_lock_busy', 'refresh_in_progress', 'refresh_lock_timeout', 'refresh_drain_timeout', 'git_unavailable']);

export type SourceReconcileStatus = CheckoutReconcileStatus | 'needs_user' | 'failed';

export interface SourceReconcile {
  sources: string[]; root: string; managed: boolean; status: SourceReconcileStatus; ahead: number; behind: number;
  sha?: string; integrated?: number; reason?: string; refresh_id?: string | null;
  /** GST-2250: the sources with `sources.auto_reconcile.source.<id>` false, whose local commits are never published here. */
  publish_off?: string[];
  error?: { code: string; message: string; suggestion?: string; fix?: unknown };
}

export interface ReconcileOptions { sourceIds?: string[]; dryRun?: boolean; waitMs?: number; sleep?: (ms: number) => Promise<void>; childTimeoutMs?: number }

const refreshBusy = (error: unknown) => error instanceof OperationError && error.code === 'refresh_in_progress';

function groupRefusal(error: unknown, failure: ClassifiedItemFailure): Pick<SourceReconcile, 'status' | 'error'> {
  if (!(error instanceof OperationError)) return { status: failure.class === 'transient' ? 'failed' : 'needs_user', error: { code: failure.code, message: failure.message } };
  return { status: RETRYABLE.has(error.code) ? 'failed' : 'needs_user',
    error: { code: error.code, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}), ...(error.fix ? { fix: error.fix } : {}) } };
}

async function reconcileManaged(engine: BrainEngine, sourceId: string, root: string, publish: boolean, opts: ReconcileOptions, unpublishedReason: string): Promise<Omit<SourceReconcile, 'sources' | 'root' | 'managed'>> {
  const level = await fetchLevel(root, gitReader(root));
  if (!level) return { status: 'no_upstream', ahead: 0, behind: 0 };
  if (!level.ahead && !level.behind) return { status: 'in_sync', ahead: 0, behind: 0, sha: level.target };
  if (level.ahead && !publish) return { status: 'unpublished', ahead: level.ahead, behind: level.behind, sha: level.target, reason: unpublishedReason };
  if (opts.dryRun) return { status: level.ahead ? 'published' : 'fast_forwarded', ahead: level.ahead, behind: level.behind, sha: level.target, reason: 'dry run: nothing changed' };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = Date.now() + (opts.waitMs ?? 300_000);
  for (;;) {
    try {
      const done = await refreshWorktree(engine, sourceId);
      return { status: done.published ? 'published' : 'fast_forwarded', ahead: level.ahead, behind: level.behind, sha: done.target_head ?? undefined, refresh_id: done.refresh_id,
        ...(done.published ? { integrated: done.published.integrated } : {}) };
    } catch (error) {
      if (!refreshBusy(error) || Date.now() >= deadline) throw error;
      await sleep(2000);
      const again = await fetchLevel(root, gitReader(root));
      if (again && !again.ahead && !again.behind) return { status: 'in_sync', ahead: 0, behind: 0, sha: again.target };
    }
  }
}

export async function reconcileSources(engine: BrainEngine, opts: ReconcileOptions = {}): Promise<SourceReconcile[]> {
  const explicit = !!opts.sourceIds?.length;
  const all = (await listSources(engine)).filter(s => s.local_path);
  const listed = all.filter(s => !explicit || opts.sourceIds!.includes(s.id));
  const unknown = (opts.sourceIds ?? []).filter(id => !listed.some(s => s.id === id));
  if (unknown.length) throw new OperationError('unknown_source', `No source with a local checkout named ${unknown.join(', ')}.`, 'gbrain sources list shows each source and its local path.');
  const configs = new Map((await engine.executeRaw<{ id: string; config: unknown }>('SELECT id, config FROM sources')).map(row => [row.id, row.config]));
  const managed = await managedPersistenceEnabled(engine);
  const configured = (await engine.getConfig(REFRESH_PUBLISH_DIVERGED_KEY))?.trim();
  const publishSetting = configured ? isTruthy(configured) : null;
  const groups = new Map<string, { sources: string[]; root: string; top: string; managed: boolean; cloned: boolean }>();
  const sharers = new Map<string, string[]>();
  for (const source of all) {
    const binding = managed ? await getWorktreeBinding(engine, source.id, existingHostIdFor(engine)) : null;
    if (managed && !binding) continue;
    const root = binding?.local_path ?? source.local_path!;
    if (!existsSync(root) || classifyGitCheckout(root) === 'not_git') continue;
    const top = gitTopLevel(root) ?? realpathSync(root);
    sharers.set(top, [...(sharers.get(top) ?? []), source.id]);
    if (!listed.includes(source) || (!explicit && isSyncDisabledConfig(configs.get(source.id)))) continue;
    const key = binding ? `worktree:${binding.worktree_id}` : `path:${root}`;
    const cloned = isOwnedClone({ id: source.id, local_path: source.local_path, config: configs.get(source.id) }) && top === realpathSync(root);
    const group = groups.get(key) ?? { sources: [], root, top, managed: !!binding, cloned };
    group.sources.push(source.id);
    group.cloned &&= cloned;
    groups.set(key, group);
  }
  if (!groups.size) return [{ sources: [], root: '', managed: false, status: 'no_repo', ahead: 0, behind: 0 }];
  const out: SourceReconcile[] = [];
  for (const group of groups.values()) {
    const { cloned, top, ...entry } = group;
    let off: { publish_off?: string[] } = {};
    try {
      const optedOut = await publishOptedOut(engine, sharers.get(top) ?? group.sources);
      const publish = optedOut.length ? false : group.managed ? publishSetting !== false : publishSetting ?? cloned;
      if (optedOut.length) off = { publish_off: optedOut };
      const offReason = `automatic publishing is off for ${optedOut.join(', ')} (sources.auto_reconcile.source.<id> false)`;
      const result = group.managed
        ? await withReconcileLock(group.root, opts.waitMs ?? 300_000, () => reconcileManaged(engine, group.sources[0], group.root, publish, opts,
          optedOut.length ? offReason : `automatic publishing is off (${REFRESH_PUBLISH_DIVERGED_KEY} false)`))
        : await reconcileCheckout(group.root, { dryRun: opts.dryRun, publish, ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}), ...(opts.childTimeoutMs ? { childTimeoutMs: opts.childTimeoutMs } : {}),
          ...(optedOut.length ? { unpublishedReason: offReason } : publishSetting === null && !cloned ? { unpublishedReason: `gbrain sources add --url did not clone this checkout for the source, or the source folder is not the repository root; publish it with gbrain git commit-push --push-only --scan-secrets --path ${group.root}, or set ${REFRESH_PUBLISH_DIVERGED_KEY} true to publish such checkouts automatically` } : {}) });
      out.push({ ...entry, ...result, ...off });
    } catch (error) {
      const failure = classifyItemFailure(error);
      if (!(error instanceof OperationError) && failure.scope === 'run') throw error;
      out.push({ ...entry, ahead: 0, behind: 0, ...off, ...groupRefusal(error, failure) });
    }
  }
  return out;
}

export function parseReconcileArgs(args: string[]): { json: boolean; options: ReconcileOptions } {
  const sourceIds: string[] = [];
  let waitMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' || arg === '--dry-run') continue;
    if (arg === '--wait') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value < 0) throw new OperationError('invalid_params', `--wait needs a non-negative number of seconds; got ${args[i] ?? 'nothing'}.`, USAGE);
      waitMs = Math.round(value * 1000);
      continue;
    }
    if (arg.startsWith('-')) throw new OperationError('invalid_params', `Unknown sources git-reconcile flag: ${arg}.`, USAGE);
    sourceIds.push(arg);
  }
  return { json: args.includes('--json'), options: { sourceIds, dryRun: args.includes('--dry-run'), ...(waitMs !== undefined ? { waitMs } : {}) } };
}

function line(r: SourceReconcile): string {
  const who = r.sources.length ? `${r.sources.join(', ')} (${r.root})` : 'this brain';
  const counts = r.ahead || r.behind ? ` [${r.ahead} ahead, ${r.behind} behind]` : '';
  switch (r.status) {
    case 'in_sync': return `${who}: in sync with its upstream`;
    case 'published': return `${who}: published local commits${r.integrated ? ` merged with ${r.integrated} upstream commit(s)` : ''}${counts}${r.reason ? ` (${r.reason})` : ''}`;
    case 'fast_forwarded': return `${who}: brought up to its upstream${counts}${r.reason ? ` (${r.reason})` : ''}`;
    case 'lagging': return `${who}: published, but the checkout did not advance: ${r.reason ?? 'local edits block it'}`;
    case 'unpublished': return `${who}: ${r.ahead} local commit(s) left unpublished: ${r.reason}${counts}`;
    case 'no_repo': return `${who}: no Git checkout, nothing to reconcile`;
    case 'no_upstream': return `${who}: the branch has no upstream, nothing to reconcile`;
    default: return `${who}: ${r.status === 'needs_user' ? 'needs the user' : 'failed, retry'}: ${r.error?.code}: ${r.error?.message}${r.error?.suggestion ? ` Next: ${r.error.suggestion}` : ''}`;
  }
}

export async function runSourcesReconcile(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  const { json, options } = parseReconcileArgs(args);
  const results = await reconcileSources(engine, options);
  const exit = results.some(r => r.status === 'needs_user') ? 1 : results.some(r => r.status === 'failed') ? 4 : 0;
  if (json) console.log(JSON.stringify({ results, exit }, null, 2));
  else for (const r of results) console.log(`${line(r)}${r.publish_off && r.status !== 'unpublished' ? ` (automatic publishing is off for ${r.publish_off.join(', ')})` : ''}`);
  if (exit) setCliExitVerdict(exit);
}
