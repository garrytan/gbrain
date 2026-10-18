/**
 * #6696 (A4): pushed capacity warnings, from a per-engine snapshot that one
 * light forecast (capacity-forecast.ts) fills at most once a minute (the
 * #6650 `cachedTerminalSummary` pattern); a write never computes a forecast.
 *
 * `write_capacity_low` (notice kind `info`, so `gbrain notices mute
 * write_capacity_low` mutes it on receipts) names every cumulative cap at or
 * past 80% or out within `persistence.capacity.warn_days`. Write and sync
 * receipts carry it at most once an hour per process per scope and resource;
 * `gbrain sync status`, doctor and autopilot cycle output carry it every time.
 * `write_capacity_backpressure` (kind `degraded`, never muted) fires once
 * when a scope passes the background pause line (A5), again only after it
 * clears and passes it anew.
 *
 * #6803 C4: the shared fetch carries its own server-side bound
 * (CAPACITY_FETCH_BOUND_MS) and a timed-out fetch is never cached, so the next
 * caller fetches again. Read paths that must answer quickly (`gbrain sync
 * status`, write and sync receipts) wait on the shared fetch only until one
 * absolute deadline (`capacitySnapshotWithin`, CAPACITY_READ_WAIT_MS) and get
 * `unknown` for that call alone. An unknown snapshot yields no notices and
 * leaves the throttle and pause-transition state as it was, so a pause that
 * continues across a slow read is neither cleared nor announced again.
 */
import type { Notice } from '../agent-output.ts';
import { principalKey, type Principal, type SqlEngine } from './model.ts';
import { BACKGROUND_PRODUCERS, readBackgroundPauseShare } from './admission-origin.ts';
import { readCapacityForecast } from './capacity-forecast.ts';
import { CAPACITY_VERIFY } from './capacity-verify.ts';
import { deadlineBoundEngine, deadlineFailure, engineCacheKey, withStatementDeadline } from '../statement-deadline.ts';

export const CAPACITY_SNAPSHOT_TTL_MS = 60_000;
export const CAPACITY_NOTICE_INTERVAL_MS = 60 * 60_000;
/** Server-side bound of the shared snapshot fetch. */
export const CAPACITY_FETCH_BOUND_MS = 10_000;
/** How long a status read or receipt waits for the shared fetch. */
export const CAPACITY_READ_WAIT_MS = 1_500;

export interface CapacityAttention {
  scope: string; resource: 'lifetime_ids' | 'terminal_bytes'; used: number; limit: number; pct: number;
  days_to_exhaustion: number | null; config_key: string; recommended_limit: number; command: string;
}
export interface CapacitySnapshot {
  /** Every cumulative cap of every scope (the /metrics gauges). */
  rows: CapacityAttention[];
  /** Caps at or past the warn percentage or out within the warn days. */
  low: CapacityAttention[];
  /** Caps past the background pause line: background producers refuse there. */
  paused: CapacityAttention[];
  pause_pct: number;
  status: 'ok' | 'unknown';
}

const snapshots = new WeakMap<object, { at: number; value: Promise<CapacitySnapshot> }>();
const lowShownAt = new Map<string, number>();
const pausedShown = new Set<string>();

const UNKNOWN: CapacitySnapshot = { rows: [], low: [], paused: [], pause_pct: 0, status: 'unknown' };

/**
 * The snapshot for `engine`, shared by every caller within CAPACITY_SNAPSHOT_TTL_MS (in flight included), keyed on the real
 * engine behind any deadline wrapper. The fetch is bounded at CAPACITY_FETCH_BOUND_MS; a fetch that timed out is dropped from
 * the cache (the next caller fetches again), any other failed read is cached as `unknown`.
 */
export function cachedCapacitySnapshot(engine: SqlEngine, now: number = Date.now()): Promise<CapacitySnapshot> {
  const cacheKey = engineCacheKey(engine);
  const hit = snapshots.get(cacheKey);
  if (hit && now - hit.at < CAPACITY_SNAPSHOT_TTL_MS) return hit.value;
  const bounded = deadlineBoundEngine(engine);
  const startedAt = Date.now();
  const fetch = withStatementDeadline({ startedAt, deadlineAt: startedAt + CAPACITY_FETCH_BOUND_MS, expired: false },
    () => Promise.all([readCapacityForecast(bounded, { light: true }), readBackgroundPauseShare(bounded)]));
  const value: Promise<CapacitySnapshot> = fetch.then(([forecast, share]): CapacitySnapshot => {
    const attention = (row: typeof forecast.rows[number]): CapacityAttention => ({ scope: row.scope, resource: row.resource, used: row.used, limit: row.limit,
      pct: row.pct, days_to_exhaustion: row.days_to_exhaustion, config_key: row.config_key, recommended_limit: row.recommended_limit,
      command: `gbrain config set ${row.config_key} ${row.recommended_limit}` });
    return { rows: forecast.rows.map(attention), low: forecast.rows.filter(row => row.status !== 'ok').map(attention),
      paused: forecast.rows.filter(row => row.used >= Math.floor(row.limit * share)).map(attention), pause_pct: Math.round(share * 100), status: 'ok' };
  }).catch((error: unknown): CapacitySnapshot => {
    if (deadlineFailure(error) && snapshots.get(cacheKey)?.value === value) snapshots.delete(cacheKey);
    return UNKNOWN;
  });
  snapshots.set(cacheKey, { at: now, value });
  return value;
}

