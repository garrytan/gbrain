import { describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { mountHealth } from '../src/commands/serve-http-metrics.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { attachHostedHttpGuards, type HostedHttpGuards } from '../src/core/http-hosted-guards.ts';
import { HttpInflightGate, HttpPipelineWatchdog, resolveHttpWatchdogConfig } from '../src/core/http-pipeline-watchdog.ts';

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') { reject(new Error('no port')); return; }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res, rej) => server.close(err => err ? rej(err) : res())),
      });
    });
  });
}

function appWith(opts: { deep: boolean; wedged: boolean; queries: string[] }) {
  let t = 0;
  const config = resolveHttpWatchdogConfig({
    GBRAIN_HTTP_WATCHDOG_MS: '1000',
    GBRAIN_HTTP_WATCHDOG_HEARTBEAT_MS: '0',
    GBRAIN_HTTP_WATCHDOG_MIN_INFLIGHT: '2',
    GBRAIN_HTTP_HEALTH_DEEP: opts.deep ? '1' : undefined,
  }, () => {});
  const watchdog = new HttpPipelineWatchdog(config, () => t);
  if (opts.wedged) {
    watchdog.begin();
    watchdog.begin();
    t = 5_000;
  }
  const engine = {
    executeRaw: async (sql: string) => {
      opts.queries.push(sql);
      return [{ '?column?': 1 }];
    },
  };
  const ctx = { engine, config: { engine: 'pglite' } } as unknown as ServeHttpContext;
  const guards: HostedHttpGuards = {
    config,
    watchdog,
    gate: new HttpInflightGate(0, 0),
    arm: () => () => {},
    readyLine: () => '',
  };
  attachHostedHttpGuards(ctx, guards);
  const app = express();
  mountHealth(app, ctx);
  return app;
}

describe('GET /health and GET /ready', () => {
  test('/health stays a SELECT 1 even when the pipeline is wedged', async () => {
    const queries: string[] = [];
    const app = appWith({ deep: false, wedged: true, queries });
    const server = await listen(app);
    try {
      const health = await fetch(`${server.url}/health?deep=1`);
      const body = await health.json() as { status?: string; error?: string };
      expect(health.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(queries).toEqual(['SELECT 1']);
      const ready = await fetch(`${server.url}/ready`);
      const readyBody = await ready.json() as { status: string; reason: string };
      expect(ready.status).toBe(503);
      expect(readyBody.status).toBe('not_ready');
      expect(readyBody.reason).toBe('pipeline_wedged');
      expect(queries).toEqual(['SELECT 1']);
    } finally {
      await server.close();
    }
  });

  test('/health?deep=1 returns 503 without a query when deep health is enabled and wedged', async () => {
    const queries: string[] = [];
    const app = appWith({ deep: true, wedged: true, queries });
    const server = await listen(app);
    try {
      const health = await fetch(`${server.url}/health?deep=1`);
      const body = await health.json() as { status: string; reason: string };
      expect(health.status).toBe(503);
      expect(body.reason).toBe('pipeline_wedged');
      expect(queries).toEqual([]);
      const plain = await fetch(`${server.url}/health`);
      expect(plain.status).toBe(200);
      expect(queries).toEqual(['SELECT 1']);
    } finally {
      await server.close();
    }
  });

  test('/ready is 200 when nothing is wedged and does not query', async () => {
    const queries: string[] = [];
    const app = appWith({ deep: false, wedged: false, queries });
    const server = await listen(app);
    try {
      const ready = await fetch(`${server.url}/ready`);
      const body = await ready.json() as { status: string; engine: string };
      expect(ready.status).toBe(200);
      expect(body.status).toBe('ready');
      expect(body.engine).toBe('pglite');
      expect(queries).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
