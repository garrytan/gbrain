/**
 * /health on a startup-degraded legacy HTTP transport (db-availability 4c).
 *
 * When serve boots with the degraded engine, the /health handler must report
 * the CLASSIFIED state ({status:'degraded', db:'unreachable', reason:<...>},
 * HTTP 503) WITHOUT touching the engine — a health poller hitting the
 * endpoint every few seconds must never consume (or storm) the one lazy
 * single-flight reconnect attempt. The reconnect callback here throws, so a
 * zero-attempt counter is the proof of no-touch.
 *
 * In-process Bun.serve via startHttpTransport (the test/http-transport.test.ts
 * pattern) — no subprocess, no real DB.
 */

import { describe, test, expect, afterAll } from 'bun:test';

import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { createDegradedEngine } from '../src/core/degraded-engine.ts';

let stopServer: (() => void) | null = null;

afterAll(() => {
  stopServer?.();
});

describe('/health while startup-degraded', () => {
  test('503 degraded envelope with the classified reason; engine never touched', async () => {
    let attempts = 0;
    const initial = new Error('connect ECONNREFUSED 127.0.0.1:5432') as Error & { code: string };
    initial.code = 'ECONNREFUSED';
    const engine = createDegradedEngine({
      initialError: initial,
      reconnect: async () => {
        attempts++;
        throw new Error('reconnect must never fire from /health');
      },
      minIntervalMs: 0,
      now: () => Date.now(),
    });

    const server = await startHttpTransport({ port: 0, engine });
    stopServer = () => (server as { stop: (force?: boolean) => void }).stop(true);
    const port = (server as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('unreachable');
    expect(body.transport).toBe('http');
    // Classified via pg-access-classify against the STORED startup error.
    expect(body.reason).toBe('conn_refused');
    // Redaction sweep: no raw connect detail leaks through the unauthenticated
    // health endpoint.
    expect(JSON.stringify(body)).not.toContain('127.0.0.1:5432');

    // A second poll is just as free — still zero reconnect attempts.
    const res2 = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res2.status).toBe(503);
    expect(attempts).toBe(0);
  });
});
