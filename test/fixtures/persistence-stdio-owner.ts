// Real stdio MCP owner used by the pre-connect CLI integration test.
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { loadConfig } from '../../src/core/config.ts';
import { startMcpServer } from '../../src/mcp/server.ts';
const config=loadConfig();
if(!config?.database_path)throw new Error('The isolated owner requires its selected datastore.');
const engine=new PGLiteEngine();
await engine.connect(config);
await engine.initSchema();
await startMcpServer(engine,{sourceGuard:false});
