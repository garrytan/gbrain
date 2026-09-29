/**
 * Supervisor DB-health branch: consecutive health-query failures, the third
 * failure's degraded warning + engine.reconnect(), counter reset on a
 * successful reconnect, retry on every later failing tick when reconnect
 * fails, and suppression while stopping or configuration-blocked. Driven
 * through the real healthCheck() body with a fake engine; no DB, no spawn.
 */

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MinionSupervisor } from '../src/core/minions/supervisor.ts';
import { OwnerProcessingState, writeWorkerProcessingStatus } from '../src/core/minions/processing-state.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

type Emission = { event: string; reason?: string; [k: string]: unknown };

const healthyRow = [{
  stalled: '0', active_healthy: '0', waiting: '0', waiting_claimable: '0',
  last_completed: null, last_completed_claimable: null,
}];

function harness(opts: { reconnect?: () => Promise<void> } = {}) {
  const events: Emission[] = [];
  const state = { healthy: false, reconnects: 0, pending: null as null | ((e: Error) => void) };
  const engine = {
    kind: 'postgres',
    async executeRaw() {
      if (state.healthy) return healthyRow;
      throw new Error('connection terminated');
    },
    async reconnect() {
      state.reconnects++;
      if (opts.reconnect) await opts.reconnect();
    },
  } as unknown as BrainEngine;
  const sup = new MinionSupervisor(engine, {
    cliPath: '/bin/true',
    maxRssMb: 0,
    healthInterval: 60_000,
    wedgeRestartMinutes: 0,
    onEvent: (e) => events.push(e as Emission),
  });
  sup._setChildSupervisorForTests({ childAlive: true, inBackoff: false, restartCurrentChild: async () => {} } as never);
  const health = () => events.filter(e => e.event === 'health_warn' || e.event === 'health_error');
  return { sup, engine, events, health, state };
}

describe('supervisor DB health failures', () => {
  it('the first two failures emit health_error only and never reconnect', async () => {
    const h = harness();
    await h.sup._healthCheckOnceForTests();
    await h.sup._healthCheckOnceForTests();
    expect(h.state.reconnects).toBe(0);
    expect(h.health().map(e => [e.event, e.reason ?? null, e.error])).toEqual([
      ['health_error', null, 'connection terminated'],
      ['health_error', null, 'connection terminated'],
    ]);
  });

  it('the third consecutive failure emits db_connection_degraded, reconnects, then resets the counter', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.sup._healthCheckOnceForTests();
    expect(h.state.reconnects).toBe(1);
    const degraded = h.health().find(e => e.reason === 'db_connection_degraded');
    expect(degraded).toMatchObject({ event: 'health_warn', consecutive_failures: 3, error: 'connection terminated' });
    expect(h.health().at(-1)).toMatchObject({ event: 'health_warn', reason: 'db_reconnected' });

    await h.sup._healthCheckOnceForTests();
    await h.sup._healthCheckOnceForTests();
    expect(h.state.reconnects).toBe(1);
    await h.sup._healthCheckOnceForTests();
    expect(h.state.reconnects).toBe(2);
  });

  it('a successful health query between failures restarts the three-strike count', async () => {
    const h = harness();
    await h.sup._healthCheckOnceForTests();
    await h.sup._healthCheckOnceForTests();
    h.state.healthy = true;
    await h.sup._healthCheckOnceForTests();
    h.state.healthy = false;
    await h.sup._healthCheckOnceForTests();
    await h.sup._healthCheckOnceForTests();
    expect(h.state.reconnects).toBe(0);
    await h.sup._healthCheckOnceForTests();
    expect(h.state.reconnects).toBe(1);
  });

  it('a failed reconnect keeps the counter, so every later failing tick degrades and reconnects again', async () => {
    const h = harness({ reconnect: async () => { throw new Error('pool refused'); } });
    for (let i = 0; i < 3; i++) await h.sup._healthCheckOnceForTests();
    expect(h.state.reconnects).toBe(1);
    expect(h.health().at(-1)).toMatchObject({ event: 'health_error', reconnect_failed: true, error: 'reconnect failed: pool refused' });
    expect(h.health().some(e => e.reason === 'db_reconnected')).toBe(false);

    await h.sup._healthCheckOnceForTests();
    expect(h.state.reconnects).toBe(2);
    expect(h.health().filter(e => e.reason === 'db_connection_degraded').map(e => e.consecutive_failures)).toEqual([3, 4]);
  });

  it('a failure that lands after stop began is not reported and does not reconnect', async () => {
    const h = harness();
    Object.assign(h.sup, { consecutiveHealthFailures: 2 });
    let reject!: (e: Error) => void;
    (h.engine as unknown as { executeRaw: () => Promise<unknown> }).executeRaw = () => new Promise((_r, rej) => { reject = rej; });
    const tick = h.sup._healthCheckOnceForTests();
    Object.assign(h.sup, { stopping: true });
    reject(new Error('connection terminated'));
    await tick;
    expect(h.state.reconnects).toBe(0);
    expect(h.health()).toEqual([]);
  });

  it('a failure that lands after the owner became configuration-blocked is not reported and does not reconnect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-sup-health-'));
    try {
      await withEnv({ GBRAIN_HOME: root, HOME: root }, async () => {
        const h = harness();
        const owner = new OwnerProcessingState('supervisor', 'fixture');
        try {
          Object.assign(h.sup, { processingState: owner, consecutiveHealthFailures: 2 });
          writeWorkerProcessingStatus({ state: 'ready' }, owner.prepareChild());
          let reject!: (e: Error) => void;
          (h.engine as unknown as { executeRaw: () => Promise<unknown> }).executeRaw = () => new Promise((_r, rej) => { reject = rej; });
          const tick = h.sup._healthCheckOnceForTests();
          owner.block('postgres_cancellation_unavailable');
          reject(new Error('connection terminated'));
          await tick;
          expect(h.state.reconnects).toBe(0);
          expect(h.health()).toEqual([]);
        } finally {
          owner.close();
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
