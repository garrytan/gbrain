/**
 * MEMORY_VERBS v1 — per-verb usage sidecar (E4 observability).
 *
 * One JSONL line per verb call, written from the DISPATCH layer (so
 * param-validation failures are counted too — c11), fire-and-forget.
 * LOCAL ONLY: this file never leaves the machine and is never uploaded —
 * it is observability, never source of truth. Stats tolerate loss.
 *
 * Concurrency: append-only, one line-buffered write() per event (<4KB ⇒
 * atomic under POSIX O_APPEND; serve + jobs worker interleave safely at line
 * granularity; best-effort on Windows, documented). Rotation at 10MB is
 * lock-free best-effort — a concurrent double-rotate can drop lines, which
 * is acceptable for stats.
 *
 * Path: ~/.gbrain/integrations/memory-verbs/usage.jsonl via gbrainPath, so
 * GBRAIN_HOME is honored and brain_id (the resolved gbrain home) is a true
 * per-brain disambiguator [c11/m1].
 */

import { appendFile, mkdir, rename, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gbrainPath } from '../config.ts';

const ROTATE_BYTES = 10 * 1024 * 1024;

export interface VerbUsageEvent {
  ts: string;
  verb: string;
  surface: 'verbs' | 'starter' | 'full';
  remote: boolean;
  ok: boolean;
  latency_ms: number;
  brain_id: string;
  source_id: string;
  budget_dropped?: number;
  entity_found?: boolean;
  /** `remember` outcome (inserted|duplicate|superseded) — additive, stamped
   * by dispatch. Counts ALL MCP callers of the verb, ambient or explicit —
   * doctor's memory_writeback check labels it exactly that way (OV-A11):
   * a per-call ambient/explicit distinction does not exist on the wire. */
  remember_status?: string;
  /** `entity` / `context_pack` with enrolled record types: rows that listed records, listed none, or were unavailable. */
  records_firing?: RecordsFiring;
}

export interface RecordsFiring { listed: number; zero: number; unavailable: number }

/**
 * The firing counter for a verb result (usage log): every row that carried
 * the record view, split into rows that listed records, rows that listed none
 * and rows marked unavailable. Null when no row carried it (nothing enrolled).
 */
export function recordsFiring(result: unknown): RecordsFiring | null {
  type Row = { found?: unknown; records?: unknown; references_unavailable?: unknown; siblings?: Row[]; sibling_records?: Row[];
    identity_siblings?: { pages?: Row[] } };
  const r = result as { results?: Row[]; cards?: Row[]; card?: Row } | null;
  const rows: Row[] = [];
  for (const x of r?.results ?? []) if (x?.found) rows.push(x, ...(x.siblings ?? []));
  for (const c of r?.cards ?? []) rows.push(c, ...(c.sibling_records ?? []));
  if (r?.card) rows.push(r.card, ...(r.card.identity_siblings?.pages ?? []));
  const counted = rows.filter(x => Array.isArray(x.records) || x.references_unavailable);
  if (!counted.length) return null;
  const listed = (x: Row) => Array.isArray(x.records) && x.records.length > 0;
  return {
    listed: counted.filter(listed).length,
    zero: counted.filter(x => Array.isArray(x.records) && x.records.length === 0).length,
    unavailable: counted.filter(x => x.references_unavailable).length,
  };
}

let _pathOverride: string | null = null;

/**
 * Test-only seam: redirect the sidecar to a temp file without mutating
 * process.env.GBRAIN_HOME (the test-isolation lint forbids global env
 * mutation). Pass null to restore. @internal exported for tests.
 */
export function __setUsageLogPathForTests(path: string | null): void {
  _pathOverride = path;
}

export function usageLogPath(): string {
  return _pathOverride ?? gbrainPath('integrations', 'memory-verbs', 'usage.jsonl');
}

/** The resolved gbrain home — the per-brain disambiguator for multi-brain stats. */
export function brainId(): string {
  return gbrainPath();
}

/**
 * Fire-and-forget append. NEVER throws, NEVER blocks the verb call — callers
 * do not await this (dispatch invokes it without await).
 */
export function logVerbUsage(event: Omit<VerbUsageEvent, 'ts' | 'brain_id'>): void {
  void (async () => {
    try {
      const path = usageLogPath();
      await mkdir(dirname(path), { recursive: true });
      // Best-effort lock-free rotation (stats-only; dropped lines tolerated).
      try {
        const s = await stat(path);
        if (s.size > ROTATE_BYTES) {
          await rename(path, join(dirname(path), 'usage.jsonl.1'));
        }
      } catch {
        /* no file yet, or a concurrent rotate won — either is fine */
      }
      const line =
        JSON.stringify({ ts: new Date().toISOString(), brain_id: brainId(), ...event }) + '\n';
      await appendFile(path, line, 'utf-8');
    } catch {
      /* observability never breaks the verb call */
    }
  })();
}

/**
 * Read events for `gbrain protocol stats` + the doctor check. Tolerates
 * malformed lines (torn writes on non-POSIX appends) by skipping them.
 */
export async function readVerbUsage(opts: { days?: number } = {}): Promise<VerbUsageEvent[]> {
  let raw: string;
  try {
    raw = await readFile(usageLogPath(), 'utf-8');
  } catch {
    return [];
  }
  const cutoff = opts.days ? Date.now() - opts.days * 24 * 60 * 60 * 1000 : null;
  const events: VerbUsageEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as VerbUsageEvent;
      if (!e || typeof e.verb !== 'string' || typeof e.ts !== 'string') continue;
      if (cutoff !== null) {
        const ms = Date.parse(e.ts);
        if (!Number.isFinite(ms) || ms < cutoff) continue;
      }
      events.push(e);
    } catch {
      /* torn line — skip */
    }
  }
  return events;
}

/** Earliest event timestamp — the TTHW numerator for `protocol stats` [D6C]. */
export async function earliestVerbUsageTs(): Promise<string | null> {
  const events = await readVerbUsage();
  let earliest: string | null = null;
  for (const e of events) {
    if (earliest === null || e.ts < earliest) earliest = e.ts;
  }
  return earliest;
}
