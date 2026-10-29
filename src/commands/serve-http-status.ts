/**
 * Status-only `gbrain serve --http` (agent operator contract v1): a shared
 * HTTP server whose brain cannot be opened (lock held, no brain, a missing or
 * repair-failed brain, unreadable config) stays up on its `--bind`/`--port`
 * and explains itself instead of exiting into a supervisor crash loop.
 *
 * One `node:http` listener whose request handler is a mutable reference:
 *   - `GET /health` → 503 with the allowlisted payload, `Retry-After: 5` and
 *     `instance` (the marker's nonce);
 *   - `POST /mcp` → a stateless MCP server with exactly `gbrain_status`;
 *     any other tool gets one `serve_status_only` error block;
 *   - everything else (OAuth discovery, `/token`, `/authorize`, `/register`,
 *     `/admin*`) → a 503 `serve_status_only` envelope.
 * Every response is unauthenticated (the bearer tokens live in the brain it
 * cannot open), so each one states the collapsed reason only.
 *
 * Recovery: a single-flight 5 s tick runs the shared re-probe; on a connect
 * the full app is built by `runServe` while the status handler keeps
 * answering, then `listenOrRefuse` swaps the handler on the same listener (no
 * close and rebind, so no port race). A full-app build that fails disconnects
 * the engine (releasing the lock) and keeps the status handler with reason
 * `brain_unopenable`. Shutdown during a recovery waits for it, then closes
 * once; only this instance's marker is removed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Server as McpServer, createMcpHandler, type ListToolsResult, type CallToolResult } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { BrainEngine } from '../core/engine.ts';
import { cliRenderContext, renderAction } from '../core/agent-output.ts';
import { registerCleanup } from '../core/process-cleanup.ts';
import { currentBrainId } from '../core/minions/worker-registry.ts';
import { removeStatusMarker, writeStatusMarker } from '../core/serve-http-status-marker.ts';
import {
  HTTP_STATUS_RETRY_AFTER_S, HTTP_STATUS_TOOL_DEF, STATUS_TOOL_NAME, httpStatusEnvelope, httpStatusPayload, initialStatusState,
  markStatusModeEngine, statusFix, statusHeadline, statusInstructionLine, statusModeErrorResult, statusToolResult, type StatusModeState,
} from '../mcp/status-mode.ts';
import { VERSION } from '../version.ts';
import { listenOrRefuse, type AdoptableServer, type HttpRequestHandler } from './serve-http-listen.ts';
import { logStatusTransition, statusReasonForError } from './serve-status.ts';

export const HTTP_STATUS_TICK_MS = HTTP_STATUS_RETRY_AFTER_S * 1000;

export interface HttpStatusServeDeps {
  tickMs?: number;
  log?: (msg: string) => void;
  /** Boots the full server on the adopted listener (default: serve.ts `runServe`). */
  runServe?: (engine: BrainEngine, args: string[], opts: { adoptServer: AdoptableServer }) => Promise<void>;
  exit?: (code: number) => void;
  /** Test seam: the running instance (its listener, nonce and shutdown). */
  onReady?: (handle: { server: Server; nonce: string; shutdown(): Promise<void> }) => void;
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': String(HTTP_STATUS_RETRY_AFTER_S), Connection: 'close' });
  res.end(JSON.stringify(body));
}

async function serveStatusMcp(state: StatusModeState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Dual-era status surface: the same one-tool factory answers 2025-era
  // `initialize` (stateless legacy fallback, the default posture) and the
  // modern per-request path, so a probing client of either era gets the
  // status envelope instead of a protocol error.
  const handler = createMcpHandler(async (): Promise<McpServer> => {
    const server = new McpServer({ name: 'gbrain', version: VERSION }, { capabilities: { tools: {} }, instructions: statusInstructionLine(state, 'http') });
    // gbrain builds v1-shaped tool defs and result blocks; v2 narrows
    // `inputSchema`/`content`, so the wire shapes are asserted at entry.
    server.setRequestHandler('tools/list', async (): Promise<ListToolsResult> => ({ tools: [HTTP_STATUS_TOOL_DEF] } as ListToolsResult));
    server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => (request.params.name === STATUS_TOOL_NAME
      ? statusToolResult(state, 'http') : statusModeErrorResult(state, request.params.name, 'http')) as CallToolResult);
    return server;
  });
  // The connector owns the per-request lifecycle; the adapter answers a
  // JSON-RPC 500 envelope on an internal throw, so probes never receive an
  // HTML error page.
  res.setHeader('Connection', 'close');
  await toNodeHandler(handler, { onerror: () => { /* status probes report through the envelope */ } })(req, res);
}

function statusHandler(state: StatusModeState, nonce: string): HttpRequestHandler {
  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health') return sendJson(res, 503, { ...httpStatusPayload(), instance: nonce });
    if (path === '/mcp' && req.method === 'POST') { void serveStatusMcp(state, req, res); return; }
    if (path === '/mcp' && req.method === 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, DELETE', Connection: 'close' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
      return;
    }
    sendJson(res, 503, httpStatusEnvelope());
  };
}

