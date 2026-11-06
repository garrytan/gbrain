// Real stdio MCP server on an in-memory PGLite brain whose statements are held and depth-recorded
// (test/helpers/statement-depth.ts), for test/serve-request-round-trips.test.ts. Each statement is
// appended to ROUND_TRIP_LOG as one JSON line. One registered non-default source (source-a, under the cwd's
// child directory) with an empty 'default', so an unbound call resolves through tier 5.5 like the trace.
//
// Each stdin chunk is handled inside an AsyncLocalStorage scope named by the JSON-RPC id it carries, so every
// statement records the request that sent it (`scope`, null for the server's own background work such as the
// resident persistence consumer's ticks) and its depth counts only that request's round trips.
// ROUND_TRIP_INTERLEAVE=<id> sends one background statement while that request's config snapshot read is in
// flight, the interleaving a resident tick produces by chance.
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const { configureGateway } = await import('../../src/core/ai/gateway.ts');
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { startMcpServer } = await import('../../src/mcp/server.ts');
const { recordStatementDepth } = await import('../helpers/statement-depth.ts');
const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
const side = join(process.cwd(), 'source-a-example');
mkdirSync(side, { recursive: true });
await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('source-a', 'source-a', $1, '{"federated": true}'::jsonb)`, [side]);
const log = process.env.ROUND_TRIP_LOG!;
const interleave = process.env.ROUND_TRIP_INTERLEAVE ? Number(process.env.ROUND_TRIP_INTERLEAVE) : null;
const request = new AsyncLocalStorage<number>();
const emit = process.stdin.emit.bind(process.stdin) as (event: string | symbol, ...args: unknown[]) => boolean;
process.stdin.emit = ((event: string | symbol, ...args: unknown[]) => {
  const id = event === 'data' ? /"id":(\d+)/.exec(String(args[0]))?.[1] : undefined;
  return id === undefined ? emit(event, ...args) : request.run(Number(id), () => emit(event, ...args));
}) as typeof process.stdin.emit;
let interleaved = false;
recordStatementDepth(engine, {
  scope: () => request.getStore() ?? null,
  onRecord: record => {
    appendFileSync(log, JSON.stringify(record) + '\n');
    if (interleave === null || interleaved || record.scope !== interleave || !/^SELECT key, value FROM config$/.test(record.sql)) return;
    interleaved = true;
    request.exit(() => setTimeout(() => { void engine.executeRaw('SELECT count(*)::int AS n FROM page_projection_jobs'); }, 0));
  },
});
await startMcpServer(engine, {});
