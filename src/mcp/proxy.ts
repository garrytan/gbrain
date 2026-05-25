/**
 * MCP stdio→Unix-socket proxy. The counterpart to ./multiplexer.ts.
 *
 * Used when `gbrain serve` is invoked but another `gbrain serve` already
 * holds the PGLite lock. Instead of failing with the lock-contention
 * error, we connect to the owner's multiplexer socket and bidi-pipe our
 * stdin/stdout to it. The MCP client that spawned us (Claude.app via
 * claude_desktop_config.json, claude-code-spawn via --mcp-config, etc.)
 * sees a transparently working `gbrain serve` over stdio; the owner sees
 * a new MCP client on its socket transport.
 *
 * No JSON-RPC parsing happens here — it's a pure byte pipe. That keeps
 * the proxy trivial AND preserves the trust boundary by accident-proof
 * construction: we cannot modify the messages even if we wanted to,
 * because we don't parse them. The owner's per-connection Server still
 * dispatches with remote=true via startMcpServerWithTransport.
 */

import { connect, type Socket } from 'node:net';

export interface ProxyOptions {
  /** Timeout for the initial connect attempt (ms). Default 5000. */
  connectTimeoutMs?: number;
  /**
   * Test seam: where to pipe FROM (defaults to process.stdin). The MCP
   * client speaks JSON-RPC to us via this stream; we forward bytes to
   * the socket without parsing.
   */
  stdin?: NodeJS.ReadableStream;
  /**
   * Test seam: where to pipe TO (defaults to process.stdout). The owner's
   * Server writes JSON-RPC replies to the socket; we forward bytes here
   * without parsing.
   */
  stdout?: NodeJS.WritableStream;
}

/**
 * Connect to `socketPath` and bidi-pipe stdin↔socket↔stdout. Resolves
 * when the socket closes (clean owner shutdown, owner crash, client
 * stdin EOF). Rejects if the initial connect fails — the caller decides
 * whether to retry as an owner (e.g. stale socket from a crashed owner
 * means the lock should also be stale and a fresh acquire would succeed).
 */
export async function runProxy(
  socketPath: string,
  opts: ProxyOptions = {},
): Promise<void> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  const socket: Socket = await new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`gbrain proxy: connect timeout (${connectTimeoutMs}ms) on ${socketPath}`));
    }, connectTimeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  // Bidi byte pipe. .pipe() handles backpressure for us. When the source
  // ends, the destination is NOT auto-closed by default for stdin→socket
  // (we want to keep the socket open if the client just paused), and
  // socket→stdout DOES end stdout on close — but stdout is process-global
  // so we suppress that with { end: false } and let the caller exit().
  stdin.pipe(socket);
  socket.pipe(stdout, { end: false });

  // Surface socket-level errors to stderr (NOT stdout — stdout is the
  // client's JSON-RPC channel and a stray line would corrupt the next
  // frame the client tries to parse).
  socket.on('error', (err: Error) => {
    process.stderr.write(`[gbrain-proxy] socket error: ${err.message}\n`);
  });

  // Resolve when the socket closes for any reason (owner shut down, owner
  // crashed, stdin EOF propagated through). The caller is responsible for
  // process.exit() — keeping that out of here lets this function be
  // unit-tested without exiting the test runner.
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
  });
}
