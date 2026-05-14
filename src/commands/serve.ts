import type { BrainEngine } from '../core/engine.ts';
import { startMcpServer } from '../mcp/server.ts';

export async function runServe(engine: BrainEngine | Promise<BrainEngine>) {
  console.error('Starting MBrain MCP server (stdio)...');
  await startMcpServer(engine);
}
