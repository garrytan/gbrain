/**
 * Retrieval Reflex — resolve IPC (issue #1981, D9=C).
 *
 * PGLite is single-connection: `gbrain serve` holds the one connection for its
 * lifetime, so the context engine cannot open its own and must NOT shell out to
 * a subprocess (that would force-steal the lock past the 5-min staleness window
 * and crash the brain — see plan D9 rejected option). Instead, `serve`
 * optionally listens on a local unix-domain socket and answers narrow local
 * requests using the connection it already owns. Both ends are gbrain code;
 * raw SQL never crosses the wire (closes the trust hole).
 *
 * Protocol: newline-delimited JSON. One request line, one response line.
 *   resolve req: { candidates, priorContextText?, maxPointers?, sourceId? }
 *   resolve resp: { ok: true, block: PointerBlock | null } | { ok: false, error }
 *   capture req: { op: "capture", slug, content, sourceId? }
 *   capture resp: { ok: true, result } | { ok: false, error }
 *
 * Local-only (unix socket on the brain's data dir, mode 0600) — no network
 * surface.
 */

import net from 'node:net';
import { createHash } from 'node:crypto';
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
  op?: 'resolve';
  candidates: EntityCandidate[];
  priorContextText?: string;
  maxPointers?: number;
  sourceId?: string;
  /** v0.43 (#2095, codex D7): suppression mode — 'slug-only' under windowing. */
  suppression?: 'slug-and-title' | 'slug-only';
}

export interface CaptureIpcRequest {
  op: 'capture';
  slug: string;
  content: string;
  sourceId?: string;
  sourceKind?: string;
  sourceUri?: string;
  ingestedVia?: string;
}

export type CaptureIpcResult = Record<string, unknown>;
export type ResolveHandler = (req: ResolveRequest) => Promise<PointerBlock | null>;
export type CaptureHandler = (req: CaptureIpcRequest) => Promise<CaptureIpcResult>;

/** Canonical socket path for a PGLite data dir. */
export function resolveSocketPath(dataDir: string): string {
  if (process.platform === 'win32') {
    const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\gbrain-resolve-${hash}`;
  }
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
  const resp = await sendIpcRequest(socketPath, req);
  if (resp === IPC_UNAVAILABLE) return IPC_UNAVAILABLE;
  if (resp && resp.ok) return (resp.block ?? null) as PointerBlock | null;
  return IPC_UNAVAILABLE;
}

/**
 * Client: write a capture through the already-running `gbrain serve` process.
 * Used by local auto-capture drainers so they do not spawn a second PGLite
 * owner and then lose messages on lock timeout.
 */
export async function captureViaIpc(
  socketPath: string,
  req: CaptureIpcRequest,
): Promise<CaptureIpcResult | typeof IPC_UNAVAILABLE> {
  const resp = await sendIpcRequest(socketPath, req);
  if (resp === IPC_UNAVAILABLE) return IPC_UNAVAILABLE;
  if (resp && resp.ok && typeof resp.result === 'object' && resp.result !== null) {
    return resp.result as CaptureIpcResult;
  }
  return IPC_UNAVAILABLE;
}

async function sendIpcRequest(
  socketPath: string,
  req: ResolveRequest | CaptureIpcRequest,
): Promise<Record<string, unknown> | typeof IPC_UNAVAILABLE> {
  if (process.platform !== 'win32' && !existsSync(socketPath)) return IPC_UNAVAILABLE;
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const finish = (v: Record<string, unknown> | typeof IPC_UNAVAILABLE) => {
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
        if (resp && typeof resp === 'object') return finish(resp);
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
  /**
   * v0.43 (#2095, red-team): fired ONLY after the response was successfully
   * written to the client — the accept-side seam for reflex-channel feedback
   * logging. A block the client never received (timeout, dead socket) was
   * never injected into a prompt and must not count as "volunteered".
   */
  onDelivered?: (block: PointerBlock, req: ResolveRequest) => void,
  captureHandler?: CaptureHandler,
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
        let delivered: { block: PointerBlock; req: ResolveRequest } | null = null;
        try {
          const req = JSON.parse(line) as ResolveRequest | CaptureIpcRequest;
          if ((req as CaptureIpcRequest).op === 'capture') {
            if (!captureHandler) throw new Error('capture IPC unavailable');
            const result = await captureHandler(req as CaptureIpcRequest);
            resp = JSON.stringify({ ok: true, result });
          } else {
            const block = await handler(req as ResolveRequest);
            resp = JSON.stringify({ ok: true, block });
            if (block) delivered = { block, req: req as ResolveRequest };
          }
        } catch (e) {
          resp = JSON.stringify({ ok: false, error: (e as Error).message });
        }
        try {
          conn.write(resp + '\n');
          // Write accepted — the client (250ms budget) may still have hung
          // up, but this is the closest observable delivery point.
          if (delivered && onDelivered) {
            try { onDelivered(delivered.block, delivered.req); } catch { /* telemetry only */ }
          }
        } catch { /* client gone — do NOT log undelivered pointers */ }
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
  if (process.platform === 'win32') return;
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
