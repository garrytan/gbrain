/**
 * Connection-events audit trail (v0.30.1, finding F8).
 *
 * Mirrors the shell-jobs / subagent / backpressure audit pattern.
 *
 * Writes one JSONL line per ddl()/bulk() acquire+release+error to
 * ~/.gbrain/audit/connection-events-YYYY-Www.jsonl (ISO-week rotation).
 * Doctor's connection_routing check tail-reads the JSONL and surfaces
 * the last 5 errors as warning context.
 *
 * Best-effort by design: failures during write are logged to stderr but
 * never block the caller (matches shell-audit.ts).
 *
 * PGLite engines no-op via the `enabled` flag.
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gbrainPath } from './config.ts';
import { redactPgUrl } from './url-redact.ts';

export interface ConnectionEvent {
  ts?: string;                   // ISO 8601, defaults to NOW
  pool: 'read' | 'ddl' | 'bulk' | 'single';
  op: 'acquire' | 'release' | 'error' | 'init';
  duration_ms?: number;
  stmt_timeout_ms?: number;
  caller?: string;               // e.g. 'migrate.runMigrationSQL.v42'
  host?: string;                 // redacted-URL host only, never creds
  error?: { code?: string; message: string };
}

let _auditDirCache: string | null = null;
let _auditEnabled = true;

export function setAuditEnabled(enabled: boolean): void {
  _auditEnabled = enabled;
}

function getAuditDir(): string {
  if (_auditDirCache) return _auditDirCache;
  _auditDirCache = gbrainPath('audit');
  return _auditDirCache;
}

function getIsoWeekFilename(d: Date = new Date()): string {
  // ISO 8601 week date: year + week number. Match shell-audit.ts format.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const yearStr = target.getUTCFullYear();
  const weekStr = String(weekNum).padStart(2, '0');
  return `connection-events-${yearStr}-W${weekStr}.jsonl`;
}

export function logConnectionEvent(event: ConnectionEvent): void {
  if (!_auditEnabled) return;
  try {
    const dir = getAuditDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, getIsoWeekFilename());
    const line = {
      ts: event.ts ?? new Date().toISOString(),
      ...event,
      // Defensive: if a caller passes a full URL by mistake, redact.
      host: event.host ? redactPgUrl(event.host) : undefined,
    };
    appendFileSync(path, JSON.stringify(line) + '\n', 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[connection-audit] write failed: ${msg}\n`);
  }
}

/**
 * Tail the most recent N lines from this week's connection-events file
 * that match `op === 'error'`. Doctor uses this to surface the last
 * connection-routing failures.
 *
 * Pure-best-effort: missing file, unreadable file, malformed JSON all
 * return [] silently.
 */
export function tailRecentErrors(limit: number = 5): ConnectionEvent[] {
  try {
    const dir = getAuditDir();
    if (!existsSync(dir)) return [];
    const path = join(dir, getIsoWeekFilename());
    if (!existsSync(path)) return [];
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const errors: ConnectionEvent[] = [];
    for (let i = lines.length - 1; i >= 0 && errors.length < limit; i--) {
      try {
        const obj = JSON.parse(lines[i]) as ConnectionEvent;
        if (obj.op === 'error') errors.push(obj);
      } catch { /* malformed line, skip */ }
    }
    return errors;
  } catch {
    return [];
  }
}
