/**
 * GBRA-133 PR 2a: CommitNotifier, the one place a commit becomes a sync without anyone running one. Extracted from the
 * serve's on-commit watcher (serve-head-watcher.ts, #6858 ask 6), which is now the serve's adapter over this loop.
 *
 * Residents: `gbrain serve` (stdio and http), `gbrain jobs work` and the autopilot daemon start it (notifier/resident.ts).
 * Ownership: one owner per host and brain. On Postgres the owner holds the host's row in sync_notifier_leases (atomic
 * claim, conditional renew, a fencing token re-checked before every start, takeover once a lease interval is missed);
 * a non-owner keeps its fs.watch and forwards a HEAD move as a freshness wanted marker. On PGLite the process holding
 * the database (the serve, whose IPC socket takes `sync_nudge`) is the owner; no lease row is written.
 *
 * What it watches: managed sources whose worktree this host owns, and classic sources whose last sync ran on this host
 * (sync_notifier_sources.syncer_host_id) or that GBRAIN_NOTIFIER_CLASSIC_SOURCES binds here; any other source is
 * skipped with a reason. HEAD is watched while `sync.on_commit` is on and the source is not listed in
 * `sync.on_commit.sources` (the exclusion list); wanted markers (sync trigger, webhook, busy delegated syncs) are
 * drained regardless of the flag. It never pulls on its own: a commit-triggered run imports the checkout's HEAD.
 *
 * Detection: fs.watch on the git dirs (notifier/detect.ts) brings the next poll forward; the async rev-parse poll every
 * `GBRAIN_NOTIFIER_POLL_MS` (alias GBRAIN_SERVE_HEAD_POLL_MS, default 3 s) is the source of truth; a source whose dirs
 * cannot be watched runs in poll mode, and the mode is reported. Start rule: leading edge when the checkout is quiet
 * (no rebase/merge/cherry-pick state, no index.lock), then a trailing window `GBRAIN_NOTIFIER_QUIET_MS` (alias
 * GBRAIN_SERVE_HEAD_DEBOUNCE_MS, default 400 ms) before the next start of the same source.
 *
 * Scheduling: per-source single flight, a host cap (1 on PGLite; the in-process runner is one job at a time), and fair
 * order (the source started least recently goes first), so a long or blocked source never starves another. Durable
 * states per source (store.ts): due, running, retry with next_retry_at (5 s, 15 s, 1 min, 5 min), operator_blocked;
 * first_due_at is kept until convergence is verified (last_commit equals the observed HEAD and no marker is due). A
 * failed or refused start, an error or blocked run, and a resumable stop keep the source due; after the 5-minute tier
 * with no progress the reason becomes notifier_stalled, with the exact fix and the trace file in sync status.
 *
 * Cost when idle: one git call per watched checkout per poll, a marker read every MARKER_SCAN_MS (or at once on a
 * nudge), and on Postgres the lease renewal every heartbeat. State and coverage rows are written on change only.
 * Every error is caught and logged once per distinct message; the loop never throws into its resident.
 */
import { randomUUID } from 'node:crypto';
import type { DetectionMode, MarkerIntent, NotifierSourceRow, NotifierState, StatePatch, WantedMarker } from './notifier/store.ts';

export type ResidentKind = 'serve' | 'serve-http' | 'jobs-worker' | 'autopilot';

export const POLL_MS_DEFAULT = 3_000;
export const QUIET_MS_DEFAULT = 400;
export const FLAG_EVERY_MS = 30_000;
export const LIST_EVERY_MS = 60_000;
export const MARKER_SCAN_MS = 15_000;
export const HEARTBEAT_MS_DEFAULT = 10_000;
/** Capped retry backoff while a source stays due; past the last tier with no progress the reason is notifier_stalled. */
export const RETRY_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
export const STOP_SETTLE_MS = 3_000;
const NUDGE_MS = 250;
const LOG_ONCE_CAP = 200;
const DECISIONS_CAP = 500;

export interface NotifierSource {
  sourceId: string;
  root: string;
  gitDir: string | null;
  commonDir?: string | null;
  lastCommit: string | null;
  kind?: 'managed' | 'classic';
}
export interface SkippedSource { sourceId: string; reason: string }
export type StartResult = { jobId: string } | { busy: true } | { refused: string };
/** `committed`: the run wrote pages or advanced its cursor (GBRA-133 PR 3a), which is progress even while `last_commit` stays put. */
export interface JobStatus { state: 'running' | 'aborting' | 'done' | 'error'; outcome?: 'synced' | 'resumable' | 'blocked'; reason?: string; error?: string; committed?: boolean }
export interface StartRequest { intent: MarkerIntent; sliceSeconds: number | null; first: boolean }

