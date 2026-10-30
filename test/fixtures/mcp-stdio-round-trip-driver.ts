// Real stdio MCP server on an in-memory PGLite brain whose statements are held and depth-recorded
// (test/helpers/statement-depth.ts), for test/serve-request-round-trips.test.ts. Each statement is
// appended to ROUND_TRIP_LOG as one JSON line. One registered non-default source (source-a, under the cwd's
// child directory) with an empty 'default', so an unbound call resolves through tier 5.5 like the trace.
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
recordStatementDepth(engine, { onRecord: record => appendFileSync(log, JSON.stringify(record) + '\n') });
await startMcpServer(engine, {});
