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
 * GBRAIN_CONNECTION_TRACE=1 additionally records privacy-safe raw-query
 * lifecycle events (including the /health query). It records only a generated
 * lease id, connection id, pool, caller, static-vs-parameterized kind, timing,
 * and sanitized error code. SQL text, parameters, URLs, and provider payloads
 * are never accepted by the trace API.
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
  op:
    | 'acquire'
    | 'release'
    | 'error'
    | 'init'
    | 'query_start'
    | 'checkout'
    | 'query_end'
    | 'query_error'
    | 'close';
  duration_ms?: number;
  stmt_timeout_ms?: number;
  caller?: string;               // e.g. 'migrate.runMigrationSQL.v42'
  host?: string;                 // redacted-URL host only, never creds
  lease_id?: string;
  connection_id?: number;
  query_kind?: 'static' | 'parameterized';
  error?: { code?: string; message: string };
}

type ConnectionEventSink = (event: ConnectionEvent) => void;

export interface ConnectionTraceSpan {
  /**
   * Undocumented postgres.js per-query hook. Returning true is required to let
   * the driver continue pipelining after the callback.
   */
  unsafeOptions?: {
    onexecute: (connection: { id?: unknown }) => boolean;
  };
  finish: (error?: unknown) => void;
}

let _auditDirCache: string | null = null;
let _auditEnabled = true;
let _traceSequence = 0;

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

export function isConnectionTraceEnabled(): boolean {
  const raw = process.env.GBRAIN_CONNECTION_TRACE;
  return raw === '1' || raw === 'true';
}

/**
 * Trace a raw query from application issue through driver checkout to settle.
 *
 * The API deliberately has no SQL/parameters arguments, making accidental
 * payload capture structurally impossible. `emit` is injectable for tests.
 */
export function startConnectionTraceSpan(
  input: {
    pool: ConnectionEvent['pool'];
    caller: string;
    queryKind: NonNullable<ConnectionEvent['query_kind']>;
  },
  emit: ConnectionEventSink = logConnectionEvent,
): ConnectionTraceSpan {
  if (!isConnectionTraceEnabled()) {
    return { finish: () => {} };
  }

  const startedAt = Date.now();
  const leaseId = `${process.pid}-${startedAt.toString(36)}-${++_traceSequence}`;
  let finished = false;
  emit({
    pool: input.pool,
    op: 'query_start',
    caller: input.caller,
    lease_id: leaseId,
    query_kind: input.queryKind,
  });

  return {
    unsafeOptions: {
      onexecute(connection): boolean {
        const rawId = connection?.id;
        emit({
          pool: input.pool,
          op: 'checkout',
          caller: input.caller,
          lease_id: leaseId,
          query_kind: input.queryKind,
          connection_id: typeof rawId === 'number' && Number.isSafeInteger(rawId)
            ? rawId
            : undefined,
        });
        return true;
      },
    },
    finish(error?: unknown): void {
      if (finished) return;
      finished = true;
      const code = (error as { code?: unknown } | null)?.code;
      emit({
        pool: input.pool,
        op: error === undefined ? 'query_end' : 'query_error',
        caller: input.caller,
        lease_id: leaseId,
        query_kind: input.queryKind,
        duration_ms: Date.now() - startedAt,
        error: error === undefined
          ? undefined
          : {
              code: typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)
                ? code
                : undefined,
              message: 'query_failed',
            },
      });
    },
  };
}

/**
 * Pool-level close hook. Unlike postgres.js `debug`, this does not make SQL
 * text and parameters enumerable on thrown errors.
 */
export function postgresConnectionTraceOptions(
  pool: ConnectionEvent['pool'],
  emit: ConnectionEventSink = logConnectionEvent,
): { onclose?: (connectionId: number) => void } {
  if (!isConnectionTraceEnabled()) return {};
  return {
    onclose(connectionId): void {
      emit({
        pool,
        op: 'close',
        connection_id: Number.isSafeInteger(connectionId) ? connectionId : undefined,
      });
    },
  };
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
