import type { BrainEngine } from '../core/engine.ts';
import { startMcpServer } from '../mcp/server.ts';

export async function runServe(engine: BrainEngine, args: string[] = []) {
  // v0.26+: --http dispatches to the full OAuth 2.1 server (serve-http.ts)
  // with admin dashboard, scope enforcement, SSE feed, and the requireBearerAuth
  // middleware. Master's simpler startHttpTransport from v0.22.7 is superseded
  // — the OAuth provider in serve-http.ts handles bearer auth via
  // verifyAccessToken with legacy access_tokens fallback (so v0.22.7 callers
  // that used `gbrain auth create` keep working unchanged).
  const isHttp = args.includes('--http');

  if (isHttp) {
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? parseInt(args[portIdx + 1]) || 3131 : 3131;

    const ttlIdx = args.indexOf('--token-ttl');
    const tokenTtl = ttlIdx >= 0 ? parseInt(args[ttlIdx + 1]) || 3600 : 3600;

    const enableDcr = args.includes('--enable-dcr');

    const publicUrlIdx = args.indexOf('--public-url');
    const publicUrl = publicUrlIdx >= 0 ? args[publicUrlIdx + 1] : undefined;

    const { runServeHttp } = await import('./serve-http.ts');
    await runServeHttp(engine, { port, tokenTtl, enableDcr, publicUrl });
  } else {
    console.error('Starting GBrain MCP server (stdio)...');

    let shuttingDown = false;
    let parentWatchdog: ReturnType<typeof setInterval> | undefined;

    const shutdown = async (reason: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (parentWatchdog) clearInterval(parentWatchdog);
      console.error(`GBrain MCP server shutting down (${reason})...`);
      try {
        await engine.disconnect();
      } catch (err) {
        console.error('GBrain MCP server cleanup failed:', err);
      }
      process.exit(0);
    };

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => void shutdown(signal));
    }

    // MCP stdio clients should close stdin when the session ends. Bun processes
    // observed under launch/CLI clients can otherwise become PPID=1 orphans and
    // keep the PGLite lock forever, blocking all future GBrain MCP starts.
    process.stdin.once('end', () => void shutdown('stdin:end'));
    process.stdin.once('close', () => void shutdown('stdin:close'));

    const initialParentPid = process.ppid;
    parentWatchdog = setInterval(() => {
      if (initialParentPid !== 1 && process.ppid === 1) {
        void shutdown('parent exited');
      }
    }, 5000);
    parentWatchdog.unref?.();

    await startMcpServer(engine);
    console.error('GBrain MCP server ready.');

    // Keep process ownership explicit: shutdown paths above release the engine
    // and PGLite lock instead of relying on implicit process teardown.
    await new Promise<void>(() => {});
  }
}
