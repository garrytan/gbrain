/**
 * `gbrain sources status` view of each managed connector source's state row:
 * upgrade recovery, account pin continuity, pending receipts and the last
 * run's counts. Never includes the pinned account or installation id.
 *
 * #5988: also each Git source's held files (`readGitHoldStatuses`, limited
 * in SQL to `sync.hold_cap`) and the blocked sync requests recent runs
 * converted in place, shown beside connector holds. Only `sources status` and `sources retry-held` merge
 * the two; `readAllSourceHolds`, `gbrain waiting` and doctor
 * `connector_held_items` stay connector-only.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { readManagedConnectorState, type ConnectorRunCounts, type UpgradeRecovery } from './connector-state.ts';
import { managedBrain, readAllSourceHolds } from '../connectors/item-holds-store.ts';
import type { ItemHoldRecord } from '../connectors/item-holds.ts';
import { fenceAutoRepairFor, gitHoldItem, readGitHoldListing, readSyncConversions, readSyncHoldPolicy, type GitHoldItem, type SyncConversion } from './sync-holds.ts';
import { holdLine } from '../../commands/sync-diagnostics.ts';

/** Fix wave 4: `sources status` lists this many held items per source, then "+N more". */
export const HELD_STATUS_LIMIT = 10;

export interface ConnectorSourceStatus {
  upgrade_recovery: UpgradeRecovery;
  resumed_from: string | null;
  account_pinned: boolean;
  continuity_unverified: boolean;
  pending: number;
  last_run: ConnectorRunCounts | null;
  /** Fix wave 4: every held item (the human view shows HELD_STATUS_LIMIT). */
  held: ItemHoldRecord[];
  /** Set when this source's hold state could not be read: coverage is unknown, not hold-free. */
  held_error?: string;
}

export async function readConnectorSourceStatuses(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds?: string[]): Promise<Map<string, ConnectorSourceStatus>> {
  const sources = await engine.executeRaw<{ id: string; incarnation: string }>(
    "SELECT id,incarnation::text FROM sources WHERE NOT archived AND config->>'kind' IN ('google','github') AND ($1::text[] IS NULL OR id=ANY($1::text[]))",
    [sourceIds ?? null]);
  const statuses = new Map<string, ConnectorSourceStatus>();
  for (const source of sources) {
    const state = await readManagedConnectorState(engine, source.id, source.incarnation);
    let held: ItemHoldRecord[] = [];
    let heldError: string | undefined;
    try {
      held = (await readAllSourceHolds(engine, { sourceIds: [source.id] }))[0]?.held ?? [];
    } catch (error) {
      heldError = (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 160) || 'unknown error';
    }
    statuses.set(source.id, { upgrade_recovery: state.upgrade_recovery, resumed_from: state.resumed_from, account_pinned: state.account !== null,
      continuity_unverified: state.continuity_unverified, pending: state.pending.length, last_run: state.last_run, held,
      ...(heldError ? { held_error: heldError } : {}) });
  }
  return statuses;
}

export function connectorStatusLines(sourceId: string, status: ConnectorSourceStatus): string[] {
  const lines: string[] = [];
  const run = status.last_run;
  lines.push(`  ${sourceId}: connector ${run ? `last run ${run.finished_at.slice(0, 19).replace('T', ' ')}: ${run.page_admissions} page admission(s), `
    + `${run.skipped_unchanged} skipped unchanged, ${run.pending} pending, ${run.checkpoint_admissions} checkpoint admission(s)`
    + `${run.stopped_on_wait_budget ? ', stopped on wait budget' : ''}${run.dropped_upstream ? `, ${run.dropped_upstream} dropped (deleted upstream)` : ''}` : 'has not run since the upgrade'}`);
  if (status.upgrade_recovery === 'resumed') {
    lines.push(`    resumed from pre-upgrade checkpoint of ${status.resumed_from}; content selection since then is unverified; to re-walk: gbrain sync --source ${sourceId} --reset-checkpoint`);
  } else if (status.upgrade_recovery === 'rewalking_once') {
    lines.push('    re-walking its window once after the upgrade (an expected admission spike, not #5470 churn)');
  }
  if (status.continuity_unverified) lines.push('    account pinned on its first post-upgrade run; continuity before the upgrade is unverified');
  if (status.held_error) lines.push(`    hold state unreadable: ${status.held_error}; coverage is unknown until it can be read`);
  else lines.push(...heldItemLines(sourceId, status.held));
  return lines;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : 'unknown');

