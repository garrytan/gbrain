/**
 * #9484: a POST /mcp refused at bearer auth is not serve activity.
 *
 * 1. Protects: `gbrain serve --http` runs idle upkeep only after a full quiet
 *    interval with no foreground request. A POST /mcp with no bearer token or a
 *    wrong one (401) never marks foreground activity, so anyone who can reach
 *    the port cannot hold upkeep off; an authenticated POST /mcp still counts.
 * 2. Fails when: the foreground mark runs before the bearer check (every POST
 *    /mcp counted, refused or not), or an authenticated request stops counting.
 * 3. Existing coverage: test/serve-idle-upkeep-gbra438.test.ts pins the
 *    middleware's POST/GET split and the idle tick itself.
 * 4. Real seams: the production serve-http app on a loopback port over a
 *    repo-less PGLite brain, real fetch, the real foreground-activity window.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { _resetForegroundActivityForTests, foregroundWindow, onForegroundRequest } from '../src/core/foreground-activity.ts';
import { legacyToken, rpc, startServeHttp, type LiveServeHttp } from './helpers/live-mcp-servers.ts';

describe('serve --http: a 401 on POST /mcp is not foreground activity (#9484)', () => {
  let engine: PGLiteEngine;
  let app: LiveServeHttp;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    app = await startServeHttp(engine);
  }, 120_000);
  afterAll(async () => { await app.close(); await engine.disconnect(); }, 60_000);
  beforeEach(() => { _resetForegroundActivityForTests(); });

  const post = (authorization?: string) => fetch(`${app.base}/mcp`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(authorization ? { Authorization: authorization } : {}) },
  });

  test('missing, wrong and malformed bearer tokens are refused 401 and mark no activity', async () => {
    let starts = 0;
    onForegroundRequest(() => { starts++; });
    const window = foregroundWindow();
    const statuses: number[] = [];
    for (const authorization of [undefined, 'Bearer not-a-real-token', 'Bearer gbrain_0000000000000000', 'Basic YWxpY2UtZXhhbXBsZTpwdw==']) {
      const res = await post(authorization);
      await res.text();
      statuses.push(res.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401]);
    expect({ starts, active: window() }).toEqual({ starts: 0, active: false });
  }, 60_000);

  test('an authenticated POST /mcp still marks activity', async () => {
    let starts = 0;
    onForegroundRequest(() => { starts++; });
    const window = foregroundWindow();
    const token = await legacyToken(engine, ['read']);
    expect((await rpc(app.base, token, 'tools/list')).status).toBe(200);
    expect({ starts, active: window() }).toEqual({ starts: 1, active: true });
  }, 60_000);
});