/** A recorded scheduling decision (tests and the notifier block read these instead of wall-clock timing). */
export interface NotifierDecision { at: number; source: string; decision: string; waitMs?: number; detail?: string }

/** The durable seam; the default is the SQL store (notifier/store.ts), tests pass an in-memory one. */
export interface NotifierStore {
  /** Postgres: claim or renew the host lease. Returns null when this brain has no lease (PGLite: the lock holder owns). */
  claimLease(l: { hostId: string; ownerId: string; kind: string; pid: number; leaseMs: number }): Promise<{ owner: true; fence: number } | { owner: false; holderKind: string | null } | null>;
  holdsLease(hostId: string, ownerId: string, fence: number): Promise<boolean>;
  releaseLease(hostId: string, ownerId: string): Promise<void>;
  dueMarkers(sourceIds: string[]): Promise<WantedMarker[]>;
  /** Of these minion job ids, the ones still waiting or running (their worker drains the marker). */
  liveJobs(jobIds: number[]): Promise<Set<number>>;
  forward(sourceId: string, head: string): Promise<void>;
  settleMarkers(sourceId: string, read: WantedMarker[], run: { pulled: boolean; full: boolean }): Promise<WantedMarker[]>;
  readStates(sourceIds: string[]): Promise<NotifierSourceRow[]>;
  writeState(sourceId: string, patch: StatePatch): Promise<void>;
  writeCoverage(sourceId: string, c: { head: string | null; mode: DetectionMode; ownerHostId: string; ownerKind: string; ownerPid: number }): Promise<void>;
}

export interface CommitNotifierOptions {
  resident: ResidentKind;
  log: (line: string) => void;
  hostId: string;
  /** 1 on PGLite (and with the in-process runner); the scheduler never runs more starts than this at once. */
  maxConcurrent?: number;
  pollMs?: number;
  quietMs?: number;
  heartbeatMs?: number;
  /** Seconds a commit-triggered run may take before it stops resumable; null leaves the runner's own deadline. */
  sliceSeconds?: number | null;
  /** Seconds the first run after a resident starts may take (managed); classic first runs are unbounded but in the background. */
  firstSliceSeconds?: number | null;
  env?: Record<string, string | undefined>;
  now?: () => number;
  pid?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  store: NotifierStore;
  readFlag: () => Promise<boolean>;
  readExcluded?: () => Promise<string[]>;
  listSources: () => Promise<NotifierSource[] | { sources: NotifierSource[]; skipped: SkippedSource[] }>;
  lastCommit: (sourceId: string) => Promise<string | null>;
  revParse: (root: string) => Promise<string>;
  quiet?: (source: NotifierSource) => boolean;
  syncRunning?: () => boolean | Promise<boolean>;
  /** Whether another process holds the source's drain lease; `stalled` when that holder made no commit or cursor save for the stall window. */
  drainHeld?: (sourceId: string) => Promise<boolean | 'stalled'>;
  startSync: (sourceId: string, req: StartRequest) => Promise<StartResult>;
  jobStatus: (jobId: string) => JobStatus | null;
  watch?: (source: NotifierSource, onChange: () => void) => (() => void) | null;
  trace?: (sourceId: string, event: Record<string, unknown>) => string | null;
}

export interface NotifierSourceSnapshot {
  source_id: string;
  kind: 'managed' | 'classic' | null;
  watched: boolean;
  mode: DetectionMode;
  head: string | null;
  last_commit: string | null;
  state: NotifierState;
  attempts: number;
  next_retry_in_ms: number | null;
  markers: Array<{ intent: MarkerIntent; generation: number }>;
}

export interface CommitNotifier {
  tick(): Promise<void>;
  /** Brings the next step forward (an IPC nudge or a marker write in this process). */
  nudge(): void;
  stop(): Promise<void>;
  readonly enabled: boolean;
  readonly owner: boolean;
  readonly decisions: readonly NotifierDecision[];
  snapshot(): { resident: ResidentKind; owner: boolean; enabled: boolean; sources: NotifierSourceSnapshot[]; skipped: SkippedSource[] };
}