/** Held items: up to HELD_STATUS_LIMIT per source, then "+N more", and the retry command once. */
export function heldItemLines(sourceId: string, held: ItemHoldRecord[]): string[] {
  if (!held.length) return [];
  const lines = [`    ${held.length} held item(s) (they do not block freshness; \`gbrain waiting\` reports partial coverage):`];
  for (const record of held.slice(0, HELD_STATUS_LIMIT)) {
    const label = [record.meta.sender, record.meta.subject ?? record.meta.title].filter(Boolean).join(' · ') || 'metadata unknown';
    lines.push(`      ${record.key}  ${label}  ${record.code} (${record.class})  first ${day(record.first_failed_at)}, last ${day(record.last_failed_at)}, `
      + `${record.attempts} attempt(s)${record.class === 'transient' ? `, next ${record.next_attempt_at ? day(record.next_attempt_at) : 'only on retry'}` : ''}`
      + `${record.legacy ? ' [carried from the pre-upgrade poison ledger]' : ''}`);
  }
  if (held.length > HELD_STATUS_LIMIT) lines.push(`      +${held.length - HELD_STATUS_LIMIT} more; --json lists all`);
  lines.push(`    re-attempt them on the next sync: gbrain sources retry-held ${sourceId}`);
  return lines;
}

/** `sources status <id>` naming no registered, unarchived source. */
export function statusSourceNotFound(sourceId: string) {
  return opError('not_found', `Source "${sourceId}" was not found (or is archived).`, 'List the registered sources, then run sources status with one of their ids.',
    { fix: readFix('Lists the registered sources and their ids, read-only.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
}

/** A Git source's held files: the outstanding count and up to `sync.hold_cap` of them in detail. */
export interface GitHoldStatus {
  count: number;
  items: GitHoldItem[];
  truncated?: true;
  /** Blocked sync requests a recent run converted in place (held or re-frozen) instead of staying blocked. */
  recent_conversions?: SyncConversion[];
  /** The command that runs the next sync of this source (managed brains sync with --no-pull). */
  sync_argv: string[];
}

/** How many converted requests `sources status` shows per source. */
export const CONVERSION_STATUS_LIMIT = 5;

/** Held files and recent conversions of each listed source that has any (sources with neither are absent). */
export async function readGitHoldStatuses(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig'>, sourceIds: string[]): Promise<Map<string, GitHoldStatus>> {
  const out = new Map<string, GitHoldStatus>();
  if (!sourceIds.length) return out;
  const { cap } = await readSyncHoldPolicy(engine);
  const [sources, conversions] = await Promise.all([readGitHoldListing(engine, sourceIds, cap), readSyncConversions(engine, sourceIds, CONVERSION_STATUS_LIMIT)]);
  if (!sources.length && !conversions.size) return out;
  const managed = await managedBrain(engine);
  const auto = await fenceAutoRepairFor(engine, sources.flatMap(source => source.holds));
  const counts = new Map(sources.map(source => [source.sourceId, source]));
  for (const sourceId of sourceIds) {
    const source = counts.get(sourceId), converted = conversions.get(sourceId);
    if (!source && !converted) continue;
    const items = (source?.holds ?? []).map(hold => gitHoldItem(hold, auto));
    out.set(sourceId, { count: source?.count ?? 0, items, ...((source?.count ?? 0) > items.length ? { truncated: true as const } : {}),
      ...(converted ? { recent_conversions: converted } : {}),
      sync_argv: ['gbrain', 'sync', '--source', sourceId, ...(managed ? ['--no-pull'] : [])] });
  }
  return out;
}

/** Held files: up to HELD_STATUS_LIMIT per source with each one's next step, then the re-screen and retry commands; then recent conversions. */
export function gitHoldStatusLines(sourceId: string, status: GitHoldStatus): string[] {
  const lines: string[] = [];
  if (status.count) {
    lines.push(`  ${sourceId}: ${status.count} held file(s): not imported, and they do not block sync. A page whose newer file is held keeps its last good revision and is read-only for put_page until the file is repaired.`);
    for (const item of status.items.slice(0, HELD_STATUS_LIMIT)) lines.push(`    ${holdLine(item, 'Held').trim()} Held since ${day(item.held_since)}.`);
    if (status.count > HELD_STATUS_LIMIT) lines.push(`      +${status.count - HELD_STATUS_LIMIT} more; --json lists ${status.truncated ? `the first ${status.items.length}` : 'all'}`);
    lines.push(`    Most holds re-screen on the next sync by themselves (the file changed or was deleted, or a newer gbrain can read it): ${status.sync_argv.join(' ')}`);
    lines.push(`    to re-screen the held files on that sync even if nothing changed: gbrain sources retry-held ${sourceId}`);
  }
  if (status.recent_conversions?.length) {
    lines.push(`  ${sourceId}: ${status.recent_conversions.length} blocked sync request(s) recently converted in place (the file was held or re-read instead of blocking the source):`);
    for (const c of status.recent_conversions) lines.push(`    ${c.request_id}${c.path ? ` (${c.path})` : ''}: ${c.outcome === 'held' ? 'held' : 're-read and resubmitted'}, ${day(c.converted_at)}, run ${c.run_id}`);
  }
  return lines;
}
