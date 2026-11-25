/**
 * #6712 PR 2 (L4): after a managed sync, count the source's ghost pages (live pages whose canonical file is gone) with the
 * one classifier, `scanGhostSource` (ghost-pages.ts), and name the read-only `gbrain repair ghost-pages` preview. Sync never
 * deletes or tombstones such a page on its own: a file missing from the checkout but not deleted in Git is either an edit
 * in progress or a mistake, and only a person decides which. A path that holds a sync hold (a held deletion) is the hold's
 * to settle and is not counted. Bounded by the scan's own limits; off the owner host, or when the scan cannot tell, there
 * is no count. Best effort: a failed scan never fails the sync.
 *
 * GBRA-133 2b.2: the scan reads every live page of the source (365 ms at 100k pages), and ghosts are outside the git
 * delta, so it keeps its full walk but no longer runs inside the sync. `countSyncGhosts` answers from the source's last
 * scan (one op_checkpoints row, op `sync-ghost-report`, fingerprint the source id) and, at most once per
 * `GBRAIN_SYNC_GHOST_INTERVAL_MS` (default 5 minutes) per source across processes (an atomic claim on that row), starts
 * the scan in the background, and only once a sync has landed since the last claim (`sources.last_sync_at`, which every
 * successful sync stamps): a cancelled or never-landed sync writes nothing. The sync returns, and releases its drain lease and the serve's single-flight slot, without
 * waiting; the next sync reports what the scan found. A CLI exit waits for an in-flight scan within the background-work
 * drain budget; an engine disconnect aborts it before the next statement. Every decision is recorded
 * (`syncGhostDecisions`) for tests.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { registerBackgroundWorkDrainer } from '../background-work.ts';
import { scanGhostSource } from '../ghost-pages.ts';
import { GIT_HOLD_OP, gitHoldFingerprint } from './sync-holds.ts';
import { syncRows } from '../engine-sql/managed-sync-store.ts';

/** Full checks per sync: the count is exact up to this many candidates, `truncated` past it. */
export const SYNC_GHOST_CHECK_LIMIT = 50;
export const SYNC_GHOST_REPORT_OP = 'sync-ghost-report';
export const SYNC_GHOST_INTERVAL_MS_DEFAULT = 300_000;

export interface SyncGhostPages { count: number; truncated: boolean; samples: string[]; fix: Action; observed_at?: string }

export type SyncGhostDecision = { source_id: string; decision: 'scan_started' | 'rate_limited' | 'scan_in_flight' | 'scan_done' | 'scan_failed' | 'scan_aborted'; error?: string };
/** The last decisions of this process, oldest first (bounded). */
export const syncGhostDecisions: SyncGhostDecision[] = [];

function decide(source_id: string, decision: SyncGhostDecision['decision'], error?: unknown): void {
  syncGhostDecisions.push({ source_id, decision, ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }) });
  if (syncGhostDecisions.length > 200) syncGhostDecisions.splice(0, syncGhostDecisions.length - 200);
}

function scanIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GBRAIN_SYNC_GHOST_INTERVAL_MS;
  const value = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : SYNC_GHOST_INTERVAL_MS_DEFAULT;
}

interface EngineScans { inFlight: Map<string, Promise<void>>; controller: AbortController; unregister: () => void }
const scans = new Map<BrainEngine, EngineScans>();

/** The ghost report from the source's last scan; starts a background scan when the source's interval has passed. */
export async function countSyncGhosts(engine: BrainEngine, sourceId: string): Promise<SyncGhostPages | null> {
  const inFlight = scans.get(engine)?.inFlight.has(sourceId) === true;
  const [row] = await syncRows<{ report: SyncGhostPages[] | null; claimed: boolean }>(engine, inFlight ? 'ghost_report_read' : 'ghost_report_claim',
  inFlight ? [SYNC_GHOST_REPORT_OP, sourceId] : [SYNC_GHOST_REPORT_OP, sourceId, scanIntervalMs()]).catch(() => []);
  if (inFlight) decide(sourceId, 'scan_in_flight');
  else if (row?.claimed) startScan(engine, sourceId);
  else decide(sourceId, 'rate_limited');
  const report = typeof row?.report === 'string' ? JSON.parse(row.report) as SyncGhostPages[] : row?.report;
  return report?.[0] ?? null;
}

