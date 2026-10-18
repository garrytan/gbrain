/**
 * #6858 ask 6, option C (Garry's "rec", via GBRA-108): on-commit sync inside the resident serve.
 *
 * With `sync.on_commit` true, `gbrain serve` polls `git rev-parse HEAD` in the checkout of every managed source this host
 * owns (its worktree's `owner_host_id` is this host) every `GBRAIN_SERVE_HEAD_POLL_MS` (default 3 s, 1 to 30 s), plus a
 * best-effort `fs.watch` on the git dir (and its `logs/`) that only brings the next poll forward; the poll is the source
 * of truth. A HEAD move arms a trailing debounce (`GBRAIN_SERVE_HEAD_DEBOUNCE_MS`, default 3 s, 0 to 60 s); when HEAD
 * has been still that long and differs from what the source last synced, the watcher starts ONE managed sync through
 * the unchanged `startDelegatedSync` (`noPull`, background origin, the sync hard deadline) as this host's `cli` writer,
 * the registration a `gbrain sync` on this host uses.
 *
 * Single flight: while any delegated sync runs, or another process holds the source's drain lease, nothing starts and
 * the move stays pending; when the running sync ends the pending move starts one more sync, and a move during the
 * watcher's own sync starts exactly one follow-up once it ends (HEAD then differs from the HEAD that sync started at),
 * so a commit is never left for cron. A sync that ends resumable (deadline or another partial stop) is "not yet
 * searchable", not a failure: the watcher resumes it after the debounce, up to MAX_RESUMES times in a row, then leaves
 * it to the next HEAD move or scheduled sync. A refused or failed start is logged and not retried until HEAD moves.
 *
 * Cost when idle: one git call per checkout per poll and no database read except the flag (re-read every 30 s, so
 * flipping `sync.on_commit` needs no restart) and the source list (every 60 s while on). With the flag off nothing
 * else runs: no git call, no sync. It never writes into the checkout or `.git` (`GIT_OPTIONAL_LOCKS=0`). Every error
 * is caught and logged once per distinct message; the loop never throws into serve. serve.ts starts it beside the
 * movement watch (installResidentTickers) and awaits its stop before shutdownDelegatedSync; serve-http.ts (runServeHttp)
 * starts it beside the movement watch and awaits its stop on the same shutdown path, before the engine disconnects.
 * `stop()` re-checks after every await, so discovery or a git read in flight when it lands installs nothing and runs
 * no further git or database call; its promise settles once that step has (bounded by STOP_SETTLE_MS).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { execFileBounded } from './bounded-child-exec.ts';
import { gitChildEnv } from './git-env.ts';
import { SYNC_ON_COMMIT_KEY } from './sync-config-keys.ts';

export const HEAD_POLL_MS_DEFAULT = 3_000;
export const HEAD_DEBOUNCE_MS_DEFAULT = 3_000;
export const HEAD_FLAG_EVERY_MS = 30_000;
export const HEAD_LIST_EVERY_MS = 60_000;
/** Resumable syncs in a row the watcher resumes on its own before it leaves the source to the next move or cron. */
export const MAX_RESUMES = 3;
/** How long `stop()` waits for an in-flight step before it resolves anyway (inside the stdio serve's 5 s cleanup deadline). */
export const STOP_SETTLE_MS = 3_000;
const NUDGE_MS = 250;
const LOG_ONCE_CAP = 200;

export interface WatchedSource { sourceId: string; root: string; gitDir: string | null; lastCommit: string | null }
export type OnCommitStart = { jobId: string } | { busy: true } | { refused: string };
export interface OnCommitJobStatus { state: 'running' | 'aborting' | 'done' | 'error'; outcome?: 'synced' | 'resumable' | 'blocked'; reason?: string; error?: string }

export interface ServeHeadWatcherOptions {
  log: (line: string) => void;
  pollMs?: number;
  debounceMs?: number;
  env?: Record<string, string | undefined>;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  readFlag?: () => Promise<boolean>;
  listSources?: () => Promise<WatchedSource[]>;
  /** The source's last synced commit (`sources.last_commit`), re-read right before a start. */
  lastCommit?: (sourceId: string) => Promise<string | null>;
  revParse?: (root: string) => Promise<string>;
  syncRunning?: () => boolean | Promise<boolean>;
  drainHeld?: (sourceId: string) => Promise<boolean>;
  startSync?: (sourceId: string) => Promise<OnCommitStart>;
  jobStatus?: (jobId: string) => OnCommitJobStatus | null;
  watch?: (gitDir: string, onChange: () => void) => (() => void) | null;
}

