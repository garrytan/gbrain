/**
 * #6589: DB-plane eval settings must reach actual HTTP operation dispatch.
 * A file-only context loses capture opt-in and scrub opt-out. Config-loader
 * unit tests do not exercise either transport. Real PGLite, authenticated
 * HTTP and stored eval rows need no new production seam or provider calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { awaitPendingEvalCaptures } from '../src/core/eval-capture.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await awaitPendingEvalCaptures();
  await engine.disconnect();
});

for (const transport of ['oauth-app', 'bearer'] as const) {
  describe(`${transport} operation config`, () => {
    for (const scenario of ['db-enabled', 'file-disabled', 'db-disabled'] as const) {
      test(scenario, async () => {
        const home = mkdtempSync(join(tmpdir(), 'gbrain-http-config-'));
        mkdirSync(join(home, '.gbrain'));
        writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
          engine: 'pglite', ...(scenario === 'file-disabled' ? { eval: { capture: false } } : {}),
        }));
        try {
          await withEnv({ GBRAIN_HOME: home, GBRAIN_CONTRIBUTOR_MODE: scenario === 'db-disabled' ? '1' : undefined }, async () => {
            let close: (() => Promise<void>) | undefined;
            try {
              await engine.executeRaw('DELETE FROM eval_candidates');
              await engine.setConfig('eval.capture', scenario === 'db-disabled' ? 'false' : 'true');
              await engine.setConfig('eval.scrub_pii', 'false');
              const { token } = await mintLegacyToken(engine, { name: 'http-config-fixture', scopes: ['read'], takesHolders: ['world'] });
              let base: string;
              if (transport === 'oauth-app') {
                const app = express();
                const server = app.listen(0, '127.0.0.1');
                await new Promise<void>(resolve => server.once('listening', resolve));
                const address = server.address();
                if (!address || typeof address === 'string') throw new Error('TCP address missing');
                base = `http://127.0.0.1:${address.port}`;
                close = () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
                await buildServeHttpApp(app, engine, { port: address.port, tokenTtl: 3600, enableDcr: false, publicUrl: base });
              } else {
                const server = await startHttpTransport({ port: 0, engine });
                base = `http://127.0.0.1:${server.port}`;
                close = async () => { await server.stop(true); };
              }
              const query = 'fixture@example.test';
              const res = await fetch(`${base}/mcp`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query } } }),
              });
              expect(res.status).toBe(200);
              const text = await res.text();
              const data = text.split('\n').find(line => line.startsWith('data:'));
              const rpc = JSON.parse(data ? data.slice(5) : text);
              expect(rpc.error).toBeUndefined();
              expect(rpc.result.isError).not.toBe(true);
              expect((await awaitPendingEvalCaptures()).unfinished).toBe(0);
              const rows = await engine.executeRaw<{ query: string }>('SELECT query FROM eval_candidates');
              expect(rows).toEqual(scenario === 'db-enabled' ? [{ query }] : []);
            } finally {
              await close?.();
              await awaitPendingEvalCaptures();
            }
          });
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }, 120_000);
    }
  });
}
