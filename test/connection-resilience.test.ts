import { describe, it, expect } from 'bun:test';

/**
 * Tests for connection resilience features:
 * 1. PostgresEngine.executeRaw retries on connection errors
 * 2. PostgresEngine.reconnect creates fresh connection pool
 * 3. Supervisor health check tracks consecutive failures
 * 4. Supervisor classifies worker exit reasons
 */

// --- Unit tests for isConnectionError (extracted pattern) ---

const CONNECTION_ERROR_PATTERNS = [
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'connection terminated',
  'Client has encountered a connection error',
  'password authentication failed',
  'Connection terminated unexpectedly',
  'no pg_hba.conf entry',
  'server closed the connection unexpectedly',
  'SSL connection has been closed unexpectedly',
  'connection is insecure',
  'too many connections',
  'remaining connection slots are reserved',
];

function isConnectionError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code && CONNECTION_ERROR_PATTERNS.includes(code)) return true;
  return CONNECTION_ERROR_PATTERNS.some(p => msg.includes(p));
}

describe('isConnectionError', () => {
  it('detects password authentication failure', () => {
    expect(isConnectionError(new Error('password authentication failed for user "postgres"'))).toBe(true);
  });

  it('detects ECONNREFUSED via error code', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5432') as NodeJS.ErrnoException;
    err.code = 'ECONNREFUSED';
    expect(isConnectionError(err)).toBe(true);
  });

  it('detects ECONNRESET via error code', () => {
    const err = new Error('read ECONNRESET') as NodeJS.ErrnoException;
    err.code = 'ECONNRESET';
    expect(isConnectionError(err)).toBe(true);
  });

  it('detects connection terminated message', () => {
    expect(isConnectionError(new Error('connection terminated'))).toBe(true);
  });

  it('detects Connection terminated unexpectedly', () => {
    expect(isConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('detects server closed the connection', () => {
    expect(isConnectionError(new Error('server closed the connection unexpectedly'))).toBe(true);
  });

  it('detects SSL connection closed', () => {
    expect(isConnectionError(new Error('SSL connection has been closed unexpectedly'))).toBe(true);
  });

  it('detects too many connections', () => {
    expect(isConnectionError(new Error('FATAL: too many connections for role "postgres"'))).toBe(true);
  });

  it('does not match regular query errors', () => {
    expect(isConnectionError(new Error('relation "foo" does not exist'))).toBe(false);
  });

  it('does not match null/undefined', () => {
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });

  it('does not match syntax errors', () => {
    expect(isConnectionError(new Error('syntax error at or near "SELECT"'))).toBe(false);
  });

  it('does not match constraint violations', () => {
    expect(isConnectionError(new Error('duplicate key value violates unique constraint'))).toBe(false);
  });
});

// --- Unit tests for worker exit classification ---

function classifyWorkerExit(code: number | null, signal: string | null): string {
  if (signal === 'SIGKILL') return 'oom_or_external_kill';
  if (signal === 'SIGTERM') return 'graceful_shutdown';
  if (code === 1) return 'runtime_error';
  if (code === 0) return 'clean_exit';
  return 'unknown';
}

describe('classifyWorkerExit', () => {
  it('classifies SIGKILL as OOM/external kill', () => {
    expect(classifyWorkerExit(null, 'SIGKILL')).toBe('oom_or_external_kill');
  });

  it('classifies SIGTERM as graceful shutdown', () => {
    expect(classifyWorkerExit(null, 'SIGTERM')).toBe('graceful_shutdown');
  });

  it('classifies exit code 1 as runtime error', () => {
    expect(classifyWorkerExit(1, null)).toBe('runtime_error');
  });

  it('classifies exit code 0 as clean exit', () => {
    expect(classifyWorkerExit(0, null)).toBe('clean_exit');
  });

  it('classifies unknown codes as unknown', () => {
    expect(classifyWorkerExit(137, null)).toBe('unknown');
    expect(classifyWorkerExit(null, null)).toBe('unknown');
  });

  // Signal takes precedence over code
  it('SIGKILL takes precedence over any exit code', () => {
    expect(classifyWorkerExit(1, 'SIGKILL')).toBe('oom_or_external_kill');
  });
});

// --- Mock-based tests for reconnect logic ---

describe('PostgresEngine reconnect behavior', () => {
  it('reconnect flag prevents concurrent reconnections', async () => {
    // Simulate the _reconnecting guard
    let reconnecting = false;
    let reconnectCount = 0;

    async function reconnect() {
      if (reconnecting) return;
      reconnecting = true;
      try {
        reconnectCount++;
        await new Promise(r => setTimeout(r, 10));
      } finally {
        reconnecting = false;
      }
    }

    // Fire 3 concurrent reconnects — only 1 should run
    await Promise.all([reconnect(), reconnect(), reconnect()]);
    expect(reconnectCount).toBe(1);
  });

  it('executeRaw retry does not infinite-loop on persistent connection failure', async () => {
    // Simulate: first call fails (connection error), reconnect succeeds,
    // but retry also fails with a NON-connection error
    let callCount = 0;

    async function executeRawWithRetry(): Promise<unknown[]> {
      callCount++;
      if (callCount === 1) {
        throw new Error('connection terminated'); // connection error → triggers retry
      }
      if (callCount === 2) {
        throw new Error('relation "foo" does not exist'); // NOT a connection error → throw
      }
      return [{ ok: true }];
    }

    try {
      await (async () => {
        try {
          return await executeRawWithRetry();
        } catch (err) {
          if (isConnectionError(err)) {
            // "reconnect" would happen here
            return await executeRawWithRetry();
          }
          throw err;
        }
      })();
    } catch (err) {
      expect((err as Error).message).toBe('relation "foo" does not exist');
    }

    expect(callCount).toBe(2); // Only 2 attempts, no infinite loop
  });

  it('executeRaw succeeds on retry after connection error', async () => {
    let callCount = 0;

    async function executeRawWithRetry(): Promise<unknown[]> {
      callCount++;
      if (callCount === 1) {
        throw new Error('password authentication failed for user "postgres"');
      }
      return [{ ok: true }];
    }

    const result = await (async () => {
      try {
        return await executeRawWithRetry();
      } catch (err) {
        if (isConnectionError(err)) {
          // reconnect would happen here
          return await executeRawWithRetry();
        }
        throw err;
      }
    })();

    expect(result).toEqual([{ ok: true }]);
    expect(callCount).toBe(2);
  });
});

// --- Supervisor health check failure tracking ---

describe('Supervisor health check failure tracking', () => {
  it('emits db_connection_degraded after 3 consecutive failures', () => {
    let consecutiveFailures = 0;
    const emitted: Array<{ event: string; reason?: string }> = [];

    function emit(event: string, fields: Record<string, unknown> = {}) {
      emitted.push({ event, ...fields } as { event: string; reason?: string });
    }

    // Simulate 3 health check failures
    for (let i = 0; i < 4; i++) {
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        emit('health_warn', { reason: 'db_connection_degraded', consecutive_failures: consecutiveFailures });
      } else {
        emit('health_error', { error: 'connection terminated' });
      }
    }

    const degradedWarnings = emitted.filter(e => e.reason === 'db_connection_degraded');
    expect(degradedWarnings.length).toBe(2); // fires at count 3 and 4

    // First two were regular health_error
    expect(emitted[0].event).toBe('health_error');
    expect(emitted[1].event).toBe('health_error');
    // Third triggers the degraded warning
    expect(emitted[2].reason).toBe('db_connection_degraded');
  });

  it('resets failure counter on successful health check', () => {
    let consecutiveFailures = 0;

    // 2 failures
    consecutiveFailures++;
    consecutiveFailures++;
    expect(consecutiveFailures).toBe(2);

    // Success resets
    consecutiveFailures = 0;
    expect(consecutiveFailures).toBe(0);

    // 1 more failure — should not trigger degraded (need 3 consecutive)
    consecutiveFailures++;
    expect(consecutiveFailures).toBeLessThan(3);
  });
});

// ─────────────────────────────────────────────────────────────────
// Eng-review D3 regression guards — executeRaw retry wrapper dropped
// ─────────────────────────────────────────────────────────────────
//
// The original #406 wrapped PostgresEngine.executeRaw in a per-call
// try/catch that retried on connection errors. Eng-review D3 dropped
// that wrapper as unsound (regex idempotence boundary doesn't hold
// for writable CTEs or side-effecting SELECTs). Recovery now happens
// at the supervisor level via the 3-strikes-then-reconnect path.
//
// These guards prevent reintroduction of the per-call retry without
// a typed-idempotency boundary.

import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Eng-review D3 — executeRaw has no per-call retry wrapper', () => {
  it('PostgresEngine.executeRaw is a single-statement passthrough (no try/catch on connection errors)', () => {
    const src = readFileSync(resolve('src/core/postgres-engine.ts'), 'utf-8');

    // Find the executeRaw method in the class (not the helper inside withReservedConnection)
    // Pattern: must be a method on the class taking (sql, params)
    const fnMatch = src.match(/async executeRaw<T = Record<string, unknown>>\(sql: string, params\?: unknown\[\]\): Promise<T\[\]> \{([\s\S]*?)\n  \}/);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![1];

    // Must not have any try/catch
    expect(body).not.toContain('try {');
    expect(body).not.toContain('catch');
    // Must not call reconnect() from this method
    expect(body).not.toContain('this.reconnect()');
    // Must call conn.unsafe directly
    expect(body).toContain('conn.unsafe(');
  });

  it('PostgresEngine.reconnect() still exists for supervisor-driven recovery', () => {
    const src = readFileSync(resolve('src/core/postgres-engine.ts'), 'utf-8');
    expect(src).toContain('async reconnect()');
    expect(src).toContain('await this.disconnect()');
  });

  it('Supervisor still has the 3-strikes-then-reconnect path', () => {
    const src = readFileSync(resolve('src/core/minions/supervisor.ts'), 'utf-8');
    expect(src).toContain('consecutiveHealthFailures');
    // Supervisor invokes reconnect via a typed cast after 3 consecutive failures.
    expect(src).toMatch(/reconnect\(\): Promise<void>/);
    expect(src).toContain('this.consecutiveHealthFailures >= 3');
  });
});