interface Rt extends NotifierSource {
  head: string | null;
  watched: boolean;
  watchClose: (() => void) | null;
  coverageKey: string | null;
  lastStartAt: number;
  forwarded: string | null;
  state: NotifierState;
  attempts: number;
  nextRetryAt: number;
  blockedKey: string | null;
  markers: WantedMarker[];
  started: boolean;
}

interface RunningJob { id: string; sourceId: string; head: string | null; lastCommit: string | null; intent: MarkerIntent; markers: WantedMarker[] }

const truthy = (value: string | null | undefined) => typeof value === 'string' && /^(1|true|on|yes)$/i.test(value.trim());
const falsy = (value: string | null | undefined) => typeof value === 'string' && /^(0|false|off|no)$/i.test(value.trim());
export const bounded = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
};
const short = (sha: string | null) => sha ? sha.slice(0, 8) : 'none';

/** GBRAIN_NOTIFIER=0 turns the notifier off for this process. */
export function notifierDisabledByEnv(env: Record<string, string | undefined> = process.env): boolean {
  return falsy(env.GBRAIN_NOTIFIER);
}

/** The one parser for `sync.on_commit` (watcher, doctor and status share it). */
export function parseOnCommit(value: string | null | undefined): boolean {
  return truthy(value);
}

/** The `sync.on_commit.sources` exclusion list: comma or whitespace separated source ids. */
export function parseExcludedSources(value: string | null | undefined): string[] {
  return (value ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

export function resolvePollMs(env: Record<string, string | undefined>): number {
  return bounded(env.GBRAIN_NOTIFIER_POLL_MS ?? env.GBRAIN_SERVE_HEAD_POLL_MS, POLL_MS_DEFAULT, 1_000, 30_000);
}
export function resolveQuietMs(env: Record<string, string | undefined>): number {
  return bounded(env.GBRAIN_NOTIFIER_QUIET_MS ?? env.GBRAIN_SERVE_HEAD_DEBOUNCE_MS, QUIET_MS_DEFAULT, 0, 60_000);
}

/** The notifier's settings and its logging and decision helpers, resolved once from its options. */
function notifierKit(opts: CommitNotifierOptions) {
  const env = opts.env ?? process.env;
  const pollMs = opts.pollMs ?? resolvePollMs(env);
  const quietMs = opts.quietMs ?? resolveQuietMs(env);
  const heartbeatMs = opts.heartbeatMs ?? bounded(env.GBRAIN_NOTIFIER_HEARTBEAT_MS, HEARTBEAT_MS_DEFAULT, 200, 120_000);
  const leaseMs = heartbeatMs * 2;
  const cap = Math.max(1, opts.maxConcurrent ?? 1);
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const ownerId = randomUUID();
  const forcePoll = (env.GBRAIN_NOTIFIER_DETECTION ?? '').trim().toLowerCase() === 'poll';
  const setTimer = opts.setTimeout ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = opts.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const tag = opts.resident === 'serve' || opts.resident === 'serve-http' ? '[serve-sync] on-commit' : `[notifier:${opts.resident}]`;
  const log = (line: string) => { try { opts.log(`${tag}: ${line}`); } catch { /* logging never breaks the loop */ } };
  const logged = new Set<string>();
  const logOnce = (key: string, line: string) => {
    if (logged.has(key)) return;
    if (logged.size >= LOG_ONCE_CAP) logged.clear();
    logged.add(key);
    log(line);
  };
  /** A source that made progress logs its next stall again. */
  const forgetLog = (key: string) => { logged.delete(key); };
  const guard = async <T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logOnce(`${what}\u0000${message}`, `${what} failed: ${message} (logged once; the notifier keeps polling)`);
      return fallback;
    }
  };
  const decisions: NotifierDecision[] = [];
  const decide = (source: string, decision: string, extra: { waitMs?: number; detail?: string } = {}) => {
    decisions.push({ at: now(), source, decision, ...extra });
    if (decisions.length > DECISIONS_CAP) decisions.splice(0, decisions.length - DECISIONS_CAP);
  };
  return { pollMs, quietMs, heartbeatMs, leaseMs, cap, now, pid, ownerId, forcePoll, setTimer, clearTimer, log, logOnce, forgetLog, guard, decisions, decide };
}

