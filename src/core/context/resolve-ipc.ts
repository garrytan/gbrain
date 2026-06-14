/**
 * Retrieval Reflex — resolve IPC (issue #1981, D9=C).
 *
 * PGLite is single-connection: `gbrain serve` holds the one connection for its
 * lifetime, so the context engine cannot open its own and must NOT shell out to
 * a subprocess (that would force-steal the lock past the 5-min staleness window
 * and crash the brain — see plan D9 rejected option). Instead, `serve`
 * optionally listens on a local unix-domain socket and answers a NARROW request
 * — candidates in, pointers out — using the connection it already owns. Both
 * ends are gbrain code; raw SQL never crosses the wire (closes the trust hole).
 *
 * Protocol: newline-delimited JSON. One request line, one response line.
 *   req:  { candidates, priorContextText?, maxPointers?, sourceId? }
 *   resp: { ok: true, block: PointerBlock | null } | { ok: false, error }
 *
 * Local-only (unix socket on the brain's data dir, mode 0600) — no network
 * surface.
 */

import net from 'node:net';
import { existsSync, unlinkSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityCandidate } from './entity-salience.ts';
import type { PointerBlock } from './retrieval-reflex.ts';

const SOCK_NAME = '.gbrain-resolve.sock';
const CLIENT_TIMEOUT_MS = 250;
const MAX_MSG_BYTES = 256 * 1024;

/** Marker the client returns when no server is reachable (vs. a real null result). */
export const IPC_UNAVAILABLE = Symbol('ipc-unavailable');

export interface ResolveRequest {
  candidates: EntityCandidate[];
  priorContextText?: string;
  maxPointers?: number;
  sourceId?: string;
}

export type ResolveHandler = (req: ResolveRequest) => Promise<PointerBlock | null>;

/** Canonical socket path for a PGLite data dir. */
export function resolveSocketPath(dataDir: string): string {
  return join(dataDir, SOCK_NAME);
}

/**
 * Client: ship candidates to a running serve, get pointers back. Returns
 * IPC_UNAVAILABLE when no server is listening (caller falls through the ladder);
 * a real PointerBlock | null otherwise. Never throws — fail-soft to UNAVAILABLE.
 */
export async function resolveViaIpc(
  socketPath: string,
  req: ResolveRequest,
): Promise<PointerBlock | null | typeof IPC_UNAVAILABLE> {
  if (!existsSync(socketPath)) return IPC_UNAVAILABLE;
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const finish = (v: PointerBlock | null | typeof IPC_UNAVAILABLE) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve(v);
    };
    const sock = net.createConnection(socketPath);
    sock.setTimeout(CLIENT_TIMEOUT_MS);
    sock.on('connect', () => {
      sock.write(JSON.stringify(req) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_MSG_BYTES) return finish(IPC_UNAVAILABLE);
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const resp = JSON.parse(buf.slice(0, nl));
        if (resp && resp.ok) return finish(resp.block ?? null);
        return finish(IPC_UNAVAILABLE);
      } catch {
        return finish(IPC_UNAVAILABLE);
      }
    });
    // Any error (ENOENT, ECONNREFUSED, stale socket), timeout, or close before
    // a response → treat as unavailable, fall through the ladder.
    sock.on('timeout', () => finish(IPC_UNAVAILABLE));
    sock.on('error', () => finish(IPC_UNAVAILABLE));
    sock.on('close', () => finish(IPC_UNAVAILABLE));
  });
}

/**
 * Server: start a resolve listener on `socketPath`. Cleans up a stale socket
 * left by a dead owner first. Returns the net.Server (caller closes on
 * shutdown). Errors are swallowed (best-effort feature) — returns null if the
 * socket can't be bound.
 */
export async function startResolveIpcServer(
  socketPath: string,
  handler: ResolveHandler,
): Promise<net.Server | null> {
  // Remove a stale socket file if present (a previous serve that didn't clean up).
  cleanupStaleSocket(socketPath);

  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      let buf = '';
      conn.setEncoding('utf8');
      conn.on('data', async (chunk: string) => {
        buf += chunk;
        if (buf.length > MAX_MSG_BYTES) { conn.destroy(); return; }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        let resp: string;
        try {
          const req = JSON.parse(line) as ResolveRequest;
          const block = await handler(req);
          resp = JSON.stringify({ ok: true, block });
        } catch (e) {
          resp = JSON.stringify({ ok: false, error: (e as Error).message });
        }
        try { conn.write(resp + '\n'); } catch { /* client gone */ }
        conn.end();
      });
      conn.on('error', () => { try { conn.destroy(); } catch { /* noop */ } });
    });
    server.on('error', () => resolve(null));
    server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }
      resolve(server);
    });
  });
}

/** Remove a socket file whose owning process is gone (or any leftover file). */
export function cleanupStaleSocket(socketPath: string): void {
  try {
    if (existsSync(socketPath)) {
      // A unix socket shows up as a socket file; unlink unconditionally — if a
      // live server holds it, listen() below would fail and we return null.
      const st = statSync(socketPath);
      if (st.isSocket() || st.isFIFO() || st.isFile()) unlinkSync(socketPath);
    }
  } catch {
    /* best effort */
  }
}
