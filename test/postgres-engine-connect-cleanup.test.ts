/**
 * #1720 follow-up — PostgresEngine.connect() must not retain a half-open
 * postgres.js client when the post-construction probe fails.
 *
 * Pre-fix, the instance path (poolSize set) assigned `this._sql = postgres(...)`
 * and only AFTERWARD awaited `SELECT 1`. A thrown probe (e.g. EMAXCONNSESSION
 * when the Supabase session-mode pooler is at its client cap, or ECONNREFUSED
 * mid-rebuild) left `_sql` set as a half-open client that holds a pooler client
 * slot until the next reconnect()'s disconnect() tears it down. Under a tight
 * session-mode cap that transient retention compounds connection pressure —
 * surfaced live alongside the #1720 autopilot crash-loop fix (PR #1935).
 *
 * The fix wraps the instance rebuild in try/catch: on failure it ends + nulls
 * `_sql` (and any partial connectionManager) before rethrowing, so a failed
 * connect leaves the engine holding ZERO clients. Uses a refused local port —
 * a real, deterministic failure, no external dependency.
 */
import { describe, test, expect } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

describe('PostgresEngine.connect() cleanup on failed probe (#1720 follow-up)', () => {
  test('instance-path connect() whose probe fails retains no _sql client', async () => {
    const engine = new PostgresEngine();
    // postgres() constructs lazily; the SELECT 1 probe then throws ECONNREFUSED
    // (port 1 is refused immediately), standing in for a failed instance rebuild.
    await expect(
      engine.connect({ database_url: 'postgresql://u:p@127.0.0.1:1/db', poolSize: 1 } as unknown as Parameters<PostgresEngine['connect']>[0]),
    ).rejects.toThrow();

    // The half-open client must be torn down + nulled, not retained until the
    // next reconnect. This is the load-bearing assertion (pre-fix: _sql is the
    // retained client object → fails).
    expect((engine as unknown as { _sql: unknown })._sql).toBeNull();
    // No dangling partial connection manager either.
    expect((engine as unknown as { connectionManager: unknown }).connectionManager).toBeNull();
    // A poolSize-configured engine whose FIRST connect failed must still be
    // marked 'instance', so the next reconnect() routes through the instance
    // path (reconnect() branches on `_connectionStyle !== 'instance'`). Leaving
    // it null would silently divert into module-singleton recovery (Data R1).
    expect((engine as unknown as { _connectionStyle: unknown })._connectionStyle).toBe('instance');
  }, 15000);
});
