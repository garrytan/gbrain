/**
 * #6712 PR 4b (design v3.2 §3.7): the pass row as the former cursor readers see it. A non-company source has no cursor
 * once its first pass ran, so doctor, the movement reader, the backlog, the blocked-run reader and `sources status`
 * read its pass row instead, through `passHealth`, the one rule `sync-pass-row.ts` keeps. Company sources and legacy
 * cursors keep their cursor arm in each reader.
 *
 * `nothing_pending` needs the checkout's HEAD: it is read with a hardened `rev-parse` of the source's checkout on this
 * host. A host with no checkout of the source (or one Git cannot read) gets `head: null`, and the reading then trusts
 * the converged target the pass recorded, as a cursor reader trusts a missing cursor.
 */
import { resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { hardenedGitSync } from '../hardened-git.ts';
import { managedSyncResumeArgs } from '../sync-reconcile.ts';
import { localHostId } from './identity.ts';
import { passHealth, readLivePassRows, type PassHealth, type PassRow } from './sync-pass-row.ts';

export interface PassReading { source_id: string; row: PassRow; head: string | null; health: PassHealth }

/** HEAD of each source's checkout on this host, or null when this host has none or Git cannot read it. */
export async function readCheckoutHeads(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds: readonly string[]): Promise<Map<string, string | null>> {
  const heads = new Map<string, string | null>(sourceIds.map(id => [id, null]));
  if (!sourceIds.length) return heads;
  const rows = await engine.executeRaw<{ source_id: string; local_path: string; relative_path: string }>(`SELECT b.source_id, h.local_path, b.relative_path
    FROM persistence_source_bindings b JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$2::uuid
    WHERE b.source_id=ANY($1::text[])`, [[...sourceIds], localHostId()]);
  for (const row of rows) {
    const out = hardenedGitSync(resolve(row.local_path, row.relative_path), ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { timeoutMs: 10_000, maxBytes: 4096 });
    heads.set(row.source_id, out.ok ? out.stdout.toString('utf8').trim() || null : null);
  }
  return heads;
}

/**
 * The pass rows of the sources' live incarnations with their health. `stalledMs`: an open pass whose row has not moved
 * for that long reads `open_stalled` (Infinity: never). `head: false` skips the HEAD read (no `nothing_pending` test).
 */
export async function readPassReadings(engine: Pick<BrainEngine, 'executeRaw'>, opts: { sourceIds?: readonly string[]; now?: number; stalledMs?: number; head?: boolean } = {}): Promise<PassReading[]> {
  const rows = await readLivePassRows(engine, opts.sourceIds);
  if (!rows.size) return [];
  const heads = opts.head === false ? new Map<string, string | null>() : await readCheckoutHeads(engine, [...rows.keys()]);
  return [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([sourceId, row]) => {
    const head = heads.get(sourceId) ?? null;
    return { source_id: sourceId, row, head, health: passHealth(row, { head, now: opts.now, stalledMs: opts.stalledMs ?? Infinity }) };
  });
}

/** A reason `passHealth` gives for a pass that keeps stopping (an open pass that stalled is the movement reader's call). */
export const passStuck = (health: PassHealth): boolean => health.reason === 'blocked' || health.reason === 'not_converged' || health.reason === 'settle_mismatch';

/** When the source started reading stuck: the pass row's `stuck_since`, else the newest pass's ending, else the row's last write. */
export function passStuckSince(row: PassRow): string {
  return row.value.obligations.stuck_since ?? row.value.telemetry.ended_at ?? row.updated_at;
}

/** The stop the newest pass names: its stop reason, else the health reason. */
export function passStopCode(reading: Pick<PassReading, 'row' | 'health'>): string {
  return reading.row.value.telemetry.stop_reason ?? reading.health.reason ?? reading.row.value.telemetry.outcome;
}

/** The plain sync that continues the source, carrying the open episode's inherited opt-outs (design §6). */
export function passResumeArgs(sourceId: string, row: PassRow): string[] {
  const inherited = row.value.obligations.episode?.inherited;
  return managedSyncResumeArgs({ sourceId, processingOptions: inherited ? { noEmbed: inherited.noEmbed, noExtract: inherited.noExtract, noSchemaPack: inherited.noSchemaPack } : null });
}
