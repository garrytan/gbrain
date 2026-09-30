/**
 * #5567 materialized timeline markers.
 *
 * A timeline row that existed only in the database is written back into its
 * page as an ordinary bullet preceded by a standalone comment line:
 *
 *   <!-- gbrain:materialized v1 <12-hex tuple hash> -->
 *   - **2026-07-01** | legacy — Kickoff held before write-through
 *     detail
 *
 * The marker is provenance only. Timeline extractors skip it, remote bodies and
 * chunk text drop it, and a marker whose hash no longer matches the bullet
 * below it (a hand edit) marks nothing.
 */
import { createHash } from 'node:crypto';
import { sanitizeForJsonb } from './batch-rows.ts';

const MARKER_LINE = /^[ \t]*<!-- gbrain:materialized v1 ([0-9a-f]{12}) -->[ \t]*$/;
const MARKER_LINES = /^[ \t]*<!-- gbrain:materialized v1 [0-9a-f]{12} -->[ \t]*(?:\r?\n|$)/gm;

export interface TimelineTuple { date: string; source?: string | null; summary: string }

/** One normalization for prior-set membership, dedup, stored-row matching and marker hashes. */
export function timelineKey(entry: TimelineTuple): string {
  return JSON.stringify([entry.date.slice(0, 10), sanitizeForJsonb(entry.source ?? '').trim(),
    sanitizeForJsonb(entry.summary).replace(/\s+/g, ' ').trim()]);
}

/** Marker hash of an already-normalized `timelineKey`. */
export function timelineKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function timelineTupleHash(entry: TimelineTuple): string {
  return timelineKeyHash(timelineKey(entry));
}

export function materializedMarker(entry: TimelineTuple): string {
  return `<!-- gbrain:materialized v1 ${timelineTupleHash(entry)} -->`;
}

/** The hash a marker line carries, or null when the line is not a marker. */
export function materializedMarkerHash(line: string): string | null {
  return MARKER_LINE.exec(line)?.[1] ?? null;
}

export function isMaterializedMarkerLine(line: string): boolean {
  return MARKER_LINE.test(line);
}

/** Offset of the first marker line in `text`, or -1. */
export function firstMaterializedMarkerIndex(text: string): number {
  return text.search(/^[ \t]*<!-- gbrain:materialized v1 [0-9a-f]{12} -->[ \t]*$/m);
}

/** Remove whole marker lines so they never reach summaries, details or chunk text. */
export function stripMaterializedMarkers(text: string): string {
  return text.includes('gbrain:materialized') ? text.replace(MARKER_LINES, '') : text;
}
