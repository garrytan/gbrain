/**
 * #5984 bulk sync, the sync side (ENG-A3/A4, DX-A5/A8).
 *
 * A draining managed sync freezes the frozen head entry plus the directly
 * following eligible entries, records them in the cursor as one `group`
 * (the head stays in `pending`), admits every member in one transaction and
 * waits for the group. Each member keeps its own request, receipt and
 * failure attribution; the consumer publishes the group in one transaction
 * (group-publish.ts) or, member by member, in order. The cursor advances only
 * over the committed prefix, so a failed or still-pending member is handled
 * exactly like a single pending entry.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError } from '../ops/contract.ts';
import { poolLongHoldCapacity, type BudgetPool } from '../pool-budget.ts';
import { admitWriteGroupInTransaction } from './journal.ts';
import { retryWriteAdmission } from './admission-retry.ts';
import { wouldWaiveEntry, type WaiverCursor, type WaiverEntry } from './sync-waivers.ts';
import type { WriteRequest } from './model.ts';
import { pipelined } from '../page-state/transactions.ts';
import type { SyncIntent } from './sync-prepare.ts';
import type { SyncAuthority } from './sync-authority.ts';

/** What sets a drain's lane ceiling: lanes off, the configured maximum, or the connection pool. */
export type LanesCap = 'disabled' | 'maximum' | 'pool';
export interface BulkSettings { enabled: boolean; reason: string | null; size: number; maxTxnMs: number;
  /** Whether `sync.bulk_max_txn_ms` (or its env) was set; an explicit budget only ever lowers the group budget. */
  maxTxnExplicit?: boolean;
  /** #5984 lanes: groups published at once (1 = one at a time), and why it is lower than asked when it is. */
  lanes?: number; lanesMax?: number; lanesReason?: string | null; lanesCap?: LanesCap;
  /** The drain's lane run (set by the drain when lanes > 1); lane groups carry it as `intent.lane`. */
  laneRun?: string }
export interface BulkReport { enabled: boolean; reason: string | null; groups: number; grouped_pages: number; largest_group: number }

/** Flag > env > config > default (on), as for the other sync knobs (DX-A8). */
export async function resolveBulkSettings(engine: BrainEngine, noBulk: boolean | undefined, lanesFlag?: number): Promise<BulkSettings> {
  const bulk = await resolveGrouping(engine, noBulk);
  return { ...bulk, ...await resolveLanes(engine, bulk, lanesFlag) };
}
async function resolveGrouping(engine: BrainEngine, noBulk: boolean | undefined): Promise<BulkSettings> {
  const env = process.env.GBRAIN_SYNC_BULK;
  const configured = await engine.getConfig('sync.bulk').catch(() => null);
  const size = await whole(engine, 'GBRAIN_SYNC_BULK_SIZE', 'sync.bulk_size', 16, 1, 64);
  const maxTxnMs = await whole(engine, 'GBRAIN_SYNC_BULK_MAX_TXN_MS', 'sync.bulk_max_txn_ms', 15_000, 100, 300_000);
  const maxTxnExplicit = !!process.env.GBRAIN_SYNC_BULK_MAX_TXN_MS || await engine.getConfig('sync.bulk_max_txn_ms').then(v => v != null).catch(() => false);
  const reason = noBulk ? 'disabled by --no-bulk' : env === '0' || env === 'false' ? 'disabled by GBRAIN_SYNC_BULK=0'
    : env === undefined || env === '' ? (configured === 'false' || configured === '0' ? 'disabled by config sync.bulk=false' : null) : null;
  if (reason) return { enabled: false, reason, size, maxTxnMs, maxTxnExplicit };
  if (engine.kind !== 'postgres') return { enabled: false, reason: 'PGLite publishes without network round trips; bulk applies to Postgres', size, maxTxnMs, maxTxnExplicit };
  return { enabled: true, reason: null, size, maxTxnMs, maxTxnExplicit };
}
/** The most groups a drain publishes at once: what `--lanes`, `sync.lanes` and `GBRAIN_SYNC_LANES` accept, and their default. */
export const MAX_SYNC_LANES = 16;
/**
 * #5984 lanes: `--lanes N` / `--no-lanes` > `GBRAIN_SYNC_LANES` > `sync.lanes` > 16 sets the maximum number of
 * groups published at once; the drain runs that many unless the connection pool holds fewer long transactions
 * (its long-hold capacity minus 3 for the sync loop, one foreground write and the consumer's control work).
 * `lanesMax` is the maximum asked for, `lanes` the ceiling in effect, and `lanesReason` why it is lower.
 * Lanes need bulk groups.
 */
