/**
 * GBRA-133 PR 2a: the commit notifier inside a resident process (serve stdio and http, `gbrain jobs work`, the
 * autopilot daemon). Supplies the production seams of ../commit-notifier.ts:
 *  - the SQL store (store.ts) with the host lease on Postgres and none on PGLite (the lock holder owns);
 *  - the sources this host syncs: managed sources whose worktree it owns, classic sources it last synced
 *    (syncer_host_id) or that `GBRAIN_NOTIFIER_CLASSIC_SOURCES` binds here; every other source is skipped with a reason;
 *  - starts through the in-process delegated sync runner (serve-sync-runner.ts) as this host's `cli` writer, one job
 *    at a time, never pulling unless a pull request (marker) asked for it;
 *  - a per-source trace file (`<gbrain home>/notifier/<source>.jsonl`, bounded) named by sync status.
 * One notifier per process: `nudgeResidentNotifier` (the IPC sync_nudge handler, the serve runner) reaches it.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { gbrainPath } from '../config.ts';
import { registerCleanup } from '../process-cleanup.ts';
import { SYNC_ON_COMMIT_KEY } from '../sync-config-keys.ts';
import { localHostId } from '../persistence/identity.ts';
import {
  notifierDisabledByEnv, parseExcludedSources, parseOnCommit, startCommitNotifier,
  type CommitNotifier, type CommitNotifierOptions, type NotifierSource, type NotifierStore, type ResidentKind, type SkippedSource,
} from '../commit-notifier.ts';
import {
  claimLease, holdsLease, readDueMarkers, readNotifierSources, releaseLease, settleMarkers, upsertMarker, writeCoverage, writeState, pruneSatisfiedMarkers,
} from './store.ts';
import { gitQuiet, resolveGitDirs, revParseHead, watchGitDirs, watchTargets } from './detect.ts';

/** Per-source opt-out: source ids whose HEAD the notifier does not watch (markers still drain). */
export const SYNC_ON_COMMIT_SOURCES_KEY = 'sync.on_commit.sources';
const TRACE_MAX_BYTES = 256 * 1024;

let active: { notifier: CommitNotifier; resident: ResidentKind } | null = null;

/** The notifier running in this process, if any (the IPC handler and the serve runner nudge it). */
export function residentNotifier(): { notifier: CommitNotifier; resident: ResidentKind } | null { return active; }
export function nudgeResidentNotifier(): boolean { if (!active) return false; active.notifier.nudge(); return true; }

export function sqlNotifierStore(engine: BrainEngine): NotifierStore {
  return {
    claimLease: async (l) => {
      if (engine.kind === 'pglite') return null;
      const r = await claimLease(engine, l);
      return r.owner ? r : { owner: false, holderKind: r.holder?.resident_kind ?? null };
    },
    holdsLease: (hostId, ownerId, fence) => holdsLease(engine, hostId, ownerId, fence),
    releaseLease: (hostId, ownerId) => releaseLease(engine, hostId, ownerId),
    dueMarkers: async (ids) => { await pruneSatisfiedMarkers(engine, ids); return readDueMarkers(engine, ids); },
    liveJobs: async (ids) => new Set((await engine.executeRaw<{ id: unknown }>(
      "SELECT id FROM minion_jobs WHERE id = ANY($1::bigint[]) AND status IN ('waiting','active','delayed','waiting-children','paused')", [ids])).map(r => Number(r.id))),
    forward: async (sourceId, head) => { await upsertMarker(engine, { sourceId, intent: 'freshness', wantedHead: head, requestedBy: 'notifier' }); },
    settleMarkers: (sourceId, read, run) => settleMarkers(engine, sourceId, read, run),
    readStates: (ids) => readNotifierSources(engine, ids),
    writeState: (sourceId, patch) => writeState(engine, sourceId, patch),
    writeCoverage: (sourceId, c) => writeCoverage(engine, sourceId, c),
  };
}

/** Source ids `GBRAIN_NOTIFIER_CLASSIC_SOURCES` binds to this host (classic sources this host syncs without a recorded run). */
export function classicBinding(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(parseExcludedSources(env.GBRAIN_NOTIFIER_CLASSIC_SOURCES));
}