/** `stop()` stops polling at once and resolves when the in-flight step has settled (at most STOP_SETTLE_MS); await it before the engine disconnects. */
export interface ServeHeadWatcher { tick(): Promise<void>; stop(): Promise<void>; readonly enabled: boolean }

interface SourceState extends WatchedSource { head: string | null; movedAt: number | null; synced: string | null; resumes: number }

const truthy = (value: string | null | undefined) => typeof value === 'string' && /^(1|true|on|yes)$/i.test(value.trim());
const bounded = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
};
const short = (sha: string | null) => sha ? sha.slice(0, 8) : 'none';

async function git(root: string, args: string[]): Promise<string> {
  const r = await execFileBounded('git', ['-C', root, ...args], { timeout: 5_000, env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0' }) });
  if (r.error) throw new Error((r.stderr || r.error.message).trim().split('\n')[0] || 'git failed');
  return r.stdout.trim();
}

function defaultDeps(engine: BrainEngine): Required<Pick<ServeHeadWatcherOptions, 'readFlag' | 'listSources' | 'lastCommit' | 'revParse' | 'syncRunning' | 'drainHeld' | 'startSync' | 'jobStatus' | 'watch'>> {
  let runner: typeof import('./serve-sync-runner.ts') | null = null;
  const loadRunner = async () => runner ??= await import('./serve-sync-runner.ts');
  return {
    readFlag: async () => truthy(await engine.getConfig(SYNC_ON_COMMIT_KEY)),
    listSources: async () => {
      const { readManagedMode } = await import('./persistence/managed-mode.ts');
      if (!await readManagedMode(engine)) return [];
      const { existingLocalHostId } = await import('./persistence/identity.ts');
      const host = existingLocalHostId();
      if (!host) return [];
      const rows = await engine.executeRaw<{ source_id: string; root: string; last_commit: string | null }>(`SELECT b.source_id, h.local_path AS root, s.last_commit
        FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation AND NOT s.archived
        JOIN persistence_worktrees w ON w.id=b.worktree_id JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=w.owner_host_id
        WHERE w.owner_host_id::text=$1 ORDER BY b.source_id`, [host]);
      const gitDirs = new Map<string, string | null>();
      const out: WatchedSource[] = [];
      for (const row of rows) {
        if (!gitDirs.has(row.root)) gitDirs.set(row.root, await git(row.root, ['rev-parse', '--absolute-git-dir']).catch(() => null));
        out.push({ sourceId: row.source_id, root: row.root, gitDir: gitDirs.get(row.root) ?? null, lastCommit: row.last_commit });
      }
      return out;
    },
    lastCommit: async (sourceId) => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]))[0]?.last_commit ?? null,
    revParse: (root) => git(root, ['rev-parse', '--verify', '-q', 'HEAD']),
    syncRunning: async () => (await loadRunner()).isDelegatedSyncRunning(),
    drainHeld: async (sourceId) => (await (await import('./persistence/sync-lease.ts')).readDrainHolder(engine, sourceId)) !== null,
    startSync: async (sourceId) => {
      const r = await loadRunner();
      const { registerLocalWriter } = await import('./persistence/identity.ts');
      const local = await registerLocalWriter(engine, 'cli');
      const { resolveSyncHardDeadline } = await import('./sync-reconcile.ts');
      const deadline = resolveSyncHardDeadline([], { isTty: false, env: process.env });
      const timeoutSeconds = deadline ? Math.max(1, Math.round(deadline.deadlineMs / 1000)) : 3600;
      const start = await r.startDelegatedSync(engine, { sourceId, noPull: true, timeoutSeconds, origin: 'background' }, `on-commit-${randomUUID()}`,
        { registration: { id: local.id, credential: local.credential, lane: 'cli' } });
      if (start.ok && start.jobId) return { jobId: start.jobId };
      if (start.error === 'busy' || start.error === 'shutting_down') return { busy: true };
      return { refused: String(start.refusal?.message ?? start.error ?? 'refused') };
    },
    jobStatus: (jobId) => {
      const s = runner?.getDelegatedSyncStatus(jobId);
      if (!s || !s.ok || !s.state) return null;
      return { state: s.state, ...(s.drain ? { outcome: s.drain.outcome, ...(s.drain.stop_reason ? { reason: s.drain.stop_reason } : {}) } : {}), ...(s.jobError ? { error: s.jobError } : {}) };
    },
    watch: (gitDir, onChange) => {
      const closers: Array<() => void> = [];
      for (const dir of [gitDir, join(gitDir, 'logs')]) {
        if (!existsSync(dir)) continue;
        try {
          const w = fsWatch(dir, { persistent: false }, () => onChange());
          w.on('error', () => { try { w.close(); } catch { /* already closed */ } });
          closers.push(() => w.close());
        } catch { /* best effort: polling is the source of truth */ }
      }
      return closers.length ? () => { for (const close of closers) { try { close(); } catch { /* already closed */ } } } : null;
    },
  };
}

