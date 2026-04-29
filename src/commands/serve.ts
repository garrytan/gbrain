import type { BrainEngine } from '../core/engine.ts';
import { startMcpServer } from '../mcp/server.ts';
import { startHttpTransport } from '../mcp/http-transport.ts';

export async function runServe(engine: BrainEngine, args: string[] = []) {
  const useHttp = args.includes('--http');
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1]) || 8787 : 8787;

  if (useHttp) {
    console.error(`Starting GBrain MCP server (HTTP on port ${port})...`);
    await startHttpTransport({ port, engine });
    // Keep alive
    await new Promise(() => {});
  } else {
    console.error('Starting GBrain MCP server (stdio)...');
    await startMcpServer(engine);
  }
}
