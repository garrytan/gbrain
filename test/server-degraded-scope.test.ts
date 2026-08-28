/**
 * Degraded-serve MCP surfaces (db-availability 4c) — the two engine-FREE
 * short-circuits in src/mcp/server.ts that must never touch a degraded
 * engine (each touch would burn the single-flight lazy reconnect attempt
 * and stall the client handshake behind the caller-wait cap):
 *
 *   - stdioVisibleTools: fail-closed gate subtraction WITHOUT the
 *     engine.getConfig gate read — every publishGateKey op is hidden,
 *     ungated ops pass through, and the reconnect callback never fires.
 *   - resolveMcpStdioSourceScope: the degraded branch honors a WELL-FORMED
 *     GBRAIN_SOURCE binding (tier 'env'), falls back to seed_default when
 *     unset, and REFUSES to launder a format-invalid value into tier 'env'
 *     (malformed → seed_default keeps --source-guard fail-closed).
 *
 * The degraded engine is the real createDegradedEngine wrapper with a
 * reconnect that would blow up the test if invoked — a zero-touch proof.
 */

import { describe, test, expect } from 'bun:test';

import { createDegradedEngine } from '../src/core/degraded-engine.ts';
import { resolveMcpStdioSourceScope, stdioVisibleTools } from '../src/mcp/server.ts';
import type { Operation } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

function connRefused(): Error {
  const e = new Error('connect ECONNREFUSED 127.0.0.1:5432') as Error & { code: string };
  e.code = 'ECONNREFUSED';
  return e;
}

/** Degraded engine + a counter proving reconnect was NEVER attempted. */
function degradedFixture(): { engine: ReturnType<typeof createDegradedEngine>; attempts: () => number } {
  let attempts = 0;
  const engine = createDegradedEngine({
    initialError: connRefused(),
    reconnect: async () => {
      attempts++;
      throw new Error('reconnect must never be invoked by engine-free surfaces');
    },
    minIntervalMs: 0,
    now: () => Date.now(),
  });
  return { engine, attempts: () => attempts };
}

describe('stdioVisibleTools on a degraded engine', () => {
  test('hides every publishGateKey op, keeps ungated ops, never touches the engine', async () => {
    const { engine, attempts } = degradedFixture();
    const surfacedOps = [
      { name: 'gated_op', publishGateKey: 'mcp.publish_skills' },
      { name: 'plain_op' },
    ] as unknown as Operation[];

    const visible = await stdioVisibleTools(engine, surfacedOps);

    expect(visible.map((op) => op.name)).toEqual(['plain_op']);
    // Zero-touch: the fail-closed subtraction ran without a gate read, so
    // the single-flight reconnect attempt was never consumed.
    expect(attempts()).toBe(0);
  });
});

describe('resolveMcpStdioSourceScope degraded branch', () => {
  test('honors a validated GBRAIN_SOURCE binding as tier env', async () => {
    const { engine, attempts } = degradedFixture();
    await withEnv({ GBRAIN_SOURCE: 'my-source' }, async () => {
      const scope = await resolveMcpStdioSourceScope(engine);
      expect(scope).toEqual({ sourceId: 'my-source', tier: 'env' });
    });
    expect(attempts()).toBe(0);
  });

  test('GBRAIN_SOURCE unset → seed_default fallback (fail-closed for --source-guard)', async () => {
    const { engine, attempts } = degradedFixture();
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const scope = await resolveMcpStdioSourceScope(engine);
      expect(scope).toEqual({ sourceId: 'default', tier: 'seed_default' });
    });
    expect(attempts()).toBe(0);
  });

  test('format-INVALID GBRAIN_SOURCE is never laundered into tier env → seed_default', async () => {
    const { engine, attempts } = degradedFixture();
    await withEnv({ GBRAIN_SOURCE: 'BAD source!!' }, async () => {
      const scope = await resolveMcpStdioSourceScope(engine);
      expect(scope).toEqual({ sourceId: 'default', tier: 'seed_default' });
    });
    expect(attempts()).toBe(0);
  });
});
