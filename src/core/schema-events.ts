// v0.39 T15 — gbrain schema CLI event audit.
//
// JSONL at ~/.gbrain/audit/schema-events-YYYY-Www.jsonl. ISO-week rotation
// per existing audit-pattern (mirrors audit-slug-fallback.ts, shell-audit.ts,
// rerank-audit.ts, etc.). Best-effort writes — stderr warn on disk failure,
// NEVER throws.
//
// Feeds T23's `gbrain schema usage --since 30d` for the experimental-tier
// telemetry gate. v0.40+ retro reads this data to decide which cathedral
// commands are demand-proven vs candidates for deprecation per D14 hybrid.
//
// Privacy: records ONLY verb names + timestamps + outcome. No pack
// content, no slug names, no user data.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAuditDir } from './minions/handlers/shell-audit.ts';

export interface SchemaEventRecord {
  ts: string;
  verb: string;
  outcome: 'success' | 'error' | 'unknown';
  /** Optional flag — e.g. --json was passed. No values, just flag names. */
  flags?: string[];
}

export function computeIsoWeekName(date: Date = new Date()): string {
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function computeSchemaEventPath(date: Date = new Date()): string {
  return join(resolveAuditDir(), `schema-events-${computeIsoWeekName(date)}.jsonl`);
}

export function logSchemaEvent(record: Omit<SchemaEventRecord, 'ts'>): void {
  try {
    const path = computeSchemaEventPath();
    mkdirSync(resolveAuditDir(), { recursive: true });
    const line: SchemaEventRecord = { ts: new Date().toISOString(), ...record };
    appendFileSync(path, JSON.stringify(line) + '\n');
  } catch (e) {
    console.error(`[schema-events] audit write failed: ${(e as Error).message}`);
  }
}

/**
 * Read recent schema events from the last N days. Used by T23
 * `gbrain schema usage --since 30d`. Walks recent ISO-week files
 * (forward + backward 4 weeks to safely cover a 30-day window).
 */
export function readRecentSchemaEvents(days: number): SchemaEventRecord[] {
  const out: SchemaEventRecord[] = [];
  const dir = resolveAuditDir();
  if (!existsSync(dir)) return out;
  const cutoffMs = Date.now() - days * 86400_000;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('schema-events-') && f.endsWith('.jsonl'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const content = readFileSync(join(dir, f), 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as SchemaEventRecord;
          if (new Date(rec.ts).getTime() >= cutoffMs) out.push(rec);
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // skip unreadable files
    }
  }
  return out;
}
