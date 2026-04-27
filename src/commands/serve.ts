import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BrainEngine } from '../core/engine.ts';
import { startMcpServer } from '../mcp/server.ts';
import { MinionQueue } from '../core/minions/queue.ts';

const STATUS_PORT = parseInt(process.env.GBRAIN_STATUS_PORT || '0', 10);

/**
 * Lightweight HTTP sidecar for status queries.
 *
 * Runs alongside the stdio MCP server so external tools (dashboards, CLIs)
 * can query job state without fighting for the PGLite lock.
 *
 * Enable by setting GBRAIN_STATUS_PORT (e.g. 18900).
 * Endpoints:
 *   GET /jobs         — list recent jobs (JSON)
 *   GET /jobs/:id     — single job detail (JSON)
 *   GET /stats        — job queue stats (JSON)
 *   GET /health       — basic health check
 */
function startStatusServer(engine: BrainEngine, port: number) {
  const queue = new MinionQueue(engine);

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    res.setHeader('Content-Type', 'application/json');

    try {
      if (url.pathname === '/health') {
        res.end(JSON.stringify({ ok: true, service: 'gbrain-status' }));
        return;
      }

      await queue.ensureSchema();

      if (url.pathname === '/jobs') {
        const status = url.searchParams.get('status') as any;
        const queueName = url.searchParams.get('queue') || undefined;
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        const jobs = await queue.getJobs({ status, queue: queueName, limit });
        res.end(JSON.stringify(jobs));
        return;
      }

      const jobMatch = url.pathname.match(/^\/jobs\/(\d+)$/);
      if (jobMatch) {
        const job = await queue.getJob(parseInt(jobMatch[1], 10));
        if (!job) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return; }
        res.end(JSON.stringify(job));
        return;
      }

      if (url.pathname === '/stats') {
        const stats = await queue.getStats();
        res.end(JSON.stringify(stats));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const server = createServer(handler);
  server.listen(port, '127.0.0.1', () => {
    console.error(`[gbrain] Status API listening on http://127.0.0.1:${port}`);
  });
}

export async function runServe(engine: BrainEngine) {
  console.error('Starting GBrain MCP server (stdio)...');

  // Start status HTTP sidecar if port is configured
  if (STATUS_PORT > 0) {
    startStatusServer(engine, STATUS_PORT);
  }

  await startMcpServer(engine);
}