/** The sources this host's notifier syncs, and the ones it skips with the reason. */
export async function listHostSources(engine: BrainEngine, hostId: string, env: Record<string, string | undefined> = process.env): Promise<{ sources: NotifierSource[]; skipped: SkippedSource[] }> {
  const { readManagedMode } = await import('../persistence/managed-mode.ts');
  const managed = await readManagedMode(engine).catch(() => false);
  const rows = await engine.executeRaw<{ id: string; local_path: string | null; last_commit: string | null; bound: boolean; owner: string | null; root: string | null; syncer: string | null }>(
    `SELECT s.id, s.local_path, s.last_commit, (b.source_id IS NOT NULL) AS bound, w.owner_host_id::text AS owner, h.local_path AS root, n.syncer_host_id AS syncer
       FROM sources s
       LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
       LEFT JOIN persistence_worktrees w ON w.id = b.worktree_id
       LEFT JOIN persistence_host_bindings h ON h.worktree_id = w.id AND h.host_id = w.owner_host_id
       LEFT JOIN sync_notifier_sources n ON n.source_id = s.id
      WHERE NOT s.archived ORDER BY s.id`);
  const bind = classicBinding(env);
  const sources: NotifierSource[] = [];
  const skipped: SkippedSource[] = [];
  const dirs = new Map<string, Awaited<ReturnType<typeof resolveGitDirs>>>();
  for (const row of rows) {
    let root: string | null;
    let kind: 'managed' | 'classic';
    if (managed && (row.bound === true || (row.bound as unknown) === 't')) {
      kind = 'managed';
      if (row.owner !== hostId) { skipped.push({ sourceId: row.id, reason: `its managed worktree is owned by host ${String(row.owner ?? 'none').slice(0, 8)}; that host's resident syncs it` }); continue; }
      root = row.root;
    } else if (managed) {
      skipped.push({ sourceId: row.id, reason: 'not bound to a managed worktree (gbrain sources writer status)' });
      continue;
    } else {
      kind = 'classic';
      root = row.local_path;
      if (!root) { skipped.push({ sourceId: row.id, reason: 'no local checkout path' }); continue; }
      if (!bind.has(row.id) && row.syncer !== hostId) {
        skipped.push({ sourceId: row.id, reason: row.syncer
          ? `classic source last synced on host ${row.syncer.slice(0, 8)}; its resident there watches it (or bind it here with GBRAIN_NOTIFIER_CLASSIC_SOURCES=${row.id})`
          : `classic source with no recorded syncer host; run gbrain sync --source ${row.id} once on the host that syncs it, or set GBRAIN_NOTIFIER_CLASSIC_SOURCES=${row.id}` });
        continue;
      }
    }
    if (!root) { skipped.push({ sourceId: row.id, reason: 'no local checkout path' }); continue; }
    if (!dirs.has(root)) dirs.set(root, await resolveGitDirs(root));
    const d = dirs.get(root) ?? null;
    if (!d) { skipped.push({ sourceId: row.id, reason: `${root} is not a git checkout on this host` }); continue; }
    sources.push({ sourceId: row.id, root, gitDir: d.gitDir, commonDir: d.commonDir, lastCommit: row.last_commit, kind });
  }
  return { sources, skipped };
}

