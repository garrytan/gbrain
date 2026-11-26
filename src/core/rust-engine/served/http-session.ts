/**
 * `gbrain serve --http` on a Rust brain in multi-user mode (docs/designs/rust-engine/multi-user-server.md, I-6 "Session
 * contract for the server"). Until per-user access lifts (ruling A1), only the brain owner's own key gets in: each MCP
 * request opens a principal session from its bearer token (principal-session.ts), runs its tool call through
 * `session.run` (the store's caller record and derivation, never one the request built), and releases it. Anything
 * else refuses `permission_denied` before a tool runs. With the switch off nothing here applies.
 */
import { storeMultiuser } from '../access-self-check.ts';

/**
 * True when `engine` is a Rust brain this process serves over HTTP in multi-user mode. The store's resolved mode decides
 * (I-0.v2: the environment switch OR the brain's own config row), never the environment alone: a brain that is
 * multi-user only through its config row gets the owner-only gate too.
 */
export function rustHttpServing(engine: { kind?: unknown; openStoreIfOpen?: (member: string) => object | null }): boolean {
  if (engine.kind !== 'rust') return false;
  const store = engine.openStoreIfOpen?.('serveHttp');
  return !!store && storeMultiuser(store);
}

type SessionLike = import('../../../mcp/session-dispatch.ts').PrincipalSessionRunner;

/**
 * Runs one HTTP tool call of a multi-user Rust brain in a principal session opened from `bearer` (I-6 steps 1-8): the
 * store admits only the owner's own key (A1); every other credential gets the session's one `permission_denied`, raised
 * inside the dispatcher so it answers in the usual error envelope, before any tool runs. The session is released when
 * the call ends. Off (`rustHttpServing` false), `fn` runs with no session, exactly as before.
 */
export async function withHttpPrincipalSession<T>(engine: object, bearer: string | undefined, fn: (session: SessionLike | undefined) => Promise<T>): Promise<T> {
  const rust = engine as { kind?: unknown; addon?: object; openStoreIfOpen?: (member: string) => object | null };
  if (!rustHttpServing(rust)) return fn(undefined);
  const { openPrincipalSession } = await import('../principal-session.ts');
  const store = rust.openStoreIfOpen!('serveHttp') as Parameters<typeof openPrincipalSession>[0];
  let opened: Awaited<ReturnType<typeof openPrincipalSession>> | null = null;
  let refusal: unknown = null;
  try { opened = await openPrincipalSession(store, bearer ?? '', rust.addon ?? {}); } catch (error) { refusal = error; }
  const session: SessionLike = opened ?? { run: () => Promise.reject(refusal) };
  try { return await fn(session); } finally { opened?.release(); }
}
