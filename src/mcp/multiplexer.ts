/**
 * MCP multiplexer — Unix socket fan-in for the primary `gbrain serve`.
 *
 * Problem this solves: PGLite is single-process-per-data-directory. When
 * Claude.app runs `gbrain serve` from its claude_desktop_config.json AND
 * spawns claude-code-spawn child sessions that ALSO pass
 * `--mcp-config '...gbrain serve...'`, the child sessions each try to start
 * their own `gbrain serve`, hit the lock contention on the PGLite data
 * directory, and die. The MCP tools `mcp__gbrain__*` end up unavailable in
 * every child session even though gbrain is "configured" there.
 *
 * Solution: the first `gbrain serve` (the owner of the PGLite lock) ALSO
 * opens a Unix socket alongside the lock. Subsequent `gbrain serve`
 * invocations detect the lock-already-held-by-another-serve condition and
 * become STDIO PROXIES (see ./proxy.ts) that bidi-pipe their stdin/stdout
 * to the owner's socket. From the perspective of each MCP client (Claude.app,
 * each claude-code-spawn), they got a working `gbrain serve` over stdio;
 * from the owner's perspective, it just has N concurrent MCP clients on
 * different transports.
 *
 * Architecture:
 *
 *   Owner process:
 *     - StdioServerTransport on real process.stdin/stdout (primary client)
 *     - net.createServer listening at <dataDir>/.gbrain-lock/serve.sock
 *       → per-connection: new Server() + StdioServerTransport(socket, socket)
 *
 *   Proxy process (see ./proxy.ts):
 *     - net.connect(<same socket path>)
 *     - bidi: process.stdin → socket, socket → process.stdout
 *
 * Trust boundary: each per-connection Server uses startMcpServerWithTransport,
 * which dispatches with `remote: true` — identical to the primary stdio
 * path. A proxied client gets exactly the same untrusted treatment as a
 * direct stdio client, which is correct (claude-code-spawn child sessions
 * are the same trust class as the parent Claude.app session).
 */

import { createServer, type Socket } from 'node:net';
import { join, dirname } from 'node:path';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { BrainEngine } from '../core/engine.ts';
import { startMcpServerWithTransport } from './server.ts';

const SOCKET_FILE = 'serve.sock';
const LOCK_DIR_NAME = '.gbrain-lock';

/**
 * Resolve the Unix socket path for a given PGLite data directory. Lives
 * inside the same `.gbrain-lock` dir as the advisory lock so socket
 * lifecycle is naturally bounded by lock lifecycle (when the owner
 * releases the lock, the lock dir is rm-rf'd and any leftover socket file
 * goes with it).
 */
export function serveSocketPath(dataDir: string): string {
  return join(dataDir, LOCK_DIR_NAME, SOCKET_FILE);
}

export interface MultiplexerHandle {
  socketPath: string;
  /** Active client connection count (for tests / introspection). */
  readonly clientCount: number;
  /**
   * Close the listener, destroy active per-client sockets, and remove the
   * socket file. Idempotent. Called from the owner's shutdown sequence
   * BEFORE engine.disconnect() so the socket file is gone before the lock
   * dir is rm-rf'd (avoids a race where a late-arriving proxy connects to
   * a half-dead listener).
   */
  close: () => Promise<void>;
}

/**
 * Start the multiplexer listener. Returns once the socket is bound and
 * accepting connections. Errors during bind reject the returned promise
 * (e.g. EADDRINUSE if a stale socket file exists AND the previous owner
 * is still alive — which shouldn't happen because the PGLite lock would
 * have prevented us getting this far, but we surface it cleanly anyway).
 */
export async function startMultiplexer(
  engine: BrainEngine,
  socketPath: string,
): Promise<MultiplexerHandle> {
  mkdirSync(dirname(socketPath), { recursive: true });

  // Defensive: remove a stale socket file from a previous crashed owner.
  // The atomic lock ownership upstream (acquireLock via mkdir) guarantees
  // we're the only writer here, so this is safe — if the previous owner
  // had really still been alive, acquireLock would have blocked.
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* will surface as EADDRINUSE below */ }
  }

  const sockets = new Set<Socket>();

  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); });
    socket.on('error', (err: Error) => {
      // Per-connection errors are not fatal to the listener. Log to stderr
      // (NOT stdout — stdout is the primary client's JSON-RPC channel).
      process.stderr.write(`[gbrain-multiplexer] client socket error: ${err.message}\n`);
    });

    // The MCP SDK's StdioServerTransport reads from any Readable and writes
    // to any Writable. A net.Socket is Duplex (both), so we can reuse the
    // SDK's transport verbatim and get the exact same line-delimited
    // JSON-RPC framing as the primary stdio path. Zero custom transport.
    const transport = new StdioServerTransport(socket, socket);

    startMcpServerWithTransport(engine, transport).catch((err: Error) => {
      process.stderr.write(`[gbrain-multiplexer] per-client server failed: ${err.message}\n`);
      socket.destroy();
    });
  });

  server.on('error', (err: Error) => {
    process.stderr.write(`[gbrain-multiplexer] listener error: ${err.message}\n`);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListen);
      reject(err);
    };
    const onListen = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(socketPath);
  });

  return {
    socketPath,
    get clientCount() { return sockets.size; },
    close: async () => {
      // Close listener first so no new connections accumulate while we
      // tear down the active ones. server.close() resolves once the
      // listener is shut AND all active connections have closed — but
      // since we destroy() sockets ourselves below, the resolve fires
      // promptly even if a client was mid-stream.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const s of sockets) s.destroy();
      sockets.clear();
      await closed;
      // Best-effort cleanup of the socket file. On graceful shutdown the
      // lock-dir rm-rf in engine.disconnect() would have taken it anyway,
      // but doing it here too keeps a post-mortem fs in a clean state.
      try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* ignore */ }
    },
  };
}
