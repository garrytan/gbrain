/**
 * advisor/history.ts — E3 finding history (local-only, file-plane).
 *
 * Append-only `~/.gbrain/advisor-history.jsonl`, bounded/rotated. Chosen over a
 * DB migration table (eng-review): it removes the plan's only schema migration +
 * engine-parity burden and matches the nag-state/skillpack-state file-plane
 * pattern. The advisor only appends a snapshot and reads the most recent one for
 * "since last run" deltas — no SQL queries needed.
 *
 * Local-only: callers skip these writes when remote (the MCP advisor is strictly
 * read-only). Best-effort: a write failure never blocks the report.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import { gbrainPath } from '../config.ts';
import type { AdvisorReport } from './types.ts';

/** Max snapshots retained before rotation trims the file to the newest half. */
export const ADVISOR_HISTORY_MAX = 100;

export interface AdvisorRunSnapshot {
  ts: string;
  version: string;
  worst: AdvisorReport['worst'];
  finding_ids: string[];
}

export function advisorHistoryPath(): string {
  return gbrainPath('advisor-history.jsonl');
}

function readSnapshots(path: string): AdvisorRunSnapshot[] {
  if (!existsSync(path)) return [];
  const out: AdvisorRunSnapshot[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as AdvisorRunSnapshot);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/**
 * Append a snapshot for this run and return the PRIOR snapshot (for deltas), or
 * null on a cold history. Rotates the file when it grows past the cap. Pure-ish:
 * `opts.path` overrides the default for tests.
 */
export function appendAdvisorRun(
  report: AdvisorReport,
  opts: { path?: string } = {},
): AdvisorRunSnapshot | null {
  const path = opts.path ?? advisorHistoryPath();
  const prior = readSnapshots(path);
  const last = prior.length > 0 ? prior[prior.length - 1]! : null;

  const snap: AdvisorRunSnapshot = {
    ts: report.generated_at,
    version: report.version,
    worst: report.worst,
    finding_ids: report.findings.map((f) => f.id),
  };

  mkdirSync(dirname(path), { recursive: true });
  // Rotate: when at/over the cap, rewrite with the newest half + this snapshot.
  if (prior.length >= ADVISOR_HISTORY_MAX) {
    const keep = prior.slice(Math.floor(ADVISOR_HISTORY_MAX / 2));
    const tmp = path + '.tmp';
    writeFileSync(tmp, [...keep, snap].map((s) => JSON.stringify(s)).join('\n') + '\n', { mode: 0o644 });
    renameSync(tmp, path);
  } else {
    appendFileSync(path, JSON.stringify(snap) + '\n', { mode: 0o644 });
  }
  return last;
}

/** A one-line "since last run" delta, or '' when there's no prior run. */
export function summarizeDeltas(prior: AdvisorRunSnapshot | null, current: AdvisorReport): string {
  if (!prior) return '';
  const before = new Set(prior.finding_ids);
  const now = new Set(current.findings.map((f) => f.id));
  const added = [...now].filter((id) => !before.has(id));
  const resolved = [...before].filter((id) => !now.has(id));
  if (added.length === 0 && resolved.length === 0) return '';
  const parts: string[] = [];
  if (added.length) parts.push(`${added.length} new since last run`);
  if (resolved.length) parts.push(`${resolved.length} resolved`);
  return `(${parts.join(', ')})`;
}
