/** Launched only by the browser fixture, from a temporary cwd with an isolated home. */
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runServeHttp } from '../../src/commands/serve-http.ts';

if (!process.env.GBRAIN_TEST_HTTP_PUBLIC_URL || !process.env.GBRAIN_TEST_HTTP_PORT) throw new Error('Browser fixture requires an explicit loopback endpoint');
const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
try {
  await runServeHttp(engine, { port: Number(process.env.GBRAIN_TEST_HTTP_PORT), publicUrl: process.env.GBRAIN_TEST_HTTP_PUBLIC_URL,
    tokenTtl: 3600, enableDcr: true, bind: '127.0.0.1' });
} finally { await engine.disconnect(); }
