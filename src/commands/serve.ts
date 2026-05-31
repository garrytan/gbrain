import type { BrainEngine } from '../core/engine.ts';
import { startMcpServer } from '../mcp/server.ts';
import { startMcpHttpServer } from '../mcp/http-server.ts';
import { loadConfig } from '../core/config.ts';
import { DEFAULT_RUNTIME_CONFIG } from '../core/engine-factory.ts';

export async function runServe(engine: BrainEngine | Promise<BrainEngine>, args: string[] = []) {
  const http = args.includes('--http');
  const host = parseStringFlag(args, '--host') ?? process.env.MBRAIN_HTTP_HOST ?? '127.0.0.1';
  const port = parseNumberFlag(args, '--port') ?? parseEnvPort() ?? 8787;

  if (http) {
    const config = loadConfig() ?? DEFAULT_RUNTIME_CONFIG;
    const server = startMcpHttpServer({
      engine,
      config,
      host,
      port,
    });
    console.error(`Starting MBrain MCP server (HTTP) on http://${server.hostname}:${server.port}`);
    await new Promise(() => undefined);
    return;
  }

  console.error('Starting MBrain MCP server (stdio)...');
  await startMcpServer(engine);
}

function parseStringFlag(args: string[], flag: string): string | undefined {
  const equalsArg = args.find(arg => arg.startsWith(`${flag}=`));
  if (equalsArg) return equalsArg.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function parseNumberFlag(args: string[], flag: string): number | undefined {
  const raw = parseStringFlag(args, flag);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function parseEnvPort(): number | undefined {
  const raw = process.env.MBRAIN_HTTP_PORT;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
