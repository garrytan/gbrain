/**
 * Which segmented-storage gate blockers are still live (page-body/limits.ts `segmentedWriterBlockers`). A blocker is
 * superseded when it is only this host's own write from before it upgraded: this build is at or above
 * SEGMENTED_WRITER_FLOOR, the blocker is this host's, it is not an older resident process still renewing its heartbeat
 * (CONSUMER_PURGE_MS), and this host has since made the same kind of write (role and principal: an ingest source type, a
 * resident kind, a managed principal) with a build that passes the gate, every write of the blocker coming before the
 * first of those. Anything else may be a second older gbrain (another host, a cron job, an npx run, a pinned install,
 * an older serve still running here) and stays live. Doctor `segmented_storage` reports a hold with no live blocker as
 * information and keeps its upgrade warning otherwise; the segmented withdrawal mirror (segmented-mirror-gate.ts) holds
 * only on live blockers. The pages switch itself still counts every blocker.
 */
import { VERSION } from '../../version.ts';
import { SEGMENTED_WRITER_WINDOW_DAYS } from '../page-body/limits.ts';
import type { SqlEngine } from './model.ts';
import { compareWriterVersions, segmentedGateEvidence, writerVersionBelowFloor, type SegmentedGateWriter } from './writer-versions.ts';

/** `blockers` without those that are `self`'s superseded pre-upgrade writes; reads the gate evidence only when one could be. */
export async function liveSegmentedBlockers(engine: SqlEngine, blockers: SegmentedGateWriter[], self: string | null): Promise<SegmentedGateWriter[]> {
  if (!blockers.length || self === null) return blockers;
  const [{ SEGMENTED_WRITER_FLOOR }, { CONSUMER_PURGE_MS }] = await Promise.all([import('../page-body/writer-floor.ts'), import('./consumer-heartbeat.ts')]);
  if ((compareWriterVersions(VERSION, SEGMENTED_WRITER_FLOOR) ?? -1) < 0) return blockers;
  const candidates = blockers.filter(row => row.host_id === self && row.last_seen !== null
    && (row.role !== 'resident' || Date.now() - Date.parse(row.last_seen) > CONSUMER_PURGE_MS));
  if (!candidates.length) return blockers;
  const key = (row: SegmentedGateWriter) => `${row.role}\0${row.principal}`;
  const passedFirst = new Map<string, number>();
  for (const row of await segmentedGateEvidence(engine, SEGMENTED_WRITER_WINDOW_DAYS)) {
    if (row.host_id !== self || !row.segment_reader || !row.first_seen || writerVersionBelowFloor(row.version, SEGMENTED_WRITER_FLOOR)) continue;
    passedFirst.set(key(row), Math.min(passedFirst.get(key(row)) ?? Infinity, Date.parse(row.first_seen)));
  }
  const superseded = new Set(candidates.filter(row => Date.parse(row.last_seen!) < (passedFirst.get(key(row)) ?? -Infinity)));
  return blockers.filter(row => !superseded.has(row));
}
