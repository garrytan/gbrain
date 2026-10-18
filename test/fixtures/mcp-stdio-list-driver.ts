// Real stdio MCP server on an in-memory PGLite brain, for
// test/mcp-tool-list-snapshot.test.ts. SNAP_EAGER=1 swaps the generated
// operation manifest for the live registry (src/core/operations.ts, handlers
// included), so the same server code runs on the eager path it replaced.
// SNAP_SURFACE / SNAP_ACCESS map to startMcpServer's surface / access.
import { plugin } from 'bun';

if (process.env.SNAP_EAGER === '1') {
  plugin({
    name: 'eager-operation-registry',
    setup(build) {
      build.onLoad({ filter: /operation-manifest\.generated\.ts$/ }, () => ({
        contents: "export { operations as OPERATION_MANIFEST } from './operations.ts';",
        loader: 'ts',
      }));
    },
  });
}

// The PGLite schema snapshot's embedding shape, so an in-memory boot restores it.
const { configureGateway } = await import('../../src/core/ai/gateway.ts');
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { startMcpServer } = await import('../../src/mcp/server.ts');
const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
const surface = process.env.SNAP_SURFACE as 'verbs' | 'starter' | 'full' | undefined;
await startMcpServer(engine, {
  ...(surface ? { surface } : {}),
  ...(process.env.SNAP_ACCESS === 'read-only' ? { access: 'read-only' as const } : {}),
});
