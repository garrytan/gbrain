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
export function rustHttpServing(engine: { kind?: unknown; openStoreIfOpen?: (member: string) => object | null; capabilities?: ReadonlySet<string> }): boolean {
  if (engine.kind !== 'rust') return false;
  if (servedMultiuserClient(engine)) return true;
  const store = engine.openStoreIfOpen?.('serveHttp');
  return !!store && storeMultiuser(store);
}

/**
 * True for a served client (it reaches a brain server over protocol v3 and has no store) whose server runs multi-user:
 * its capabilities mirror the server's hello, which lists `multi_writer` exactly then.
 */
function servedMultiuserClient(engine: { capabilities?: ReadonlySet<string> }): boolean {
  const caps = engine.capabilities;
  return !!caps && caps.has('served') && caps.has('multi_writer');
}

type SessionLike = import('../../../mcp/session-dispatch.ts').PrincipalSessionRunner;

/**
 * Runs one HTTP tool call of a multi-user Rust brain in a principal session opened from `bearer` (I-6 steps 1-8): the
 * store admits only the owner's own key (A1); every other credential gets the session's one `permission_denied`, raised
 * inside the dispatcher so it answers in the usual error envelope, before any tool runs. The session is released when
 * the call ends. Off (`rustHttpServing` false), `fn` runs with no session, exactly as before.
 */
export async function withHttpPrincipalSession<T>(engine: object, bearer: string | undefined, fn: (session: SessionLike | undefined) => Promise<T>,
  member?: { id?: unknown } | null): Promise<T> {
  const rust = engine as { kind?: unknown; addon?: object; openStoreIfOpen?: (member: string) => object | null; capabilities?: ReadonlySet<string> };
  if (!rustHttpServing(rust)) return fn(undefined);
  if (servedMultiuserClient(rust)) return fn(await servedOwnerGate(engine as { getConfig(key: string): Promise<string | null> }, member));
  const { openPrincipalSession } = await import('../principal-session.ts');
  const store = rust.openStoreIfOpen!('serveHttp') as Parameters<typeof openPrincipalSession>[0];
  let opened: Awaited<ReturnType<typeof openPrincipalSession>> | null = null;
  let refusal: unknown = null;
  try { opened = await openPrincipalSession(store, bearer ?? '', rust.addon ?? {}); } catch (error) { refusal = error; }
  const session: SessionLike = opened ?? { run: () => Promise.reject(refusal) };
  try { return await fn(session); } finally { opened?.release(); }
}

/**
 * The owner-only gate (A1) on a served client, which has no store to open a principal session in: the request's
 * credential gets in only when it is bound to the brain's owner member (`access.owner_member`, read from the server).
 * The owner's calls then cross to the server as remote calls under the owner's narrowing record, as any remote call
 * does; every other credential gets the session's one `permission_denied` before a tool runs.
 */
async function servedOwnerGate(engine: { getConfig(key: string): Promise<string | null> }, member: { id?: unknown } | null | undefined): Promise<SessionLike> {
  const owner = await engine.getConfig('access.owner_member');
  if (owner && typeof member?.id === 'string' && member.id === owner) return { run: (_member, _opts, fn) => fn() };
  const { denied } = await import('../principal-session.ts');
  const refusal = denied(`served_client=true owner_member=${owner ? 'set' : 'unset'} credential_member=${typeof member?.id === 'string' ? 'other' : 'none'}`);
  return { run: () => Promise.reject(refusal) };
}
