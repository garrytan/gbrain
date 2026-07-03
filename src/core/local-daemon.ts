/**
 * Local-daemon CLI fallback — route shared ops to a live local
 * `gbrain serve --http` instead of dying on the PGLite lock.
 *
 * PGLite is single-connection: while a serve daemon (launchd/systemd) holds
 * `<dataDir>/.gbrain-lock`, `connectEngine()` on a local install can only
 * poll the lock for 30s and throw "Timed out waiting for PGLite lock" —
 * even though the daemon is serving the SAME brain over loopback HTTP the
 * whole time. The lock file already records everything needed to route
 * around the collision: the holder's pid and argv (including `--port N`).
 * Detection is pure file reads + a loopback /health probe; no engine
 * connect, no OAuth discovery.
 *
 * Auth: `serve --http` guards /mcp with requireBearerAuth, so the CLI needs
 * a raw bearer token. Resolution: `GBRAIN_REMOTE_TOKEN` env var (same var
 * `gbrain connect` reads), then `<gbrain home>/agents.token` — the 0600
 * file host bootstrap scripts drop next to config.json when installing
 * agent MCP configs. `callRemoteTool` is OAuth-only (see connect-probe.ts),
 * so the tool call here reuses that probe's raw-bearer StreamableHTTP
 * pattern, including the Promise.race timeout guard: the AbortSignal alone
 * does not cover client.connect()'s initialize handshake.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { gbrainPath } from './config.ts';

export interface LocalDaemonInfo {
  pid: number;
  port: number;
}

export interface DetectDeps {
  isProcessAlive: (pid: number) => boolean;
  readFile: (path: string) => string;
}

const DEFAULT_DETECT_DEPS: DetectDeps = {
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0); // signal 0 = existence check
      return true;
    } catch {
      return false;
    }
  },
  readFile: (p) => readFileSync(p, 'utf-8'),
};

/**
 * Parse a lock-file `command` string (argv.slice(1).join(' ') — see
 * pglite-lock.ts) into the HTTP port of a `serve --http` holder.
 * Returns null for any other holder (stdio serve, embed, import, ...):
 * those have no HTTP surface to route to.
 */
export function parseServeHttpPort(command: unknown): number | null {
  if (typeof command !== 'string') return null;
  const tokens = command.split(/\s+/);
  if (!tokens.includes('serve') || !tokens.includes('--http')) return null;
  const portIdx = tokens.indexOf('--port');
  if (portIdx === -1) return 3131; // runServe default (serve.ts)
  const port = parseInt(tokens[portIdx + 1] ?? '', 10);
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * Read `<dataDir>/.gbrain-lock/lock` and return the live `serve --http`
 * holder, or null when there is no daemon to route to (no lock, corrupt
 * lock, dead holder, or a non-HTTP holder). Null means: proceed to the
 * normal local-engine path.
 */
export function detectLocalDaemon(
  dataDir: string | undefined,
  deps: DetectDeps = DEFAULT_DETECT_DEPS,
): LocalDaemonInfo | null {
  if (!dataDir) return null; // in-memory — no lock, no daemon
  try {
    const raw = JSON.parse(deps.readFile(join(dataDir, '.gbrain-lock', 'lock')));
    const pid = raw.pid;
    if (typeof pid !== 'number' || !deps.isProcessAlive(pid)) return null;
    const port = parseServeHttpPort(raw.command);
    if (port === null) return null;
    return { pid, port };
  } catch {
    return null;
  }
}

/** True iff GET /health on loopback answers 200 {status:"ok"} in time. */
export async function probeLocalDaemonHealth(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Bearer token for the loopback /mcp call. `GBRAIN_REMOTE_TOKEN` wins;
 * falls back to `<gbrain home>/agents.token`. Null when neither is set —
 * the caller renders the actionable error (the doomed 30s lock wait is
 * never worth falling through to).
 */
export function readLocalDaemonToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.GBRAIN_REMOTE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(gbrainPath('agents.token'), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * One raw-bearer MCP tool call against the local daemon. Timeout is a real
 * Promise.race (connect-probe.ts pattern): a daemon that accepts the socket
 * then stalls mid-handshake must not hang the CLI. `signal` is the CLI's
 * SIGINT controller; aborting it cancels the in-flight HTTP.
 */
export async function callLocalDaemonTool(
  port: number,
  token: string,
  name: string,
  args: Record<string, unknown>,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ isError?: boolean; content?: unknown }> {
  const doCall = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    });
    const client = new Client({ name: 'gbrain-cli-local', version: '1' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const res = await client.callTool({ name, arguments: args });
      return res as { isError?: boolean; content?: unknown };
    } finally {
      try { await client.close(); } catch { /* best-effort */ }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutGuard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`local daemon call timed out after ${opts.timeoutMs}ms`)),
      opts.timeoutMs,
    );
  });
  try {
    return await Promise.race([doCall(), timeoutGuard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
