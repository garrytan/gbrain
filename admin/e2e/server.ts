/** Launched only by the browser fixture, from a temporary cwd with an isolated home. */
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runServeHttp } from '../../src/commands/serve-http.ts';

if (!process.env.GBRAIN_TEST_HTTP_PUBLIC_URL || !process.env.GBRAIN_TEST_HTTP_PORT) throw new Error('Browser fixture requires an explicit loopback endpoint');
const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
// A second source, so the first-consent source picker (#6202) has a real choice.
await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('wiki-example', 'wiki-example') ON CONFLICT (id) DO NOTHING`);
try {
  await runServeHttp(engine, { port: Number(process.env.GBRAIN_TEST_HTTP_PORT), publicUrl: process.env.GBRAIN_TEST_HTTP_PUBLIC_URL,
    tokenTtl: 3600, enableDcr: true, bind: '127.0.0.1' });
} finally { await engine.disconnect(); }
