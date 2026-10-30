/**
 * Warm CLI socket context parity: the serve builds the CLI's OperationContext
 * (src/core/cli-socket/execute.ts cliRequestContext) from the caller's
 * GBRAIN_SOURCE and cwd, mirroring makeContext in src/cli/main.ts.
 *
 * 1. Protects: a warm search/query/get resolves the same source, tier-derived
 *    scope (implicit flag, federated set) and trust (remote: false) as the cold
 *    CLI, and the serve's own GBRAIN_SOURCE never leaks into a CLI request.
 * 2. Fails when: makeContext gains or changes a field the mirror lacks, or the
 *    mirror reads process.env instead of the caller's routing.
 * 3. The E2E compares printed bytes for one routing; this pins every tier,
 *    plus the serve-side timeout answer.
 * 4. No production seam.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { makeContext } from '../src/cli/main.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { cliRequestContext, executeCliSocketRequest, mergedRequestConfig } from '../src/core/cli-socket/execute.ts';
import { cliSocketIdentity } from '../src/core/cli-socket/identity.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { serializeOperationError, warmRoundTripTimeout } from '../src/core/cli-socket/protocol.ts';
import { _uninstallOutputCaptureForTests, installOutputCapture } from '../src/core/cli-socket/output-capture.ts';

let engine: PGLiteEngine;
const op = { params: {} };
const noop = { emitResponseMeta: () => {}, emitNotice: () => {} };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); });
afterEach(() => _uninstallOutputCaptureForTests());

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES
       ('source-a', 'source-a', $1, '{"federated": true}'::jsonb),
       ('source-b', 'source-b', NULL, '{"federated": true}'::jsonb)`, [process.cwd()]);
});

function comparable(ctx: Record<string, unknown>): Record<string, unknown> {
  const { engine: _e, logger: _l, emitResponseMeta: _m, emitNotice: _n, cliOpts: _c, brainId: _b, writeWaitMs: _w, ...rest } = ctx;
  return { keys: Object.keys(ctx).sort(), ...rest };
}

async function both(callerEnv: string | undefined, params: Record<string, unknown> = {}) {
  const cold = await withEnv({ GBRAIN_SOURCE: callerEnv }, () => makeContext(engine, params, op));
  // The serve runs with its own (different) GBRAIN_SOURCE; the caller's must win.
  const warm = await withEnv({ GBRAIN_SOURCE: 'source-b' }, async () => cliRequestContext(engine, params, op,
    { routing: { cwd: process.cwd(), source_env: callerEnv ?? null }, cli: { quiet: false, timeout_ms: null } },
    await mergedRequestConfig(engine), noop));
  return { cold: comparable(cold as unknown as Record<string, unknown>), warm: comparable(warm as unknown as Record<string, unknown>) };
}

describe('cliRequestContext mirrors makeContext', () => {
  test('registered-path tier (implicit, federated set)', async () => {
    const { cold, warm } = await both(undefined);
    expect(cold.sourceId).toBe('source-a');
    expect(cold.localSourceImplicit).toBe(true);
    expect(cold.localFederatedSourceIds).toEqual(expect.arrayContaining(['source-a', 'source-b']));
    expect(warm).toEqual(cold);
  });

  test('caller GBRAIN_SOURCE tier, not the serve\'s', async () => {
    const { cold, warm } = await both('default');
    expect(cold.sourceId).toBe('default');
    expect(cold.localSourceImplicit).toBeUndefined();
    expect(warm).toEqual(cold);
  });

  test('a serve-side timeout answers a retryable timeout error (no cold rerun) while the work keeps the request active until it settles', async () => {
    // Config reads and SQL wait on a gate, so the request is still working when its deadline passes. A bare short
    // deadline is not enough: PGLite can finish the whole search before the timer gets a turn (stress gate, seed
    // 193478). The capture is installed as the serve installs it (process-global, so an earlier test in the same
    // process may already have done it), and with SQL gated the source resolution cannot finish first: the
    // timeout frame carries no resolved source whatever ran before this test.
    installOutputCapture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const gated = new Proxy(engine, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'getConfig' || key === 'getAllConfig' || key === 'executeRaw') return async (...args: unknown[]) => { await gate; return (value as (...a: unknown[]) => unknown).apply(target, args); };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { frame, settled } = await executeCliSocketRequest(gated, { v: 1, identity: cliSocketIdentity({ config: { engine: 'postgres' }, brainId: 'host', configDir: '/nonexistent', configFile: '/nonexistent/config.json', version: 'x', env: {} }), command: 'search', kind: 'op', op: 'search', params: { query: 'alpha' },
      routing: { cwd: process.cwd(), source_env: null }, cli: { quiet: false, timeout_ms: 5 } });
    let done = false;
    void settled.then(() => { done = true; });
    expect(frame).toEqual({ v: 1, kind: 'error', error: serializeOperationError(warmRoundTripTimeout('search', 5, 'serve')), output: [], source: null });
    await Bun.sleep(20);
    expect(done).toBe(false);
    release();
    await settled;
    expect(done).toBe(true);
  });

  test('explicit --source', async () => {
    const { cold, warm } = await both(undefined, { source: 'source-b' });
    expect(cold.sourceId).toBe('source-b');
    expect(warm).toEqual(cold);
  });
});