/** The shared snapshot, or `unknown` for this call alone when it is not ready by `deadlineAt` (the fetch keeps going for later callers). */
export async function capacitySnapshotWithin(engine: SqlEngine, deadlineAt: number, now: number = Date.now()): Promise<CapacitySnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<CapacitySnapshot>((resolve) => { timer = setTimeout(() => resolve(UNKNOWN), Math.max(0, deadlineAt - Date.now())); });
  try {
    return await Promise.race([cachedCapacitySnapshot(engine, now), late]);
  } finally {
    clearTimeout(timer);
  }
}

const key = (row: CapacityAttention) => `${row.scope}|${row.resource}`;
const describe = (row: CapacityAttention) => `${row.scope} ${row.resource} ${row.used}/${row.limit} (${row.pct}%`
  + `${row.days_to_exhaustion !== null ? `, about ${row.days_to_exhaustion} day(s) left` : ''})`;
const VERIFY = CAPACITY_VERIFY;

function lowNotice(rows: CapacityAttention[]): Notice {
  const [first] = rows;
  return { code: 'write_capacity_low', kind: 'info',
    why: `Write capacity is running low: ${rows.map(describe).join('; ')}. Writes still work; admission refuses at the cap. `
      + `The brain host raises it with ${rows.map(row => row.command).join('; ')} (each covers about one more year; reversible).`,
    fix: { argv: ['gbrain', 'config', 'set', first!.config_key, String(first!.recommended_limit)], consent: [], actor: 'host_admin', requires_exclusive: false,
      why: 'Raises the cap that runs out first to a value that covers about one more year; undo with gbrain config unset.', verify: VERIFY,
      docs: 'docs/guides/concurrent-writes.md#quota-near-exhaustion' } };
}

function pausedNotice(rows: CapacityAttention[], pausePct: number): Notice {
  const [first] = rows;
  return { code: 'write_capacity_backpressure', kind: 'degraded',
    why: `Background writes are paused: ${rows.map(describe).join('; ')} passed the ${pausePct}% pause line (persistence.capacity.background_pause_pct). `
      + `Paused: ${BACKGROUND_PRODUCERS.join(', ')}. Interactive writes keep the rest of the cap.`,
    fix: { argv: ['gbrain', 'config', 'set', first!.config_key, String(first!.recommended_limit)], consent: [], actor: 'host_admin', requires_exclusive: false,
      why: 'Moves the pause line by raising the cap; request ids never free, receipt bytes free as receipts compact.', verify: VERIFY,
      docs: 'docs/guides/write-refusals.md#write_capacity_backpressure' } };
}

/**
 * The capacity notices one output carries. `throttle` (write and sync
 * receipts) shows `write_capacity_low` at most once an hour per process per
 * scope and resource; unthrottled (sync status, doctor, cycle output) shows it
 * whenever a cap needs attention. The pause notice fires on each transition
 * into the pause, in either mode. `scopes` limits both to the scopes a
 * caller may see (a remote client: the brain and its own principal).
 * `deadlineAt` bounds the wait for the shared snapshot (`capacitySnapshotWithin`); `snapshot` reuses one the caller
 * already read. An unknown snapshot yields no notices and changes no throttle or pause-transition state.
 */
export async function capacityNotices(engine: SqlEngine, opts: { throttle: boolean; now?: number; scopes?: string[]; deadlineAt?: number; snapshot?: CapacitySnapshot } = { throttle: true }): Promise<Notice[]> {
  const now = opts.now ?? Date.now();
  const snapshot = opts.snapshot ?? (opts.deadlineAt !== undefined ? await capacitySnapshotWithin(engine, opts.deadlineAt, now) : await cachedCapacitySnapshot(engine, now));
  if (snapshot.status === 'unknown') return [];
  const visible = (row: CapacityAttention) => !opts.scopes || opts.scopes.includes(row.scope);
  const notices: Notice[] = [];
  const candidates = snapshot.low.filter(visible);
  const low = opts.throttle ? candidates.filter(row => now - (lowShownAt.get(key(row)) ?? -Infinity) >= CAPACITY_NOTICE_INTERVAL_MS) : candidates;
  if (low.length) {
    if (opts.throttle) for (const row of low) lowShownAt.set(key(row), now);
    notices.push(lowNotice(low));
  }
  const pausedNow = new Set(snapshot.paused.map(key));
  for (const shown of pausedShown) if (!pausedNow.has(shown)) pausedShown.delete(shown);
  const started = snapshot.paused.filter(row => visible(row) && !pausedShown.has(key(row)));
  if (started.length) {
    for (const row of started) pausedShown.add(key(row));
    notices.push(pausedNotice(started, snapshot.pause_pct));
  }
  return notices;
}

export function __resetCapacityNoticesForTests(): void {
  lowShownAt.clear();
  pausedShown.clear();
}

/** #6696 (A4): a write receipt's capacity notices, throttled hourly per scope; a remote caller sees only the brain and its own principal. Never throws. */
export async function writeReceiptCapacityNotices(engine: SqlEngine, ctx: { remote?: boolean; auth?: { principal?: Principal } }): Promise<Notice[]> {
  const scopes = ctx.remote === false ? undefined : ['brain', ...(ctx.auth?.principal ? [principalKey(ctx.auth.principal)] : [])];
  return capacityNotices(engine, { throttle: true, scopes, deadlineAt: Date.now() + CAPACITY_READ_WAIT_MS }).catch(() => []);
}