/** Resolves when every background scan of `engine` (default: every engine) has settled. */
export async function settleSyncGhostScans(engine?: BrainEngine): Promise<void> {
  const states = engine ? [scans.get(engine)].filter((state): state is EngineScans => !!state) : [...scans.values()];
  await Promise.all(states.flatMap(state => [...state.inFlight.values()]));
}

function startScan(engine: BrainEngine, sourceId: string): void {
  let state = scans.get(engine);
  if (!state) {
    const created: EngineScans = { inFlight: new Map(), controller: new AbortController(), unregister: () => {} };
    created.unregister = engine.registerBeforeDisconnect(async () => {
      created.controller.abort(new Error('engine disconnecting'));
      await Promise.all(created.inFlight.values());
      created.unregister();
      if (scans.get(engine) === created) scans.delete(engine);
    });
    scans.set(engine, created);
    state = created;
  }
  const owned = state;
  decide(sourceId, 'scan_started');
  const run = (async () => {
    try {
      const report = await scanReport(engine, sourceId, owned.controller.signal);
      owned.controller.signal.throwIfAborted();
      await syncRows(engine, 'ghost_report_write', [SYNC_GHOST_REPORT_OP, sourceId, JSON.stringify(report ? [report] : [])]);
      decide(sourceId, 'scan_done');
    } catch (error) {
      if (owned.controller.signal.aborted) decide(sourceId, 'scan_aborted');
      else decide(sourceId, 'scan_failed', error);
    } finally {
      owned.inFlight.delete(sourceId);
    }
  })();
  owned.inFlight.set(sourceId, run);
}

/** One full scan, held paths left out; null when nothing is to report or the scan could not tell. */
async function scanReport(engine: BrainEngine, sourceId: string, signal: AbortSignal): Promise<SyncGhostPages | null> {
  const scan = await scanGhostSource(engine, sourceId, { candidateLimit: SYNC_GHOST_CHECK_LIMIT, signal });
  if (scan.status !== 'known' || (!scan.ghosts.length && !scan.truncated)) return null;
  const incarnation = scan.owner?.source_incarnation ?? '';
  const held = new Set(scan.ghosts.length ? (await syncRows<{ path: string }>(engine, 'ghost_held_paths',
    [GIT_HOLD_OP, scan.ghosts.map(ghost => gitHoldFingerprint(sourceId, incarnation, ghost.path))])).map(row => row.path) : []);
  const ghosts = scan.ghosts.filter(ghost => !held.has(ghost.path));
  if (!ghosts.length && !scan.truncated) return null;
  return { count: ghosts.length, truncated: scan.truncated, samples: ghosts.slice(0, 5).map(ghost => ghost.slug), observed_at: new Date().toISOString(),
    fix: { argv: ['gbrain', 'repair', 'ghost-pages', '--source', sourceId], consent: [], actor: 'agent', requires_exclusive: false, docs: 'docs/guides/repair.md#ghost-pages',
      why: `Lists the live pages of ${sourceId} whose canonical file is missing and writes nothing. Sync never deletes them: restore a file and sync to keep its page, `
        + 'or apply the printed removal only after the user agrees.',
      verify: { argv: ['gbrain', 'sources', 'status', sourceId, '--json'] } } };
}

registerBackgroundWorkDrainer({
  name: 'sync-ghost-scans',
  order: 45,
  async drain(timeoutMs, mode): Promise<{ unfinished: number }> {
    if (mode === 'disconnect') return { unfinished: 0 };
    const pending = [...scans.values()].flatMap(state => [...state.inFlight.values()]);
    if (!pending.length) return { unfinished: 0 };
    await Promise.race([Promise.all(pending), new Promise<void>(resolve => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
    return { unfinished: [...scans.values()].reduce((sum, state) => sum + state.inFlight.size, 0) };
  },
});
