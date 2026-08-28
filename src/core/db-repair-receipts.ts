/**
 * db-repair receipts — the shared seam between `gbrain db-repair` (writer)
 * and doctor's `db_repair_recurrence` check (reader). ENGINE-FREE by
 * design: the reader must run in doctor's dead-DB filesystem lane, which is
 * exactly when repairs are repeating.
 *
 * Rows are REDACTED before they get here (the classifier redacts its own
 * message/remediation; actions are fixed strings) — the file is safe to
 * paste into an issue. Fail-open: a receipts problem never blocks a repair.
 * Capped: the recurrence check reads this file on every doctor run, so it
 * must not grow unbounded on exactly the machines having chronic problems.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { gbrainPath } from './config.ts';
import type { PgAccessReason } from './pg-access-classify.ts';

export const RECEIPTS_CAP = 200;
export const REWRITE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface RepairReceipt {
  ts: number;
  brain_id: string;
  reason: PgAccessReason | 'undo';
  action: string;
  outcome: 'applied' | 'refused' | 'diagnose';
}

export function receiptsPath(): string {
  return gbrainPath('db-repair-receipts.jsonl');
}

export function readReceipts(): RepairReceipt[] {
  try {
    const raw = readFileSync(receiptsPath(), 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        // Per-line: one torn/corrupt row (e.g. a kill mid-append) must not
        // discard every OTHER receipt — that would silently disarm both the
        // recurrence check and the rewrite cooldown.
        try {
          return JSON.parse(l) as RepairReceipt;
        } catch {
          return null;
        }
      })
      .filter((r): r is RepairReceipt => typeof r?.ts === 'number');
  } catch {
    return [];
  }
}

/** Recent `applied` rows are the cooldown + recurrence MEMORY — a machine in
 *  a diagnose loop (one skill firing per marker sighting) writes hundreds of
 *  diagnose rows a day, and a flat last-N cap would evict the one applied
 *  rewrite receipt that arms the 24h cooldown. Keep applied rows inside the
 *  recurrence window exempt from the flat cap (bounded separately). */
const APPLIED_RETENTION_MS = 8 * 24 * 60 * 60 * 1000; // recurrence window + slack

/** Fail-open append with the cap applied on every write. */
export function writeReceipt(r: RepairReceipt): void {
  try {
    const rows = readReceipts();
    rows.push(r);
    const cutoff = r.ts - APPLIED_RETENTION_MS;
    const isProtected = (x: RepairReceipt): boolean => x.outcome === 'applied' && x.ts >= cutoff;
    const protectedRows = rows.filter(isProtected).slice(-RECEIPTS_CAP);
    const protectedSet = new Set(protectedRows);
    const rest = rows.filter((x) => !protectedSet.has(x)).slice(-RECEIPTS_CAP);
    const capped = [...rest, ...protectedRows].sort((a, b) => a.ts - b.ts);
    writeFileSync(receiptsPath(), capped.map((x) => JSON.stringify(x)).join('\n') + '\n');
  } catch (e) {
    console.warn(`[db-repair] receipt write failed (continuing): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Rewrite-tier cooldown: same (reason, action) applied within 24h. */
export function rewriteCooldownBlocked(reason: string, action: string, now: number): boolean {
  return readReceipts().some(
    (r) => r.outcome === 'applied' && r.reason === reason && r.action === action && now - r.ts < REWRITE_COOLDOWN_MS,
  );
}