/** The human banner: the reason, the fix and how the daemon behaves. */
function banner(state: StatusModeState, where: string): string {
  const fix = renderAction(statusFix(state, 'http').fix, cliRenderContext());
  return [
    `GBrain MCP server: status-only mode on ${where} (the brain cannot be opened).`,
    `  Reason: ${statusHeadline(state)}`,
    `  Fix:    ${fix.command ?? fix.why}`,
    `  Re-checking every ${HTTP_STATUS_RETRY_AFTER_S} s; Ctrl-C to stop; --fail-fast to exit instead.`,
  ].join('\n');
}

/**
 * Serve the status listener until the brain opens (then the full server owns
 * the process) or shutdown. `probe` is the shared re-probe from
 * `runStatusModeServe`: null while blocked, an engine once connected.
 */
export async function runHttpStatusServe(
  state: StatusModeState, args: string[], probe: () => Promise<BrainEngine | null>, deps: HttpStatusServeDeps = {},
): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const tickMs = deps.tickMs ?? HTTP_STATUS_TICK_MS;
  const port = parseInt(argValue(args, '--port') ?? '', 10) || 3131;
  const bind = argValue(args, '--bind') ?? '127.0.0.1';
  const nonce = randomBytes(16).toString('hex');
  const enteredAt = Date.now();

  let handler: HttpRequestHandler = statusHandler(state, nonce);
  const dispatch: HttpRequestHandler = (req, res) => handler(req, res);
  const sockets = new Set<Socket>();
  const listen = (p: number, h: string) => createServer(dispatch)
    .on('connection', (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); })
    .listen(p, h);
  // A taken port (usually the HTTP serve that holds the brain) exits with serve_port_in_use.
  const server = await listenOrRefuse(Object.assign(dispatch, { listen }), port, bind);

  const marker = () => writeStatusMarker({ pid: process.pid, instance_nonce: nonce, brain_id: currentBrainId(), bind, port, reason: state.reason, since: new Date().toISOString() });
  marker();
  const dropMarker = () => removeStatusMarker(port, nonce);
  process.once('exit', dropMarker);
  log(banner(state, `http://${bind}:${port}`));

  let adopted = false;
  let stopping = false;
  let recovered: BrainEngine | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let settle!: (outcome: { error?: unknown }) => void;
  const done = new Promise<{ error?: unknown }>(resolve => { settle = resolve; });

  const backToStatus = async (engine: BrainEngine, e: unknown) => {
    await engine.disconnect().catch(() => {});
    if (stopping) return;
    Object.assign(state, initialStatusState('brain_unopenable'), { reason: 'brain_unopenable', recovered: false });
    marker();
    log(`GBrain MCP server: the brain opened but the full server did not start (${e instanceof Error ? e.message : String(e)}); the brain is released and this server stays in status-only mode.`);
    logStatusTransition('serve_status_mode_enter', state, 'http', enteredAt);
  };

  const recover = (engine: BrainEngine) => new Promise<void>((swapped) => {
    recovered = markStatusModeEngine(engine, state);
    const runServe = deps.runServe ?? (async (e, a, o) => (await import('./serve.ts')).runServe(e, a, o));
    const adoptServer: AdoptableServer = {
      server,
      adopt(next: HttpRequestHandler) {
        if (stopping) throw new Error('gbrain serve --http is shutting down');
        handler = next;
        adopted = true;
        // The full server's lifecycle owns SIGINT from here on.
        process.off('SIGINT', onSigint);
        dropMarker();
        log(`GBrain MCP server: the brain is open; the full server now answers on http://${bind}:${port}.`);
        swapped();
      },
    };
    runServe(engine, args, { adoptServer }).then(
      () => settle({}),
      async (e: unknown) => {
        if (adopted) return settle({ error: e });
        recovered = null;
        await backToStatus(engine, e);
        swapped();
      },
    );
  });

  const tick = async () => {
    const before = state.reason;
    let engine: BrainEngine | null;
    try {
      engine = await probe();
    } catch (e) {
      Object.assign(state, initialStatusState(statusReasonForError(e) ?? 'brain_unopenable'), { recovered: false });
      if (state.reason !== before) { marker(); log(`GBrain MCP server: the brain did not open (${e instanceof Error ? e.message : String(e)}); still status-only: ${statusHeadline(state)}`); }
      return;
    }
    if (engine === null) {
      if (state.reason !== before) { marker(); log(`GBrain MCP server: still status-only: ${statusHeadline(state)}`); }
      return;
    }
    if (stopping) { await engine.disconnect().catch(() => {}); return; }
    await recover(engine);
  };

  const schedule = () => {
    if (stopping || adopted) return;
    timer = setTimeout(() => {
      timer = null;
      inflight = tick().finally(() => { inflight = null; schedule(); });
    }, tickMs);
  };

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    await inflight;
    if (adopted) { await recovered?.disconnect().catch(() => {}); return; }
    dropMarker();
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      for (const s of sockets) s.destroy();
    });
    settle({});
  };
  const deregister = registerCleanup('serve-http-status', shutdown);
  const onSigint = () => { void shutdown().then(() => exit(0)); };
  process.once('SIGINT', onSigint);
  deps.onReady?.({ server, nonce, shutdown });
  schedule();

  const outcome = await done;
  process.off('SIGINT', onSigint);
  deregister();
  if (outcome.error) throw outcome.error;
}
