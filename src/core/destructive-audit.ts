/**
 * Destructive-op audit log (forensic trace for hard-deletes).
 *
 * Writes a JSONL line per hard-delete of source or page rows to
 * `~/.gbrain/audit/destructive-ops-YYYY-Www.jsonl` (ISO-week rotation, override
 * via `GBRAIN_AUDIT_DIR`).
 *
 * The motivating bug class: an operator running `gbrain sources remove default
 * --confirm-destructive` (or any hard-delete path) leaves no on-disk trail
 * outside of Claude Code session JSONL transcripts. When the action happens
 * via the CLI in a terminal, there's no record. The next mystery — "what
 * deleted those 229 pages?" — becomes unsolvable without time-correlated
 * cross-referencing of cron logs, git reflog, and shell history (which is
 * usually disabled or rotated out).
 *
 * Wired into the four hard-delete primitives that exist on both engines:
 *
 *   1. `pglite-engine.ts:deletePage`         — raw delete primitive
 *   2. `postgres-engine.ts:deletePage`       — same, Postgres path
 *   3. `pglite-engine.ts:purgeDeletedPages`  — autopilot purge phase + manual
 *   4. `postgres-engine.ts:purgeDeletedPages` — same, Postgres path
 *   5. `destructive-guard.ts:purgeExpiredSources` — source-level cascade
 *
 * Soft-deletes (`softDeletePage`) are intentionally NOT logged — they're
 * reversible within 72h and don't lose data. Only operations that hard-delete
 * data get the audit line.
 *
 * Best-effort: write failures emit a stderr warning but never block the op.
 * A disk-full attacker can silently disable the trail; CHANGELOG should call
 * this out as an operational trace, not a security primitive.
 *
 * Modeled after `src/core/minions/handlers/shell-audit.ts` (shell-job audit)
 * and `src/core/rerank-audit.ts` (reranker failure audit) — same file-naming
 * convention, same `GBRAIN_AUDIT_DIR` override, same best-effort posture.
 *
 * Closes #1063 follow-up (the orphan-detection PR surfaces existing orphans;
 * this PR makes future ones reconstructible).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { gbrainPath } from './config.ts';

export type DestructiveOp = 'deletePage' | 'purgeDeletedPages' | 'purgeExpiredSources';

export interface DestructiveAuditEvent {
  ts: string;
  op: DestructiveOp;
  engine: 'pglite' | 'postgres';
  // op-specific fields (sparse — only set what's relevant per op)
  slug?: string;                  // deletePage
  source_id?: string;             // deletePage
  older_than_hours?: number;      // purgeDeletedPages
  pages_purged?: number;          // purgeDeletedPages result count
  page_slugs?: string[];          // purgeDeletedPages result slugs (truncated to first 50 for readability)
  page_slugs_truncated?: boolean; // true if page_slugs was truncated
  sources_purged?: number;        // purgeExpiredSources result count
  source_ids?: string[];          // purgeExpiredSources result IDs
}

/**
 * Compute `destructive-ops-YYYY-Www.jsonl` using ISO-8601 week numbering.
 * Same algorithm as `shell-audit.ts:computeAuditFilename` — kept inline rather
 * than DRYed so a future change to one rotation cadence doesn't silently
 * flip another audit's filename shape.
 */
export function computeDestructiveAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `destructive-ops-${isoYear}-W${ww}.jsonl`;
}

/**
 * Resolve the audit dir. Honors `GBRAIN_AUDIT_DIR` for container/sandbox
 * deployments where `$HOME` is read-only. Defaults to `~/.gbrain/audit/`.
 */
export function resolveAuditDir(): string {
  const override = process.env.GBRAIN_AUDIT_DIR;
  if (override && override.trim().length > 0) return override;
  return gbrainPath('audit');
}

const MAX_SLUGS_IN_AUDIT = 50;

/**
 * Append a destructive-op event to the audit log. Best-effort: write failures
 * emit a stderr warning and return without throwing, so a destructive op never
 * fails because the audit log is unwritable.
 *
 * Truncates `page_slugs` to 50 entries with a `page_slugs_truncated: true`
 * marker — a single hard-delete of 10K stale pages shouldn't bloat one JSONL
 * line to 10K slug strings. The `pages_purged` count is the ground truth.
 */
export function logDestructiveOp(event: Omit<DestructiveAuditEvent, 'ts'>): void {
  const dir = resolveAuditDir();
  const filename = computeDestructiveAuditFilename();
  const fullPath = path.join(dir, filename);

  // Truncate page_slugs if oversized; preserve the count as ground truth.
  let finalEvent: Omit<DestructiveAuditEvent, 'ts'> = event;
  if (event.page_slugs && event.page_slugs.length > MAX_SLUGS_IN_AUDIT) {
    finalEvent = {
      ...event,
      page_slugs: event.page_slugs.slice(0, MAX_SLUGS_IN_AUDIT),
      page_slugs_truncated: true,
    };
  }

  const line = JSON.stringify({ ...finalEvent, ts: new Date().toISOString() }) + '\n';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fullPath, line, { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[destructive-audit] write failed (${msg}); op continues\n`);
  }
}

/**
 * Read the last N days of destructive-ops audit entries. Used by future doctor
 * checks and operator forensic queries. Tolerates missing files (returns empty
 * array) and malformed JSONL lines (skips them silently).
 */
export function readRecentDestructiveOps(days: number = 7): DestructiveAuditEvent[] {
  const dir = resolveAuditDir();
  if (!fs.existsSync(dir)) return [];
  const cutoffMs = Date.now() - days * 86400 * 1000;
  const events: DestructiveAuditEvent[] = [];
  // Walk only files matching our prefix so a coincident sibling audit file
  // (shell-jobs, rerank-failures, slug-fallback) doesn't trip the parser.
  const entries = fs.readdirSync(dir).filter((f) => f.startsWith('destructive-ops-') && f.endsWith('.jsonl'));
  for (const filename of entries) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, filename), 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as DestructiveAuditEvent;
        if (!ev.ts) continue;
        const eventMs = Date.parse(ev.ts);
        if (Number.isFinite(eventMs) && eventMs >= cutoffMs) {
          events.push(ev);
        }
      } catch {
        // Skip malformed line — partial-write or crash mid-append
      }
    }
  }
  // Sort newest-first by ts
  events.sort((a, b) => b.ts.localeCompare(a.ts));
  return events;
}