const closeWatch = (rt: Rt) => { if (rt.watchClose) { try { rt.watchClose(); } catch { /* best effort */ } rt.watchClose = null; } };
const mode = (rt: Rt): DetectionMode => rt.watchClose ? 'watch' : 'poll';
const markerKey = (rt: Rt) => `${rt.head ?? ''}|${rt.markers.map(m => `${m.intent}:${m.generation}`).join(',')}`;
const due = (rt: Rt) => (rt.watched && !!rt.head && rt.head !== rt.lastCommit) || rt.markers.length > 0;

/** Merges a fresh source listing into the runtime map (a moved root starts over); returns the sources new to it. */
function mergeListed(sources: Map<string, Rt>, rows: NotifierSource[]): Rt[] {
  const seen = new Set<string>();
  const fresh: Rt[] = [];
  for (const s of rows) {
    seen.add(s.sourceId);
    const prior = sources.get(s.sourceId);
    if (prior && prior.root === s.root) { prior.gitDir = s.gitDir; prior.commonDir = s.commonDir ?? null; prior.lastCommit = s.lastCommit; prior.kind = s.kind; continue; }
    if (prior) closeWatch(prior);
    const rt: Rt = { ...s, head: null, watched: false, watchClose: null, coverageKey: null, lastStartAt: -Infinity, forwarded: null,
      state: 'idle', attempts: 0, nextRetryAt: 0, blockedKey: null, markers: [], started: false };
    sources.set(s.sourceId, rt);
    fresh.push(rt);
  }
  for (const [id, rt] of [...sources]) if (!seen.has(id)) { closeWatch(rt); sources.delete(id); }
  return fresh;
}

/** The intent a start asks for (full over pull over freshness) and its time slice. */
function startPlan(rt: Rt, candidates: number, opts: Pick<CommitNotifierOptions, 'firstSliceSeconds' | 'sliceSeconds'>): { intent: MarkerIntent; first: boolean; slice: number | null } {
  const intent: MarkerIntent = rt.markers.some(m => m.intent === 'full') ? 'full' : rt.markers.some(m => m.intent === 'pull') ? 'pull' : 'freshness';
  const first = !rt.started;
  const slice = first && opts.firstSliceSeconds !== undefined && rt.kind !== 'classic' ? opts.firstSliceSeconds : candidates > 1 ? (opts.sliceSeconds ?? null) : null;
  return { intent, first, slice };
}

/** The durable state survives the resident: a restart resumes attempts, the next retry and a blocked run. */
function restoreStates(sources: Map<string, Rt>, states: NotifierSourceRow[], nowMs: number): void {
  for (const row of states) {
    const rt = sources.get(row.source_id);
    if (!rt) continue;
    rt.state = row.state === 'running' ? 'due' : row.state;
    rt.attempts = row.attempts;
    rt.nextRetryAt = row.next_retry_at ? Date.parse(row.next_retry_at) - Date.now() + nowMs : 0;
  }
}

/** The capped backoff after a failure: progress resets the count; past the last tier with no progress it is stalled. */
function retryPlan(priorAttempts: number, progressed: boolean): { attempts: number; wait: number; stalled: boolean } {
  const attempts = progressed ? 1 : priorAttempts + 1;
  return { attempts, wait: RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]!, stalled: !progressed && attempts > RETRY_BACKOFF_MS.length };
}

async function settleWithin(p: Promise<void>, ms: number): Promise<void> {
  let bound: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise<void>(resolve => { bound = setTimeout(resolve, ms); bound.unref?.(); })]);
  clearTimeout(bound);
}

function snapshotSource(rt: Rt, now: number): NotifierSourceSnapshot {
  return { source_id: rt.sourceId, kind: rt.kind ?? null, watched: rt.watched, mode: mode(rt), head: rt.head, last_commit: rt.lastCommit, state: rt.state,
    attempts: rt.attempts, next_retry_in_ms: rt.nextRetryAt ? Math.max(0, rt.nextRetryAt - now) : null,
    markers: rt.markers.map(m => ({ intent: m.intent, generation: m.generation })) };
}

/** Each source's wanted markers that no live queued job already covers; an unreadable marker table keeps the last read. */
async function readOwedMarkers(opts: CommitNotifierOptions, guard: ReturnType<typeof notifierKit>['guard'], sources: Map<string, Rt>): Promise<void> {
  const ids = [...sources.keys()];
  const markers = ids.length ? await guard('reading wanted markers', () => opts.store.dueMarkers(ids), null) : [];
  if (!markers) return;
  const jobIds = markers.flatMap(m => m.job_id === null ? [] : [m.job_id]);
  const live = jobIds.length ? await guard('reading queued sync jobs', () => opts.store.liveJobs(jobIds), new Set<number>()) : new Set<number>();
  // A managed source never pulls: its pull markers (a push webhook) wait for gbrain sources refresh, not for this loop.
  for (const rt of sources.values()) rt.markers = markers.filter(m => m.source_id === rt.sourceId && (m.job_id === null || !live.has(m.job_id))
    && !(m.intent === 'pull' && rt.kind === 'managed'));
}

