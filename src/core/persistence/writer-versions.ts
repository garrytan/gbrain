/** Writer-version stamps on persistence_requests (migration 178): observation of older writers, not prevention. */
import { VERSION } from '../../version.ts';
import { existingHostIdFor, hostIdFor } from './identity.ts';
import type { BrainEngine } from '../engine.ts';

/** Writers older than this may still delete database-only timeline rows during publication. */
export const WRITER_VERSION_FLOOR = '0.60.5.0';
export const UNSTAMPED_WRITER = 'unstamped (binary older than this release)';

/** Numeric comparison on all four components; null when either side is not a version. */
export function compareWriterVersions(a: string, b: string): number | null {
  const parse = (value: string) => {
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(value.trim());
    return match ? match.slice(1, 5).map(part => Number(part ?? 0)) : null;
  };
  const left = parse(a), right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
export function writerVersionLabel(version: string | null): string { return version ?? UNSTAMPED_WRITER; }
/** True for a missing stamp or a recorded version below `floor` (an unparsable version counts as below). */
export function writerVersionBelowFloor(version: string | null, floor = WRITER_VERSION_FLOOR): boolean {
  if (version === null) return true;
  const order = compareWriterVersions(version, floor);
  return order === null || order < 0;
}

/**
 * This binary's stamp. An unavailable host identity stamps no host rather than failing the write; `mint: false` (the
 * ingest log, written by commands that never register a writer) reads an existing identity and never creates one.
 * Every write path that stamps it also sets the segment-reader mark (migration v254), which only binaries that read
 * segmented pages write: a version string cannot tell a build with segment readers from a release of the same
 * version without them.
 */
export function writerStamp(opts: { mint?: boolean; engine?: object } = {}): { version: string; hostId: string | null } {
  let hostId: string | null = null;
  // `engine`: the host id that engine was opened with (engine-open.ts), else this process's file identity.
  try { hostId = opts.mint === false ? existingHostIdFor(opts.engine) : hostIdFor(opts.engine); } catch { /* unwritable or invalid identity: stamp the version only */ }
  return { version: VERSION, hostId };
}

export interface ObservedWriterVersion {
  role: 'admitter' | 'consumer'; host_id: string | null; principal: string; version: string | null; version_label: string; last_seen: string | null;
}
const labelled = <R extends { version: string | null }>(row: R) => ({ ...row, version_label: writerVersionLabel(row.version) });

/** Latest admitter and consumer version per host and principal across all retained requests, newest first. */
export async function listWriterVersions(engine: Pick<BrainEngine, 'listWriterVersions'>, limit = 50): Promise<ObservedWriterVersion[]> {
  return (await engine.listWriterVersions(limit)).map(row => labelled(row));
}

export interface RecentWriterVersion extends ObservedWriterVersion { requests: number; }

/**
 * Committed requests published in the last `days`, grouped per role, host and principal. Admitters count
 * only when admitted after the migration cutoff and consumers only when published after it, so a request
 * admitted before the cutoff and published after it is judged by its publication. An unstamped consumer's
 * host falls back to the worktree owner, the only host that can publish a filesystem request.
 */
export async function recentWriterVersions(engine: Pick<BrainEngine, 'recentWriterVersions'>, days = 7): Promise<RecentWriterVersion[]> {
  return (await engine.recentWriterVersions(days)).map(row => labelled(row));
}

/** A writer the segmented-storage gate saw in its window, by the evidence it left. */
export interface SegmentedGateWriter {
  /**
   * admitter / consumer: a managed write's admitting and publishing binary (persistence_requests); importer: a run
   * logged in ingest_log (gbrain import, sync, connectors, facts); resident: a live persistence consumer
   * (serve, sync, jobs, autopilot, mcp; Postgres only).
   */
  role: 'admitter' | 'consumer' | 'importer' | 'resident';
  host_id: string | null; principal: string; version: string | null; version_label: string;
  /** The rows carried the segment-reader mark (migration v254), which only binaries that read segmented pages write. */
  segment_reader: boolean;
  last_seen: string | null; requests: number;
  /** The earliest of the rows in the window (a resident: the earliest process start). */
  first_seen: string | null;
}

/**
 * Writers seen in the last `days` that keep segmented storage off (`floor`: page-body/writer-floor.ts
 * SEGMENTED_WRITER_FLOOR): evidence without the segment-reader mark (an older binary inserts NULL into a column it does
 * not know; rows from before v254 count too), or marked evidence stamped below `floor` (an unparsable or missing stamp
 * counts as below) from any role. Both are needed: a version string cannot tell a build with segment readers from a
 * build of the same version without them, so an unmarked writer blocks whatever its version, and a release below the
 * floor may write the mark (v0.60.290.0 does). Admitters count in any state, so a failed or still-queued request of an
 * older binary is seen as well. The ingest log is read in two arms, unmarked and marked rows, each over its
 * window on its partial index (ingest_log_unmarked_idx, v254; ingest_log_marked_idx, v259), so the read never
 * scans the whole log. Not seen: an older binary that writes neither a request nor an
 * ingest-log row (a single-page put on a brain without managed persistence, a run that dies before logging), and
 * one-shot readers and exporters, which write nothing.
 */
export async function segmentedGateWriters(engine: Pick<BrainEngine, 'readSegmentedGateEvidence'>, days: number, floor: string): Promise<SegmentedGateWriter[]> {
  return (await segmentedGateEvidence(engine, days)).filter(row => !row.segment_reader || writerVersionBelowFloor(row.version, floor));
}

/** Every writer the gate read in the last `days`, passing or not, grouped as `segmentedGateWriters` groups them. */
export async function segmentedGateEvidence(engine: Pick<BrainEngine, 'readSegmentedGateEvidence'>, days: number): Promise<SegmentedGateWriter[]> {
  return (await engine.readSegmentedGateEvidence(days)).map(row => labelled(row));
}
