/**
 * Where eligibility's `unknown_writer_paths` comes from (readiness criterion 11). One interface, so the evidence source
 * can change without touching the status builder or the swap.
 *
 * The source shipped here is the one the plan describes (writer observations by every wrapped process): it counts
 * evidence that a write happened which no observation accounts for, read from the shadow directory alone:
 *
 *   - a reconcile pass that found follower misses (rows a write changed that no wrapped process published);
 *   - a pass that repaired rows while the follower's coverage watermark was invalid (repaired_rows > follower_misses):
 *     those writes cannot be told apart from an unseen writer;
 *   - a `writer_observation_failed` record: a process wrote and its observation was lost;
 *   - a torn or unreadable pass or fault record, or one missing its time or a count, or carrying a count of the wrong type: the
 *     evidence itself is incomplete, so it counts rather than reading as old or clean.
 *
 * Known limit, named rather than hidden: reconcile compares final rows, so a write from an unwrapped process that a
 * later wrapped write overwrites before any pass leaves no evidence here. A database-side source would close that gap;
 * it is a separate decision. Zero from this source therefore means "no evidence of an unseen writer", never proof.
 */
import { existsSync, readFileSync } from 'node:fs';
import { faultsPath } from './ledger.ts';
import { passesPath, type PassRecord } from './follow-status.ts';

export interface WriterCoverageSource {
  /** The source's name, for the report. */
  readonly name: string;
  /** Evidence items of a write with no observation, at or after `since`. */
  unknownPaths(since: Date): number;
}

const isTime = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A fault record the source can classify: a kind and a time. Anything else is incomplete evidence. */
const validFault = (r: { ts?: unknown; kind?: unknown }): boolean => typeof r.kind === 'string' && isTime(r.ts);
/** A pass record the source can classify: a finish time and both counts present as non-negative integers (a missing count is incomplete evidence, never zero). */
const validPass = (r: Partial<Record<keyof PassRecord, unknown>>): boolean => isTime(r.finished_at) && isCount(r.follower_misses) && isCount(r.repaired_rows);

function jsonLines<T>(path: string, valid: (row: T) => boolean): { rows: T[]; torn: number } {
  if (!existsSync(path)) return { rows: [], torn: 0 };
  let text: string;
  // silent-read-ok: not silent; a record file that cannot be read is incomplete evidence and counts as one torn record
  try { text = readFileSync(path, 'utf8'); } catch { return { rows: [], torn: 1 }; }
  const rows: T[] = [];
  let torn = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    // A line that parses to something other than an object (null, a number, an array) is as incomplete as a torn one.
    try {
      const row: unknown = JSON.parse(line);
      // A record that is not an object, or lacks the fields this source must read (a time, well-typed counts), is as incomplete
      // as a torn one: it cannot be shown to be old or clean, so it counts.
      if (row !== null && typeof row === 'object' && !Array.isArray(row) && valid(row as T)) rows.push(row as T); else torn++;
    } catch { torn++; }
  }
  return { rows, torn };
}

const after = (iso: unknown, since: number): boolean => typeof iso === 'string' && Date.parse(iso) >= since;

/** The plan-as-written source: process observations plus reconcile and failure evidence from `<dir>`. */
export function planAsWrittenSource(dir: string): WriterCoverageSource {
  return {
    name: 'process_observations',
    unknownPaths(since: Date): number {
      const t = since.getTime();
      const passes = jsonLines<PassRecord>(passesPath(dir), validPass);
      const faults = jsonLines<{ ts?: string; kind?: string }>(faultsPath(dir), validFault);
      let n = passes.torn + faults.torn;
      for (const p of passes.rows) {
        if (!after(p.finished_at, t)) continue;
        if ((p.follower_misses ?? 0) > 0 || (p.repaired_rows ?? 0) > (p.follower_misses ?? 0)) n++;
      }
      for (const f of faults.rows) if (f.kind === 'writer_observation_failed' && after(f.ts, t)) n++;
      return n;
    },
  };
}