/** Appends one JSON line to the source's trace file (truncated to its newer half past TRACE_MAX_BYTES); returns the path. */
export function appendTrace(sourceId: string, event: Record<string, unknown>): string {
  const path = gbrainPath('notifier', `${sourceId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (statSync(path).size > TRACE_MAX_BYTES) {
      const text = readFileSync(path, 'utf8');
      writeFileSync(path, text.slice(text.indexOf('\n', Math.floor(text.length / 2)) + 1));
    }
  } catch { /* new file */ }
  appendFileSync(path, JSON.stringify(event) + '\n');
  return path;
}

/** The production start: the in-process delegated runner, as this host's cli writer, never pulling unless asked. */
export function runnerStart(engine: BrainEngine): Pick<CommitNotifierOptions, 'startSync' | 'jobStatus' | 'syncRunning' | 'drainHeld'> {
  let runner: typeof import('../serve-sync-runner.ts') | null = null;
  const load = async () => runner ??= await import('../serve-sync-runner.ts');
  return {
    startSync: async (sourceId, req) => {
      const r = await load();
      const { registerLocalWriter } = await import('../persistence/identity.ts');
      const local = await registerLocalWriter(engine, 'cli');
      const { resolveSyncHardDeadline } = await import('../sync-reconcile.ts');
      const deadline = resolveSyncHardDeadline([], { isTty: false, env: process.env });
      const hard = deadline ? Math.max(1, Math.round(deadline.deadlineMs / 1000)) : 3600;
      const timeoutSeconds = req.sliceSeconds ? Math.min(hard, Math.max(1, Math.round(req.sliceSeconds))) : hard;
      const start = await r.startDelegatedSync(engine, { sourceId, noPull: req.intent !== 'pull', ...(req.intent === 'full' ? { full: true } : {}), timeoutSeconds, origin: 'background' },
        `on-commit-${randomUUID()}`, { registration: { id: local.id, credential: local.credential, lane: 'cli' }, logLines: true });
      if (start.ok && start.jobId) return { jobId: start.jobId };
      if (start.error === 'busy' || start.error === 'shutting_down') return { busy: true };
      return { refused: String(start.refusal?.message ?? start.error ?? 'refused') };
    },
    jobStatus: (jobId) => {
      const s = runner?.getDelegatedSyncStatus(jobId);
      if (!s || !s.ok || !s.state) return null;
      return { state: s.state, ...(s.drain ? { outcome: s.drain.outcome, committed: s.drain.written + s.drain.waived > 0, ...(s.drain.stop_reason ? { reason: s.drain.stop_reason } : {}) } : {}),
        ...(s.jobError ? { error: s.jobError } : {}) };
    },
    syncRunning: async () => (await load()).isDelegatedSyncRunning(),
    drainHeld: async (sourceId) => {
      // #7614: a killed holder's lock row defers nothing; the sync this starts takes its expired lease over.
      const { holderStalled, readLiveDrainHolder } = await import('../persistence/sync-lease.ts');
      const holder = await readLiveDrainHolder(engine, sourceId);
      return holder === null ? false : holderStalled(holder) ? 'stalled' : true;
    },
  };
}

export type ResidentNotifierOptions = Partial<Omit<CommitNotifierOptions, 'resident' | 'log'>> & { resident: ResidentKind; log: (line: string) => void };

/** The production defaults for every seam the caller did not inject. */
export function residentNotifierOptions(engine: BrainEngine, opts: ResidentNotifierOptions): CommitNotifierOptions {
  const env = opts.env ?? process.env;
  // Host identity: the persistence host id (minted on first use, as a managed claim or a recorded classic sync does).
  const hostId = opts.hostId ?? localHostId();
  const defaults: Omit<CommitNotifierOptions, 'resident' | 'log' | 'hostId'> = {
    store: sqlNotifierStore(engine),
    maxConcurrent: 1,
    firstSliceSeconds: 30,
    sliceSeconds: 120,
    readFlag: async () => parseOnCommit(await engine.getConfig(SYNC_ON_COMMIT_KEY)),
    readExcluded: async () => parseExcludedSources(await engine.getConfig(SYNC_ON_COMMIT_SOURCES_KEY)),
    listSources: () => listHostSources(engine, hostId, env),
    lastCommit: async (sourceId) => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]))[0]?.last_commit ?? null,
    revParse: revParseHead,
    quiet: (s) => gitQuiet(s.gitDir),
    watch: (s, onChange) => s.gitDir ? watchGitDirs(watchTargets(s.gitDir, s.commonDir ?? null), onChange) : null,
    trace: appendTrace,
    ...runnerStart(engine),
  };
  return { ...defaults, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)), hostId } as CommitNotifierOptions;
}

/**
 * Starts this process's notifier, or returns null when GBRAIN_NOTIFIER=0 turned it off or one is
 * the one started before it is replaced as this process's nudge target. Never awaits anything: the first pass runs in the background, so a resident's startup (an MCP
 * handshake, a worker's first claim) never waits on git or a catch-up sync.
 */
export function startResidentNotifier(engine: BrainEngine, opts: ResidentNotifierOptions): CommitNotifier | null {
  if (notifierDisabledByEnv(opts.env ?? process.env)) { try { opts.log(`[notifier:${opts.resident}] off (GBRAIN_NOTIFIER=0); commits on this host are not synced by this process`); } catch { /* log only */ } return null; }
  const notifier = startCommitNotifier(residentNotifierOptions(engine, opts));
  const entry = { notifier, resident: opts.resident };
  active = entry;
  const stop = notifier.stop;
  // GBRA-133 2b-d2: a termination signal the process does not own (SIGTERM/SIGHUP on serve, serve --http, the
  // autopilot daemon) runs the cleanup pass and exits; stopping here releases the host's notifier lease first, so the
  // next resident owns it at its first claim instead of after the lease expires. A SIGKILL still waits for expiry.
  let deregisterCleanup = (): void => {};
  const wrapped: CommitNotifier = Object.assign(Object.create(Object.getPrototypeOf(notifier)), notifier, {
    stop: async () => { deregisterCleanup(); if (active === entry) active = null; await stop(); },
  });
  deregisterCleanup = registerCleanup(`commit-notifier:${opts.resident}`, () => wrapped.stop());
  Object.defineProperties(wrapped, {
    enabled: { get: () => notifier.enabled }, owner: { get: () => notifier.owner }, decisions: { get: () => notifier.decisions },
  });
  entry.notifier = wrapped;
  // Catch up at once on whatever moved while no resident ran (in the background).
  (opts.setTimeout ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }))(() => { void notifier.tick(); }, 0);
  return wrapped;
}

/** Tests: forget the process notifier without stopping it (each test stops its own). */
export function __resetResidentNotifierForTests(): void { active = null; }
