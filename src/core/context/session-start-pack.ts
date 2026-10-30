/**
 * The SessionStart context pack (hook.ts step 6), fetched from the serve over
 * its resolve-IPC socket. Engine-free: the hook never opens the brain, so a
 * live PGLite owner is never contended.
 *
 * Cat 41 first push: Claude Code spawns its MCP servers alongside SessionStart
 * (observed on 2.1.285: the server starts ~45ms before the hook, in parallel),
 * and a fresh stdio `gbrain serve` binds its socket about 2s later. Without a
 * wait the hook found no socket and a fresh session got no pack. When
 * `sessionStartAwaitsServe` says the harness is starting a serve for this
 * session, the request is retried until the serve answers or the deadline
 * nears; otherwise one attempt, as before.
 */
import {
  CONTEXT_PACK_CLIENT_TIMEOUT_MS,
  IPC_UNAVAILABLE,
  hookResolveSocketForConfig,
  readIpcSecretForConfig,
  requestContextPack,
  type ContextPackResponse,
  type IpcPathConfig,
} from './resolve-ipc.ts';
import { claudeCodeSpawnsServe } from '../setup/local-receipts.ts';

const POLL_MS = 100;
/** Kept free before the deadline for composing and writing stdout. */
const WRITE_MARGIN_MS = 100;

/**
 * True when this SessionStart belongs to a new Claude Code process (source
 * startup or resume; clear and compact run inside a process whose serve is
 * already up) and an installed `gbrain setup claude-code` receipt says that
 * process spawns a stdio serve for this directory. Fail-open: false.
 */
export function sessionStartAwaitsServe(source: unknown, harness: string, cwd: string): boolean {
  if (harness !== 'claude-code' || (source !== undefined && source !== 'startup' && source !== 'resume')) return false;
  try {
    return claudeCodeSpawnsServe(cwd);
  } catch {
    return false;
  }
}

export interface SessionStartPackResult {
  pack: ContextPackResponse | null;
  /** The wait ran out before a serve answered. */
  serveNotReady: boolean;
  /** A serve's secret exists but its round trip failed or outlasted the client timeout. */
  ipcUnavailable?: boolean;
}

/**
 * One context_pack request, or (awaitServe) retries until the serve answers.
 * Socket and secret are re-resolved each round: a serve on a fresh brain
 * creates the secret, and on Postgres it binds a source-keyed socket. A stale
 * serve (no protocol echo) yields no pack.
 */
export async function requestSessionStartPack(
  cfg: IpcPathConfig | null,
  opts: { sourceId?: string; sessionId: string; trigger: string; deadlineAt: number; awaitServe: boolean },
): Promise<SessionStartPackResult> {
  for (;;) {
    const socket = await hookResolveSocketForConfig(cfg, opts.sourceId);
    if (!socket) return { pack: null, serveNotReady: false };
    const remaining = opts.deadlineAt - Date.now() - WRITE_MARGIN_MS;
    if (remaining <= WRITE_MARGIN_MS) return { pack: null, serveNotReady: opts.awaitServe };
    const secret = readIpcSecretForConfig(cfg);
    const res = secret
      ? await requestContextPack(socket, {
        secret,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
        trigger: opts.trigger,
      }, { timeoutMs: Math.min(CONTEXT_PACK_CLIENT_TIMEOUT_MS, remaining) })
      : IPC_UNAVAILABLE;
    if (res !== IPC_UNAVAILABLE) return { pack: 'degraded' in res ? null : res as ContextPackResponse, serveNotReady: false };
    if (!opts.awaitServe) return { pack: null, serveNotReady: false, ...(secret ? { ipcUnavailable: true } : {}) };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * #5941: the source the hook's context arms (session-start pack, user-prompt)
 * ask for. `GBRAIN_SOURCE` wins; else, with a session, its frozen source
 * record (the one capture stamps: env, then the payload cwd's
 * `.gbrain-source` walk), so context and capture never disagree within a
 * session; without one, the cwd walk itself. Undefined (the serve's own
 * binding) when nothing names a source or anything fails. A named source with
 * no live keyed serve reaches the legacy socket, whose serve answers
 * `source_mismatch` (the heartbeat reason) instead of another source's context.
 */
export async function contextSourceId(openSession: (() => Promise<{ source?: string }>) | null, cwd: string): Promise<string | undefined> {
  if (process.env.GBRAIN_SOURCE) return process.env.GBRAIN_SOURCE;
  try {
    if (openSession) return (await openSession()).source;
    const { resolveSourceIdEngineFree } = await import('../source-resolver.ts');
    return resolveSourceIdEngineFree(null, cwd) ?? undefined;
  } catch {
    return undefined;
  }
}