async function resolveLanes(engine: BrainEngine, bulk: BulkSettings, flag: number | undefined): Promise<{ lanes: number; lanesMax: number; lanesReason: string | null; lanesCap: LanesCap }> {
  if (!bulk.enabled) return { lanes: 1, lanesMax: 1, lanesReason: `bulk groups are off (${bulk.reason})`, lanesCap: 'disabled' };
  if (flag !== undefined && (!Number.isInteger(flag) || flag < 1 || flag > MAX_SYNC_LANES)) throw new OperationError('invalid_params', `--lanes must be a whole number from 1 to ${MAX_SYNC_LANES}; got ${flag}.`,
    `Pass --lanes ${MAX_SYNC_LANES} (the default maximum), or --no-lanes to publish one group at a time.`);
  const asked = flag ?? await whole(engine, 'GBRAIN_SYNC_LANES', 'sync.lanes', MAX_SYNC_LANES, 1, MAX_SYNC_LANES);
  if (asked === 1) return { lanes: 1, lanesMax: 1, lanesReason: flag === 1 ? 'disabled by --no-lanes' : 'disabled by sync.lanes=1 (or GBRAIN_SYNC_LANES=1)', lanesCap: 'disabled' };
  const pool = (engine as BrainEngine & { sql?: BudgetPool }).sql;
  const capacity = pool ? poolLongHoldCapacity(pool) - 3 : 1;
  if (capacity >= asked) return { lanes: asked, lanesMax: asked, lanesReason: null, lanesCap: 'maximum' };
  return { lanes: Math.max(1, capacity), lanesMax: asked, lanesReason: `the connection pool holds ${capacity + 3} long transactions; set GBRAIN_POOL_SIZE=${asked + 4} for ${asked} lanes`, lanesCap: 'pool' };
}
async function whole(engine: BrainEngine, env: string, key: string, fallback: number, min: number, max: number): Promise<number> {
  const raw = process.env[env] ? Number(process.env[env]) : await engine.getConfig(key).then(v => v == null ? undefined : Number(v)).catch(() => undefined);
  if (raw === undefined) return fallback;
  if (!Number.isFinite(raw) || raw < min || raw > max) throw new OperationError('invalid_params', `${key} (or ${env}) must be a whole number from ${min} to ${max}; got ${raw}.`,
    `Run gbrain config set ${key} ${fallback} (or unset ${env}), then retry.`);
  return Math.floor(raw);
}

/** Entries a group may carry: plain page imports and deletes; renames, company plans and the checkpoint stay single. */
export function groupableIntent(intent: SyncIntent): boolean {
  return (intent.kind === 'managed_sync_import' || intent.kind === 'managed_sync_delete') && !intent.renameFrom && !intent.companyApproval;
}

