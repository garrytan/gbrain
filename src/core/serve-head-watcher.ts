/**
 * #6858 ask 6 (option C), reworked by GBRA-133 PR 2a: the serve's adapter over the commit notifier
 * (core in ./commit-notifier.ts, production seams in ./notifier/resident.ts).
 *
 * `gbrain serve` (stdio, serve.ts installResidentTickers) and `gbrain serve --http` (serve-http.ts runServeHttp) start
 * the host's notifier through `startServeHeadWatcher` and await `stop()` before the delegated sync runner shuts down
 * and the engine disconnects. With `sync.on_commit` on it watches every source this host syncs (managed sources whose
 * worktree it owns and, since 2a, classic sources it last synced), starts a sync on the leading edge of a quiet HEAD
 * move (`GBRAIN_NOTIFIER_QUIET_MS`, alias GBRAIN_SERVE_HEAD_DEBOUNCE_MS, default 400 ms, replaces the fixed 3 s
 * debounce) and keeps a source due across failed or refused starts, error and blocked runs and resumable stops (the
 * lost wake of #6858's first cut). Wanted markers (sync trigger, sync_nudge, the webhook) drain with the flag off too.
 * The option names below are the seams the serve tests drive; every one defaults to production.
 */
import type { BrainEngine } from './engine.ts';
import {
  FLAG_EVERY_MS, LIST_EVERY_MS, POLL_MS_DEFAULT, QUIET_MS_DEFAULT, STOP_SETTLE_MS as NOTIFIER_STOP_SETTLE_MS,
  type CommitNotifier, type JobStatus, type NotifierStore, type StartRequest, type StartResult,
} from './commit-notifier.ts';
import { startResidentNotifier } from './notifier/resident.ts';

export const HEAD_POLL_MS_DEFAULT = POLL_MS_DEFAULT;
export const HEAD_DEBOUNCE_MS_DEFAULT = QUIET_MS_DEFAULT;
export const HEAD_FLAG_EVERY_MS = FLAG_EVERY_MS;
export const HEAD_LIST_EVERY_MS = LIST_EVERY_MS;
/** How long `stop()` waits for an in-flight step before it resolves anyway (inside the stdio serve's 5 s cleanup deadline). */
export const STOP_SETTLE_MS = NOTIFIER_STOP_SETTLE_MS;

export interface WatchedSource { sourceId: string; root: string; gitDir: string | null; commonDir?: string | null; lastCommit: string | null; kind?: 'managed' | 'classic' }
export type OnCommitStart = StartResult;
export type OnCommitJobStatus = JobStatus;

export interface ServeHeadWatcherOptions {
  log: (line: string) => void;
  resident?: 'serve' | 'serve-http';
  pollMs?: number;
  /** The trailing quiet window (GBRAIN_NOTIFIER_QUIET_MS); the name is kept from the debounce it replaced. */
  debounceMs?: number;
  heartbeatMs?: number;
  env?: Record<string, string | undefined>;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  hostId?: string;
  store?: NotifierStore;
  readFlag?: () => Promise<boolean>;
  readExcluded?: () => Promise<string[]>;
  listSources?: () => Promise<WatchedSource[]>;
  /** The source's last synced commit (`sources.last_commit`), re-read right before a start. */
  lastCommit?: (sourceId: string) => Promise<string | null>;
  revParse?: (root: string) => Promise<string>;
  quiet?: (source: WatchedSource) => boolean;
  syncRunning?: () => boolean | Promise<boolean>;
  drainHeld?: (sourceId: string) => Promise<boolean>;
  startSync?: (sourceId: string, req: StartRequest) => Promise<OnCommitStart>;
  jobStatus?: (jobId: string) => OnCommitJobStatus | null;
  watch?: (gitDir: string, onChange: () => void) => (() => void) | null;
}

/** `stop()` stops polling at once and resolves when the in-flight step has settled (at most STOP_SETTLE_MS). */
export type ServeHeadWatcher = Pick<CommitNotifier, 'tick' | 'stop' | 'enabled' | 'nudge' | 'owner' | 'decisions' | 'snapshot'>;

const INERT: ServeHeadWatcher = { tick: async () => {}, stop: async () => {}, nudge: () => {}, enabled: false, owner: false, decisions: [],
  snapshot: () => ({ resident: 'serve', owner: false, enabled: false, sources: [], skipped: [] }) };

export function startServeHeadWatcher(engine: BrainEngine, opts: ServeHeadWatcherOptions): ServeHeadWatcher {
  const { debounceMs, watch, listSources, resident, ...rest } = opts;
  return startResidentNotifier(engine, {
    ...rest,
    resident: resident ?? 'serve',
    ...(debounceMs !== undefined ? { quietMs: debounceMs } : {}),
    ...(listSources ? { listSources } : {}),
    ...(watch ? { watch: (s: WatchedSource, onChange: () => void) => s.gitDir ? watch(s.gitDir, onChange) : null } : {}),
  }) ?? INERT;
}
