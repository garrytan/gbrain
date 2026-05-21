/**
 * v0.35.5 — phantom-redirect audit trail.
 *
 * Writes one JSONL row per phantom-redirect decision to
 * `~/.gbrain/audit/phantoms-YYYY-Www.jsonl` (ISO-week rotation, mirrors
 * `audit-slug-fallback.ts`). Records BOTH success ('redirected') and
 * informational skip outcomes ('ambiguous', 'drift', 'no_canonical',
 * 'not_phantom_has_residue', 'pass_skipped_lock_busy') so operators can
 * triage what the autopilot cycle saw without re-running it.
 *
 * Sister surface of `src/core/facts/stub-guard-audit.ts` (different
 * consumer — stub-guard logs PREVENTIVE writes that never made it to
 * disk; phantom-audit logs CLEANUP outcomes for pages already on disk).
 * Keeping them separate means each file has a stable schema and the
 * doctor checks don't need to grow a discriminator.
 *
 * Best-effort writes. Failures emit a stderr line but never throw — a
 * disk-full or audit-dir-permission issue must not stall the cycle.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAuditDir } from '../minions/handlers/shell-audit.ts';

export type PhantomOutcome =
  | 'redirected'
  | 'ambiguous'
  | 'drift'
  | 'no_canonical'
  | 'not_phantom_has_residue'
  | 'pass_skipped_lock_busy';

export interface PhantomAuditEvent {
  ts: string;
  phantom_slug?: string;
  canonical_slug?: string;
  outcome: PhantomOutcome;
  fact_count?: number;
  source_id: string;
  reason?: string;
  candidates?: Array<{ slug: string; connection_count: number }>;
}

/** ISO-week-rotated filename: `phantoms-YYYY-Www.jsonl`. */
export function computePhantomAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `phantoms-${isoYear}-W${ww}.jsonl`;
}

/**
 * Append a phantom-redirect event to the current week's audit JSONL.
 *
 * `ts` is stamped at call time (caller-provided overrides honored). Write
 * failure is logged to stderr; the caller's cycle continues either way.
 */
export function logPhantomEvent(event: Omit<PhantomAuditEvent, 'ts'> & { ts?: string }): void {
  const record: PhantomAuditEvent = {
    ts: event.ts ?? new Date().toISOString(),
    outcome: event.outcome,
    source_id: event.source_id,
    ...(event.phantom_slug !== undefined ? { phantom_slug: event.phantom_slug } : {}),
    ...(event.canonical_slug !== undefined ? { canonical_slug: event.canonical_slug } : {}),
    ...(event.fact_count !== undefined ? { fact_count: event.fact_count } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.candidates !== undefined ? { candidates: event.candidates } : {}),
  };
  const dir = resolveAuditDir();
  const file = path.join(dir, computePhantomAuditFilename());
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] phantom audit write failed (${msg}); cycle continues\n`);
  }
}

/**
 * Read recent phantom-redirect events from the current + previous ISO
 * weeks. Used by future `gbrain doctor` `phantoms_pending` check (T9
 * follow-up) and by tests asserting the audit-write contract.
 *
 * Missing files / corrupt rows are skipped silently — the audit trail is
 * informational and shouldn't block any consumer.
 */
export function readRecentPhantomEvents(days = 7, now: Date = new Date()): PhantomAuditEvent[] {
  const dir = resolveAuditDir();
  const cutoff = now.getTime() - days * 86400000;
  const out: PhantomAuditEvent[] = [];
  const filenames = [
    computePhantomAuditFilename(now),
    computePhantomAuditFilename(new Date(now.getTime() - 7 * 86400000)),
  ];
  for (const filename of filenames) {
    const file = path.join(dir, filename);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      try {
        const ev = JSON.parse(line) as PhantomAuditEvent;
        const ts = Date.parse(ev.ts);
        if (Number.isFinite(ts) && ts >= cutoff) out.push(ev);
      } catch {
        // Corrupt row — skip.
      }
    }
  }
  return out;
}