/** Apply budgets for a lane group: normally, and while a foreground write on the worktree is queued or just committed. */
export const LANE_GROUP_BUDGET_MS = 5_000;
export const FOREGROUND_GROUP_BUDGET_MS = 2_000;
/**
 * Adaptive group size: as many members as fit the time budget at the last observed time per member, within
 * the configured maximum. The budget is, in order: the first group of a drain is small (2 pages) so its first
 * commit lands early; with lanes a group gets `LANE_GROUP_BUDGET_MS` of apply time (`FOREGROUND_GROUP_BUDGET_MS`
 * while a foreground write is queued or just committed), without lanes `sync.bulk_max_txn_ms`; an explicit
 * `sync.bulk_max_txn_ms` only ever lowers it. With lanes the time per member is the lanes' measured apply time
 * (transaction begin to the commit-turn wait), which does not grow with how long a group waited in the window;
 * without a measurement a group takes the configured size. Foreground writes queued behind a group wait at
 * most about this budget (ENG-A5).
 */
export function nextGroupSize(settings: BulkSettings, perMemberMs: number | null, opts: { first?: boolean; foreground?: boolean } = {}): number {
  if (opts.first) return Math.min(2, settings.size);
  const lanes = (settings.lanes ?? 1) > 1;
  let budget = lanes ? opts.foreground ? FOREGROUND_GROUP_BUDGET_MS : LANE_GROUP_BUDGET_MS : settings.maxTxnMs;
  if (lanes && settings.maxTxnExplicit) budget = Math.min(budget, settings.maxTxnMs);
  if (perMemberMs === null || perMemberMs <= 0) return lanes ? settings.size : Math.min(4, settings.size);
  return Math.max(1, Math.min(settings.size, Math.floor(budget / perMemberMs)));
}

/**
 * Followers for a group: frozen in manifest order after the head, four at a
 * time, stopping at the first entry that is not groupable, was overtaken by
 * another cursor, would be waived (the waiver handles it as a head) or is held (#5988).
 */
export async function freezeFollowers<P extends WaiverEntry & { rebound?: true }>(engine: BrainEngine, cursor: WaiverCursor & { entries: unknown[] }, config: GBrainConfig,
  count: number, freezeAt: (index: number) => Promise<P | null>): Promise<P[]> {
  const followers: P[] = [];
  for (let next = cursor.index + 1; followers.length < count && next < cursor.entries.length;) {
    const batch = Array.from({ length: Math.min(4, count - followers.length, cursor.entries.length - next) }, (_, i) => next + i);
    const frozen = await Promise.all(batch.map(async index => {
      const entry = await freezeAt(index);
      return !entry || entry.rebound || !groupableIntent(entry.intent) || await wouldWaiveEntry(engine, { ...cursor, index }, entry, config) ? null : entry;
    }));
    for (const entry of frozen) {
      if (!entry) return followers;
      followers.push(entry);
    }
    next += batch.length;
  }
  return followers;
}

/** Admits the group's members that have no request yet, in one transaction, while the cursor still holds this group. */
export async function admitGroup(engine: BrainEngine, members: WaiverEntry[], cursor: { sourceId: string; incarnation: string; binding: { worktree_id: string; topology_generation: string | number }; authority: SyncAuthority },
  cursorHolds: (tx: BrainEngine) => Promise<boolean>): Promise<WriteRequest[] | null> {
  const head = members[0]!;
  return retryWriteAdmission(head.requestId, remaining => engine.transaction(async tx => {
    // The settings go out with the admission's first burst of checks, ahead of them.
    const [, rows] = await pipelined(tx, [
      () => tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
        [`${Math.min(1000, remaining)}ms`, `${remaining}ms`]),
      () => admitWriteGroupInTransaction(tx, members.map(member => ({ requestId: member.requestId, operation: 'submit_job',
        sourceId: cursor.sourceId, sourceIncarnation: cursor.incarnation, slug: member.slug, pageId: member.pageId,
        worktreeId: cursor.binding.worktree_id, topologyGeneration: cursor.binding.topology_generation,
        principal: cursor.authority.writer.principal, authority: cursor.authority.writer, callerIntent: member.intent, intent: member.intent }))),
    ]) as [unknown, WriteRequest[]];
    if (!await cursorHolds(tx)) throw new GroupMoved();
    return rows;
  })).catch(error => { if (error instanceof GroupMoved) return null; throw error; });
}
class GroupMoved extends Error {}
