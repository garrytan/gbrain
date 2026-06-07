/**
 * #1720 — autopilot reconnect helper.
 *
 * The daemon crash-looped against the Supabase pooler because its DB-health
 * catch hand-rolled `await engine.disconnect(); await engine.connect?.();`.
 * The argless `connect()` dereferenced an undefined config
 * (`const url = config.database_url`), threw the TypeError
 * "undefined is not an object (evaluating 'config.database_url')", which the
 * reconnect classifier then read as a fatal missing-config error → process
 * exit → launchd respawn → pooler drops again → loop. ~25k CONNECTION_CLOSED
 * events, brain degraded for days.
 *
 * reconnectAndProbe() fixes the root cause:
 *   - routes through the engine's own reconnect() (PostgresEngine reuses its
 *     saved config + tears down/rebuilds the instance pool with audit logging),
 *   - rethrows the original probe error for engines without reconnect()
 *     (PGLite / inline) instead of crashing on an argless connect(),
 *   - re-probes health AFTER reconnect so a silent no-op reconnect (e.g. a
 *     concurrent reconnect already in flight) surfaces as a throw and the
 *     caller does NOT falsely reset its failure counter.
 */
import { describe, test, expect } from 'bun:test';
import { reconnectAndProbe } from '../src/commands/autopilot.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function fakeEngine(overrides: Record<string, unknown>): BrainEngine {
  return {
    connect: async () => {},
    disconnect: async () => {},
    initSchema: async () => {},
    getConfig: async () => 'ok',
    ...overrides,
  } as unknown as BrainEngine;
}

describe('reconnectAndProbe (#1720)', () => {
  test('Postgres-style engine: calls reconnect({error}) then re-probes health', async () => {
    const calls: string[] = [];
    let reconnectArg: unknown;
    const engine = fakeEngine({
      reconnect: async (ctx: unknown) => { calls.push('reconnect'); reconnectArg = ctx; },
      getConfig: async () => { calls.push('getConfig'); return 'ok'; },
    });
    const probeErr = new Error('write CONNECTION_CLOSED');
    await reconnectAndProbe(engine, probeErr);
    // reconnect first, THEN a health re-probe to prove the connection is live.
    expect(calls).toEqual(['reconnect', 'getConfig']);
    // The probe error is threaded into reconnect() so its audit layer can
    // classify reap-vs-other.
    expect(reconnectArg).toEqual({ error: probeErr });
  });

  test('never calls argless connect() (the #1720 crash path)', async () => {
    let connectInvoked = false;
    const engine = fakeEngine({
      reconnect: async () => {},
      connect: async () => { connectInvoked = true; },
    });
    await reconnectAndProbe(engine, new Error('blip'));
    expect(connectInvoked).toBe(false);
  });

  test('engine without reconnect() (PGLite): rethrows the probe error, never argless-connects', async () => {
    let connectInvoked = false;
    const engine = fakeEngine({
      reconnect: undefined,
      connect: async () => { connectInvoked = true; },
    });
    const probeErr = new Error('pglite probe failed');
    await expect(reconnectAndProbe(engine, probeErr)).rejects.toThrow('pglite probe failed');
    expect(connectInvoked).toBe(false);
  });

  test('silent no-op reconnect with DB still dead: re-probe throws so caller will NOT reset its counter', async () => {
    const engine = fakeEngine({
      reconnect: async () => { /* no-op: a concurrent reconnect was already in flight */ },
      getConfig: async () => { throw new Error('write CONNECTION_CLOSED'); },
    });
    await expect(reconnectAndProbe(engine, new Error('blip'))).rejects.toThrow('CONNECTION_CLOSED');
  });
});
