/**
 * `get_status_snapshot` MCP op contract.
 *
 * Pins the per-op decisions:
 *   - scope: 'admin' (codex MAJOR-9 / D10 — prevents read-scoped clients
 *     from seeing brain-host operational state).
 *   - localOnly: false (remote thin-client `gbrain status` callers need
 *     it via HTTP MCP — that's the whole point).
 *   - payload (schema_version 2, Minions-visibility wave): {schema_version,
 *     version, sync, cycle, queue, workers}. `queue` and `workers` were
 *     DELIBERATELY added so a remote submitter can see whether the lane its
 *     job ids point at is alive; Locks / Autopilot remain omitted (host-local
 *     concerns the thin client renders as "N/A on remote brain").
 *   - fail-soft (amendment 26): a v2 section that cannot compute degrades to
 *     {error: 'unavailable'} without failing the snapshot.
 *
 * Hermetic — stubs the engine. The cycle / sync helpers degrade
 * gracefully when their queries throw, so a stubbed `executeRaw` that
 * returns `[]` is enough to exercise the shape. The workers section also
 * reads host-local files (supervisor pidfile) — those assertions are
 * type-shaped, not value-pinned, so a dev machine with a live supervisor
 * doesn't flake the suite.
 */

import { describe, test, expect } from 'bun:test';
import { operations, operationsByName } from '../src/core/operations.ts';

function makeCtx(engine: any): any {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
  };
}

describe('get_status_snapshot op definition', () => {
  test('exists and is registered in the operations array', () => {
    expect(operationsByName.get_status_snapshot).toBeDefined();
    expect(operations.find((o) => o.name === 'get_status_snapshot')).toBeDefined();
  });

  test('scope is admin', () => {
    const op = operationsByName.get_status_snapshot;
    expect(op.scope).toBe('admin');
  });

  test('localOnly is false (must be remote-callable for thin-client status)', () => {
    const op = operationsByName.get_status_snapshot;
    expect(op.localOnly).toBe(false);
  });

  test('takes no params', () => {
    const op = operationsByName.get_status_snapshot;
    expect(op.params).toEqual({});
  });
});

describe('get_status_snapshot handler shape (schema_version 2)', () => {
  test('returns {schema_version: 2, version, sync, cycle, queue, workers} (no Locks/Autopilot)', async () => {
    const op = operationsByName.get_status_snapshot;
    // Stub engine that returns empty rows for any executeRaw and a minimal
    // BrainEngine shape. The sync helper degrades to an empty sources list
    // and a synthetic SyncStatusReport; the cycle helper degrades to
    // {last_full: null, last_targeted: null}; the queue helpers degrade to
    // zero counts + an empty by_queue list.
    const stubEngine: any = {
      kind: 'pglite',
      executeRaw: async () => [],
      getConfig: async () => null,
    };
    const result = (await op.handler(makeCtx(stubEngine), {})) as Record<string, unknown>;
    expect(result.schema_version).toBe(2);
    expect(result).toHaveProperty('sync');
    expect(result).toHaveProperty('cycle');
    // #1984: the op also reports the brain server's version (thin-client parity).
    expect(typeof result.version).toBe('string');
    // Minions-visibility wave: queue + workers are IN the remote payload now.
    expect(result).toHaveProperty('queue');
    expect(result).toHaveProperty('workers');
    // Locks / Autopilot stay host-local.
    expect(result).not.toHaveProperty('locks');
    expect(result).not.toHaveProperty('autopilot');

    const queue = result.queue as Record<string, unknown>;
    expect(queue.counts).toEqual({ active: 0, waiting: 0, completed: 0, failed: 0, dead: 0 });
    expect(queue.by_queue).toEqual([]);

    // Workers keys present; values are host-dependent (pidfile probe), so
    // pin types, not values.
    const workers = result.workers as Record<string, unknown>;
    expect(typeof workers.supervisor_alive).toBe('boolean');
    expect([null, 'pidfile', 'db_lock']).toContain(workers.detected_via as any);
    expect(typeof workers.live_lock_active).toBe('boolean');
    // Stubbed engine returns no completed rows.
    expect(workers.last_completed_at).toBeNull();
  });

  test('amendment 26: a failing queue section degrades to {error: unavailable} without failing the snapshot', async () => {
    const op = operationsByName.get_status_snapshot;
    // buildQueueCounts swallows its own errors (returns zeros); buildQueueDepths
    // does not — throwing from its GROUP BY queue SQL exercises the op-level
    // per-section catch.
    const stubEngine: any = {
      kind: 'pglite',
      executeRaw: async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('GROUP BY queue')) {
          throw new Error('minion_jobs table melted');
        }
        return [];
      },
      getConfig: async () => null,
    };
    const result = (await op.handler(makeCtx(stubEngine), {})) as Record<string, unknown>;
    expect(result.schema_version).toBe(2);
    expect(result.queue).toEqual({ error: 'unavailable' });
    // The rest of the snapshot survives.
    expect(result).toHaveProperty('sync');
    expect(result).toHaveProperty('cycle');
    expect(result).toHaveProperty('workers');
  });
});