export function startCommitNotifier(opts: CommitNotifierOptions): CommitNotifier {
  const { pollMs, quietMs, heartbeatMs, leaseMs, cap, now, pid, ownerId, forcePoll, setTimer, clearTimer, log, logOnce, forgetLog, guard, decisions, decide } = notifierKit(opts);

  let enabled = false;
  let excluded = new Set<string>();
  let owner = false;
  let fence: number | null = null;
  let leased = false;
  let stopped = false;
  let flagReadAt = -Infinity;
  let listedAt = -Infinity;
  let markersAt = -Infinity;
  let leaseAt = -Infinity;
  let nudged = false;
  let firstPass = true;
  const sources = new Map<string, Rt>();
  let skipped: SkippedSource[] = [];
  const running = new Map<string, RunningJob>();
  let fireTimer: unknown = null;
  let fireAt = Infinity;
  let nudgeTimer: unknown = null;
  let inflight: Promise<void> | null = null;
  let again = false;

  const armFire = (ms: number) => {
    if (stopped) return;
    const at = now() + ms;
    if (fireTimer !== null && fireAt <= at) return;
    if (fireTimer !== null) clearTimer(fireTimer);
    fireAt = at;
    fireTimer = setTimer(() => { fireTimer = null; fireAt = Infinity; void tick(); }, ms + 20);
  };
  const nudge = () => {
    if (stopped) return;
    nudged = true;
    if (nudgeTimer !== null) return;
    nudgeTimer = setTimer(() => { nudgeTimer = null; void tick(); }, NUDGE_MS);
  };
  const closeAllWatches = () => { for (const rt of sources.values()) closeWatch(rt); };

  const transition = async (rt: Rt, patch: StatePatch) => {
    rt.state = patch.state;
    if (patch.attempts !== undefined) rt.attempts = patch.attempts;
    rt.nextRetryAt = patch.nextRetryInMs ? now() + patch.nextRetryInMs : 0;
    await guard(`recording the notifier state of ${rt.sourceId}`, () => opts.store.writeState(rt.sourceId, patch), undefined);
  };
  const trace = (rt: Rt, event: Record<string, unknown>): string | null => {
    try { return opts.trace?.(rt.sourceId, { at: new Date(now()).toISOString(), source_id: rt.sourceId, resident: opts.resident, head: rt.head, last_commit: rt.lastCommit, ...event }) ?? null; }
    catch { return null; }
  };

  const refreshSources = async () => {
    const listed = await guard('listing the sources this host syncs', opts.listSources, null);
    if (!listed || stopped) return;
    const rows = Array.isArray(listed) ? listed : listed.sources;
    skipped = Array.isArray(listed) ? [] : listed.skipped;
    for (const s of skipped) logOnce(`skip\u0000${s.sourceId}\u0000${s.reason}`, `${s.sourceId}: not watched here: ${s.reason}`);
    const fresh = mergeListed(sources, rows);
    if (fresh.length) {
      // Restart: the durable state (attempts, next retry, a blocked run) survives the resident.
      const states = await guard('reading the notifier states', () => opts.store.readStates(fresh.map(r => r.sourceId)), [] as NotifierSourceRow[]);
      restoreStates(sources, states, now());
    }
    for (const rt of sources.values()) rt.watched = enabled && !excluded.has(rt.sourceId);
    for (const rt of sources.values()) {
      if (stopped) return;
      if (!rt.watched || forcePoll || !opts.watch) { if (!rt.watched) closeWatch(rt); continue; }
      if (rt.watchClose) continue;
      const close = await guard(`watching ${rt.root}`, async () => opts.watch!(rt, nudge), null);
      if (close && stopped) { try { close(); } catch { /* best effort */ } return; }
      rt.watchClose = close;
    }
  };

  const ownership = async () => {
    if (stopped) return;
    const r = await guard('claiming the notifier lease', () => opts.store.claimLease({ hostId: opts.hostId, ownerId, kind: opts.resident, pid, leaseMs }), undefined);
    if (r === undefined) return;
    if (r === null) { leased = false; if (!owner) { owner = true; log(`owner of this host's notifier (${opts.resident})`); } return; }
    leased = true;
    if (r.owner) {
      if (!owner) log(`owner of this host's notifier (${opts.resident}, fence ${r.fence})`);
      owner = true; fence = r.fence;
    } else {
      if (owner) log(`another resident took over the notifier (${r.holderKind ?? 'unknown'}); forwarding HEAD moves`);
      owner = false; fence = null;
    }
  };

  const observe = async (rt: Rt, heads: Map<string, string | null>) => {
    if (!heads.has(rt.root)) heads.set(rt.root, await guard(`reading HEAD in ${rt.root}`, () => opts.revParse(rt.root), null));
    const head = heads.get(rt.root) ?? null;
    if (head && head !== rt.head) { rt.head = head; decide(rt.sourceId, 'head_moved', { detail: short(head) }); }
    if (!owner) return;
    const key = `${rt.head}|${mode(rt)}|${opts.hostId}|${opts.resident}|${pid}`;
    if (key !== rt.coverageKey) {
      rt.coverageKey = key;
      await guard(`recording what the notifier sees of ${rt.sourceId}`, () => opts.store.writeCoverage(rt.sourceId,
        { head: rt.head, mode: mode(rt), ownerHostId: opts.hostId, ownerKind: opts.resident, ownerPid: pid }), undefined);
    }
  };

  const failure = async (rt: Rt, code: string, message: string, progressed: boolean) => {
    const { attempts, wait, stalled } = retryPlan(rt.attempts, progressed);
    const tracePath = trace(rt, { event: 'failure', code, error: message, attempts, next_retry_ms: wait, stalled });
    await transition(rt, { state: 'retry', reason: stalled ? 'notifier_stalled' : code, firstDue: 'keep', attempts, nextRetryInMs: wait, progress: progressed,
      error: { code: stalled ? 'notifier_stalled' : code, message, tracePath } });
    decide(rt.sourceId, stalled ? 'stalled' : 'retry', { waitMs: wait, detail: code });
    if (stalled) logOnce(`stalled\u0000${rt.sourceId}`, `${rt.sourceId}: notifier_stalled: no progress after ${attempts} attempts (last: ${code}: ${message}); retrying every ${Math.round(wait / 1000)} s. Run gbrain sync --source ${rt.sourceId} --no-pull to see the error${tracePath ? `; trace: ${tracePath}` : ''}`);
    else logOnce(`fail\u0000${rt.sourceId}\u0000${code}\u0000${message}`, `${rt.sourceId}: ${code}: ${message}; the source stays due, retry in ${Math.round(wait / 1000)} s`);
    armFire(wait);
  };

  const settle = async (job: RunningJob, st: JobStatus | null) => {
    running.delete(job.sourceId);
    const rt = sources.get(job.sourceId);
    if (!rt) return;
    const lastCommit = await guard(`reading the last synced commit of ${rt.sourceId}`, () => opts.lastCommit(rt.sourceId), rt.lastCommit);
    rt.lastCommit = lastCommit;
    const progressed = lastCommit !== job.lastCommit || st?.committed === true;
    if (progressed) forgetLog(`stalled\u0000${rt.sourceId}`);
    if (st?.state === 'done' && st.outcome === 'blocked') {
      rt.blockedKey = markerKey(rt);
      const tracePath = trace(rt, { event: 'blocked', reason: st.reason ?? null });
      await transition(rt, { state: 'operator_blocked', reason: st.reason ?? 'blocked', firstDue: 'keep', progress: progressed,
        error: { code: 'sync_blocked', message: `the sync stopped blocked (${st.reason ?? 'unknown'})`, tracePath } });
      decide(rt.sourceId, 'operator_blocked', { detail: st.reason });
      logOnce(`job-blocked\u0000${rt.sourceId}\u0000${st.reason ?? ''}`, `${rt.sourceId}: the sync stopped blocked (${st.reason ?? 'unknown'}); see gbrain sync status --source ${rt.sourceId} (retried when HEAD moves or a new request arrives)`);
      return;
    }
    if (st?.state === 'done' && st.outcome === 'resumable') {
      if (!progressed) return failure(rt, 'sync_resumable', `the sync stopped resumable (${st.reason ?? 'partial'}) without advancing`, false);
      log(`${rt.sourceId}: the sync stopped resumable (${st.reason ?? 'partial'}); the commit is not yet searchable, resuming`);
      await transition(rt, { state: 'due', firstDue: 'keep', attempts: 0, progress: true });
      decide(rt.sourceId, 'resume');
      armFire(quietMs);
      return;
    }
    if (!st || st.state === 'error') {
      return failure(rt, 'sync_failed', st?.error ?? 'the sync job disappeared', progressed);
    }
    rt.markers = await guard(`settling the wanted markers of ${rt.sourceId}`,
      () => opts.store.settleMarkers(rt.sourceId, job.markers, { pulled: job.intent === 'pull', full: job.intent === 'full' }), rt.markers);
    if (!due(rt)) {
      await transition(rt, { state: 'idle', reason: null, firstDue: 'clear', attempts: 0, progress: progressed, error: null });
      decide(rt.sourceId, 'converged', { detail: short(lastCommit) });
      return;
    }
    await transition(rt, { state: 'due', firstDue: 'keep', attempts: 0, progress: progressed });
    decide(rt.sourceId, 'follow_up', { detail: `head ${short(rt.head)} vs ${short(lastCommit)}${rt.markers.length ? `, ${rt.markers.length} marker(s)` : ''}` });
    armFire(quietMs);
  };

  const schedule = async () => {
    const t = now();
    const candidates = [...sources.values()]
      .filter(rt => !running.has(rt.sourceId) && due(rt))
      .sort((a, b) => a.lastStartAt - b.lastStartAt || a.sourceId.localeCompare(b.sourceId));
    for (const rt of candidates) {
      if (stopped || !owner) return;
      if (rt.state === 'idle') await transition(rt, { state: 'due', firstDue: 'keep' });
      if (rt.state === 'operator_blocked') {
        if (rt.blockedKey === markerKey(rt)) continue;
        rt.blockedKey = null;
        await transition(rt, { state: 'due', firstDue: 'keep', attempts: 0 });
      }
      if (rt.state === 'retry' && t < rt.nextRetryAt) { decide(rt.sourceId, 'defer_retry', { waitMs: rt.nextRetryAt - t }); continue; }
      const sinceStart = t - rt.lastStartAt;
      if (sinceStart < quietMs) { decide(rt.sourceId, 'defer_window', { waitMs: quietMs - sinceStart }); armFire(quietMs - sinceStart); continue; }
      if (opts.quiet && !opts.quiet(rt)) { decide(rt.sourceId, 'defer_git_busy'); armFire(pollMs); continue; }
      if (running.size >= cap) { decide(rt.sourceId, 'defer_cap'); return; }
      const synced = await guard(`reading the last synced commit of ${rt.sourceId}`, () => opts.lastCommit(rt.sourceId), rt.lastCommit);
      if (stopped) return;
      rt.lastCommit = synced;
      if (!due(rt)) {
        await transition(rt, { state: 'idle', reason: null, firstDue: 'clear', attempts: 0, error: null });
        decide(rt.sourceId, 'converged', { detail: 'covered by another run' });
        continue;
      }
      // GBRA-133 PR 3a: a holder that commits nothing is a failed attempt, so the retry tiers run to notifier_stalled (a foreground sync follows it and takes over).
      const held = opts.drainHeld ? await guard(`reading the drain lease of ${rt.sourceId}`, () => opts.drainHeld!(rt.sourceId), true) : false;
      if (held) { if (held === 'stalled') await failure(rt, 'drain_holder_stalled', 'the process holding the drain lease has made no commit or cursor save for 5 minutes', false); else decide(rt.sourceId, 'defer_drain_lease'); continue; }
      if (opts.syncRunning && await opts.syncRunning()) { decide(rt.sourceId, 'defer_busy'); return; }
      if (leased && fence !== null && !await guard('checking the notifier lease', () => opts.store.holdsLease(opts.hostId, ownerId, fence!), false)) {
        owner = false; fence = null; decide(rt.sourceId, 'not_owner');
        log('the notifier lease moved to another resident before a start; forwarding instead');
        return;
      }
      const { intent, first, slice } = startPlan(rt, candidates.length, opts);
      const markers = [...rt.markers];
      rt.lastStartAt = t;
      rt.started = true;
      let start: StartResult | null;
      try { start = await opts.startSync(rt.sourceId, { intent, sliceSeconds: slice, first }); }
      catch (error) { start = null; await failure(rt, 'start_failed', error instanceof Error ? error.message : String(error), false); continue; }
      if ('busy' in start) { decide(rt.sourceId, 'defer_busy'); rt.lastStartAt = -Infinity; return; }
      if ('refused' in start) { await failure(rt, 'start_refused', start.refused, false); continue; }
      running.set(rt.sourceId, { id: start.jobId, sourceId: rt.sourceId, head: rt.head, lastCommit: rt.lastCommit, intent, markers });
      await transition(rt, { state: 'running', firstDue: 'keep' });
      decide(rt.sourceId, 'start', { detail: `${intent}${slice ? ` slice ${slice}s` : ''}` });
      log(`${rt.sourceId}: ${intent === 'freshness' ? `HEAD moved to ${short(rt.head)} (last synced ${short(rt.lastCommit)})` : `a ${intent} request is pending`}; started ${rt.kind === 'classic' ? 'classic' : 'managed'} sync job ${start.jobId}`);
    }
  };

  const step = async () => {
    const t = now();
    if (t - flagReadAt >= FLAG_EVERY_MS) {
      flagReadAt = t;
      const on = await guard('reading sync.on_commit', opts.readFlag, enabled);
      const ex = opts.readExcluded ? await guard('reading sync.on_commit.sources', opts.readExcluded, [...excluded]) : [];
      if (stopped) return;
      excluded = new Set(ex);
      if (on !== enabled) {
        enabled = on;
        listedAt = -Infinity;
        log(on ? `enabled (poll ${pollMs} ms, quiet window ${quietMs} ms)` : 'disabled');
      }
    }
    if (stopped) return;
    if (t - leaseAt >= heartbeatMs) { leaseAt = t; await ownership(); }
    if (t - listedAt >= LIST_EVERY_MS) { listedAt = t; await refreshSources(); }
    if (stopped) return;
    for (const rt of sources.values()) {
      const w = enabled && !excluded.has(rt.sourceId);
      if (w !== rt.watched) { rt.watched = w; if (!w) closeWatch(rt); else listedAt = -Infinity; }
    }
    const wasNudged = nudged;
    nudged = false;
    const heads = new Map<string, string | null>();
    if (!owner) {
      // A non-owner forwards a HEAD move it saw through its own watch; the owner drains the freshness marker.
      if (!wasNudged) return;
      for (const rt of sources.values()) {
        if (stopped || !rt.watched) continue;
        await observe(rt, heads);
        if (rt.head && rt.head !== rt.lastCommit && rt.head !== rt.forwarded) {
          rt.forwarded = rt.head;
          await guard(`forwarding a HEAD move of ${rt.sourceId}`, () => opts.store.forward(rt.sourceId, rt.head!), undefined);
          decide(rt.sourceId, 'forwarded', { detail: short(rt.head) });
        }
      }
      return;
    }
    for (const rt of sources.values()) {
      if (stopped) return;
      if (rt.watched) await observe(rt, heads);
    }
    if (wasNudged || firstPass || t - markersAt >= MARKER_SCAN_MS) {
      markersAt = t;
      firstPass = false;
      await readOwedMarkers(opts, guard, sources);
    }
    for (const job of [...running.values()]) {
      const st = opts.jobStatus(job.id);
      if (st && st.state !== 'done' && st.state !== 'error') continue;
      await settle(job, st);
    }
    if (stopped) return;
    await schedule();
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
    tick, nudge,
    get enabled() { return enabled; },
    get owner() { return owner; },
    get decisions() { return decisions; },
    snapshot: () => ({ resident: opts.resident, owner, enabled, skipped: [...skipped], sources: [...sources.values()].map(rt => snapshotSource(rt, now())) }),
    stop: async () => {
      if (!stopped) {
        stopped = true;
        (opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(interval);
        if (fireTimer !== null) clearTimer(fireTimer);
        if (nudgeTimer !== null) clearTimer(nudgeTimer);
        closeAllWatches();
      }
      // Hand the lease over before settling: a stop on a termination signal has a short cleanup deadline, and a step
      // still in flight re-checks the lease before any start (and claims nothing once stopped).
      const release = () => owner && leased ? guard('releasing the notifier lease', () => opts.store.releaseLease(opts.hostId, ownerId), undefined) : undefined;
      await release();
      if (inflight) {
        await settleWithin(inflight, STOP_SETTLE_MS);
        closeAllWatches();
        await release();
      }
    },
  };
}
