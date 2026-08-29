/**
 * #2898 — deadlined initSchema advisory-lock acquisition.
 *
 * Pre-fix, PostgresEngine.initSchema ran a bare `SELECT pg_advisory_lock(42)`
 * that blocks forever when a leaked pooler session holds the lock
 * (transaction-mode poolers strip session lock state across checkouts), so
 * every gbrain invocation hung at connect with no output.
 *
 * Hermetic: drives acquireInitSchemaAdvisoryLock with a fake query fn +
 * injected clock/sleep. Covers: immediate acquire, acquire-after-wait,
 * heartbeat naming the holder pid, timeout error with pg_terminate_backend
 * guidance, env-tunable timeout, and pg_locks-probe failure fallback.
 */

import { describe, test, expect } from 'bun:test';
import {
  acquireInitSchemaAdvisoryLock,
  resolveInitSchemaLockTimeoutMs,
  INIT_SCHEMA_LOCK_KEY,
} from '../src/core/postgres-engine/init-schema-lock.ts';

type Row = Record<string, unknown>;

/** Fake clock advanced by the injected sleep. */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
  };
}

describe('resolveInitSchemaLockTimeoutMs', () => {
  test('opts win over env; env (seconds) wins over the 10-min default', () => {
    expect(resolveInitSchemaLockTimeoutMs({ timeoutMs: 1234 }, { GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS: '5' })).toBe(1234);
    expect(resolveInitSchemaLockTimeoutMs({}, { GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS: '5' })).toBe(5000);
    expect(resolveInitSchemaLockTimeoutMs({}, {})).toBe(600_000);
  });

  test('invalid env values fall through to the default', () => {
    expect(resolveInitSchemaLockTimeoutMs({}, { GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS: 'nope' })).toBe(600_000);
    expect(resolveInitSchemaLockTimeoutMs({}, { GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS: '-3' })).toBe(600_000);
  });
});

describe('acquireInitSchemaAdvisoryLock', () => {
  test('returns immediately when the lock is free', async () => {
    const clock = makeClock();
    const calls: string[] = [];
    await acquireInitSchemaAdvisoryLock(
      async (sql) => { calls.push(sql); return [{ locked: true }]; },
      { now: clock.now, sleep: clock.sleep },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`pg_try_advisory_lock(${INIT_SCHEMA_LOCK_KEY})`);
  });

  test('polls until the holder releases, then acquires', async () => {
    const clock = makeClock();
    let attempts = 0;
    await acquireInitSchemaAdvisoryLock(
      async (sql) => {
        if (sql.includes('pg_try_advisory_lock')) {
          attempts += 1;
          return [{ locked: attempts >= 3 }];
        }
        return [{ pid: 777 }];
      },
      { now: clock.now, sleep: clock.sleep, pollMs: 100, heartbeatMs: 1_000_000 },
    );
    expect(attempts).toBe(3);
  });

  test('heartbeat names the holder pid on stderr-style log sink', async () => {
    const clock = makeClock();
    const lines: string[] = [];
    let attempts = 0;
    await acquireInitSchemaAdvisoryLock(
      async (sql) => {
        if (sql.includes('pg_try_advisory_lock')) {
          attempts += 1;
          return [{ locked: attempts >= 5 }];
        }
        return [{ pid: 4242 }];
      },
      { now: clock.now, sleep: clock.sleep, pollMs: 500, heartbeatMs: 1000, log: (l) => lines.push(l) },
    );
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain('waiting for the schema advisory lock');
    expect(lines[0]).toContain('4242');
  });

  test('times out with holder pid + pg_terminate_backend guidance', async () => {
    const clock = makeClock();
    let err: Error | null = null;
    try {
      await acquireInitSchemaAdvisoryLock(
        async (sql) => {
          if (sql.includes('pg_try_advisory_lock')) return [{ locked: false }];
          expect(sql).toContain('pg_locks');
          return [{ pid: 999 }];
        },
        { now: clock.now, sleep: clock.sleep, timeoutMs: 2000, pollMs: 500, heartbeatMs: 1_000_000 },
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('timed out');
    expect(err!.message).toContain('pid 999');
    expect(err!.message).toContain('pg_terminate_backend(999)');
    expect(err!.message).toContain('GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS');
    // Names the pooler failure mode so operators recognize the leak class.
    expect(err!.message.toLowerCase()).toContain('pooler');
  });

  test('pg_locks probe failure still produces a useful timeout error', async () => {
    const clock = makeClock();
    let err: Error | null = null;
    try {
      await acquireInitSchemaAdvisoryLock(
        async (sql) => {
          if (sql.includes('pg_try_advisory_lock')) return [{ locked: false }];
          throw new Error('pg_locks not readable');
        },
        { now: clock.now, sleep: clock.sleep, timeoutMs: 1000, pollMs: 500, heartbeatMs: 1_000_000 },
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('could not be determined');
    expect(err!.message).toContain('pg_terminate_backend(<pid>)');
  });
});
