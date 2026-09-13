/** Isolated HTTP server for consent integration tests; never opens a user's brain. */
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runServeHttp } from '../../src/commands/serve-http.ts';

const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
try {
  await runServeHttp(engine, {
    port: Number(process.env.GBRAIN_TEST_HTTP_PORT), tokenTtl: 3600,
    enableDcr: true, bind: '127.0.0.1',
  });
} finally { await engine.disconnect(); }