export function startServeHeadWatcher(engine: BrainEngine, opts: ServeHeadWatcherOptions): ServeHeadWatcher {
  const env = opts.env ?? process.env;
  const pollMs = opts.pollMs ?? bounded(env.GBRAIN_SERVE_HEAD_POLL_MS, HEAD_POLL_MS_DEFAULT, 1_000, 30_000);
  const debounceMs = opts.debounceMs ?? bounded(env.GBRAIN_SERVE_HEAD_DEBOUNCE_MS, HEAD_DEBOUNCE_MS_DEFAULT, 0, 60_000);
  const d = { ...defaultDeps(engine), ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) } as ReturnType<typeof defaultDeps> & ServeHeadWatcherOptions;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimeout ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = opts.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = (line: string) => { try { opts.log(`[serve-sync] on-commit: ${line}`); } catch { /* logging never breaks the loop */ } };
  const logged = new Set<string>();
  const logOnce = (key: string, line: string) => {
    if (logged.has(key)) return;
    if (logged.size >= LOG_ONCE_CAP) logged.clear();
    logged.add(key);
    log(line);
  };
  const guard = async <T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logOnce(`${what}\u0000${message}`, `${what} failed: ${message} (logged once; the watcher keeps polling)`);
      return fallback;
    }
  };

  let enabled = false;
  let stopped = false;
  let flagReadAt = -Infinity;
  let listedAt = -Infinity;
  let job: { id: string; sourceId: string; head: string } | null = null;
  const sources = new Map<string, SourceState>();
  const watchers = new Map<string, () => void>();
  let fireTimer: unknown = null;
  let nudgeTimer: unknown = null;
  let inflight: Promise<void> | null = null;
  let again = false;

  const closeWatchers = () => { for (const close of watchers.values()) { try { close(); } catch { /* best effort */ } } watchers.clear(); };
  const armFire = (ms: number) => {
    if (stopped) return;
    if (fireTimer !== null) clearTimer(fireTimer);
    fireTimer = setTimer(() => { fireTimer = null; void tick(); }, ms + 50);
  };
  const nudge = () => {
    if (stopped || nudgeTimer !== null) return;
    nudgeTimer = setTimer(() => { nudgeTimer = null; void tick(); }, NUDGE_MS);
  };

  const refreshSources = async () => {
    const listed = await guard('listing managed sources', d.listSources, null);
    if (!listed || stopped) return;
    const seen = new Set<string>();
    for (const s of listed) {
      seen.add(s.sourceId);
      const prior = sources.get(s.sourceId);
      if (prior && prior.root === s.root) { prior.gitDir = s.gitDir; continue; }
      sources.set(s.sourceId, { ...s, head: null, movedAt: null, synced: s.lastCommit, resumes: 0 });
    }
    for (const id of [...sources.keys()]) if (!seen.has(id)) sources.delete(id);
    const dirs = new Set([...sources.values()].map(s => s.gitDir).filter((dir): dir is string => !!dir));
    for (const [dir, close] of watchers) if (!dirs.has(dir)) { try { close(); } catch { /* best effort */ } watchers.delete(dir); }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      const close = await guard(`watching ${dir}`, async () => d.watch(dir, nudge), null);
      if (close && stopped) { try { close(); } catch { /* best effort */ } return; }
      if (close) watchers.set(dir, close);
    }
  };

  const settle = (j: NonNullable<typeof job>, st: OnCommitJobStatus | null) => {
    job = null;
    const s = sources.get(j.sourceId);
    if (!s) return;
    if (st?.state === 'done' && st.outcome === 'resumable') {
      if (++s.resumes <= MAX_RESUMES) {
        log(`${s.sourceId}: the sync stopped resumable (${st.reason ?? 'partial'}); the commit is not yet searchable, resuming (${s.resumes}/${MAX_RESUMES})`);
        s.movedAt = now();
        armFire(debounceMs);
        return;
      }
      log(`${s.sourceId}: still resumable after ${MAX_RESUMES} passes; the next HEAD move or scheduled sync resumes it`);
    } else if (st?.state === 'error') {
      logOnce(`job-error\u0000${s.sourceId}\u0000${st.error ?? ''}`, `${s.sourceId}: the sync failed: ${st.error ?? 'unknown error'} (not retried until HEAD moves)`);
    } else if (st?.state === 'done' && st.outcome === 'blocked') {
      logOnce(`job-blocked\u0000${s.sourceId}\u0000${st.reason ?? ''}`, `${s.sourceId}: the sync stopped blocked (${st.reason ?? 'unknown'}); see gbrain sync status --source ${s.sourceId} (not retried until HEAD moves)`);
    }
    s.resumes = 0;
    s.synced = j.head;
    if (s.head && s.head !== j.head) armFire(debounceMs);
  };

  const step = async () => {
    const t = now();
    if (t - flagReadAt >= HEAD_FLAG_EVERY_MS) {
      flagReadAt = t;
      const on = await guard('reading sync.on_commit', d.readFlag, enabled);
      if (stopped) return;
      if (on !== enabled) {
        enabled = on;
        listedAt = -Infinity;
        if (!on) { sources.clear(); closeWatchers(); job = null; }
        log(on ? `enabled (poll ${pollMs} ms, debounce ${debounceMs} ms)` : 'disabled');
      }
    }
    if (!enabled || stopped) return;
    if (t - listedAt >= HEAD_LIST_EVERY_MS) { listedAt = t; await refreshSources(); }
    const heads = new Map<string, string | null>();
    for (const s of sources.values()) {
      if (stopped) return;
      if (!heads.has(s.root)) heads.set(s.root, await guard(`reading HEAD in ${s.root}`, () => d.revParse(s.root), null));
      const head = heads.get(s.root) ?? null;
      if (head && head !== s.head) { s.head = head; s.movedAt = t; armFire(debounceMs); }
    }
    if (job) {
      const st = d.jobStatus(job.id);
      if (st && st.state !== 'done' && st.state !== 'error') return;
      settle(job, st);
    }
    if (stopped) return;
    // Every due source in order: one whose drain lease is held or whose last_commit already covers HEAD is skipped, so a
    // long sync of one source never starves another; at most one start per step (global single flight on syncRunning).
    const due = [...sources.values()].filter(s => s.head && s.head !== s.synced && (s.movedAt === null || now() - s.movedAt >= debounceMs));
    if (!due.length || await d.syncRunning()) return;
    for (const s of due) {
      if (stopped) return;
      const synced = await guard(`reading the last synced commit of ${s.sourceId}`, () => d.lastCommit(s.sourceId), null);
      if (stopped) return;
      if (synced && synced === s.head) { s.synced = synced; s.resumes = 0; continue; }
      const held = await guard(`reading the drain lease of ${s.sourceId}`, () => d.drainHeld(s.sourceId), true);
      if (stopped) return;
      if (held) continue;
      const head = s.head!;
      const start = await guard(`starting a sync of ${s.sourceId}`, () => d.startSync(s.sourceId), null);
      if (!start) { s.synced = head; return; }
      if ('busy' in start) return;
      if ('refused' in start) {
        logOnce(`refused\u0000${s.sourceId}\u0000${start.refused}`, `${s.sourceId}: the serve refused the sync: ${start.refused} (not retried until HEAD moves)`);
        s.synced = head;
        return;
      }
      job = { id: start.jobId, sourceId: s.sourceId, head };
      log(`${s.sourceId}: HEAD moved to ${short(head)} (last synced ${short(s.synced)}); started managed sync job ${start.jobId}`);
      return;
    }
  };

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inflight) { again = true; return inflight; }
    inflight = (async () => {
      do {
        again = false;
        try { await step(); } catch (error) { logOnce(`step\u0000${String(error)}`, `unexpected error: ${error instanceof Error ? error.message : String(error)}`); }
      } while (again && !stopped);
    })().finally(() => { inflight = null; });
    return inflight;
  };

  const interval = (opts.setInterval ?? ((fn: () => void, ms: number) => { const h = setInterval(fn, ms); h.unref?.(); return h; }))(() => { void tick(); }, pollMs);
  return {
    tick,
    get enabled() { return enabled; },
    stop: async () => {
      if (!stopped) {
        stopped = true;
        (opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(interval);
        if (fireTimer !== null) clearTimer(fireTimer);
        if (nudgeTimer !== null) clearTimer(nudgeTimer);
        closeWatchers();
      }
      if (!inflight) return;
      let bound: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([inflight, new Promise<void>(resolve => { bound = setTimeout(resolve, STOP_SETTLE_MS); bound.unref?.(); })]);
      clearTimeout(bound);
      closeWatchers();
    },
  };
}
