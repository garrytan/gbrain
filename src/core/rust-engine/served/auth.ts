/**
 * Who a protocol v3 connection is (interface I-6 stub; decisions 4, 5 and 8 of the L3 plan).
 *
 * Until per-user access in the store (lane L4) passes its self-check, the server lets in exactly one kind of
 * credential over the network: an owner server token. That is a legacy access token the brain owner minted on the
 * server host with `gbrain auth create <name> --rust-server-owner` (trusted local CLI only), whose id the brain config
 * key `rust_server.owner_token_ids` lists. The server accepts it only when every one of these holds, else it refuses
 * `permission_denied` before any call runs (fail closed):
 *  - it verifies through the HTTP server's bearer check (`verifyAccessToken`) with no degraded grant projection,
 *  - its principal is a legacy token whose id the owner list names (an OAuth client never is, until L4),
 *  - its scopes include read, write and admin,
 *  - it has no operation allow-list, no source grant (the no-grant floor: write source `default`, no read-source list),
 *    no slug-prefix fence, no takes-holder list, no member or act-for binding, no attest right and no trust floor.
 * Such a principal runs under the owner's trusted local view (`Scope::trusted_local`, I-6). A Unix-socket v3 peer
 * whose OS user the kernel proved is the local owner too.
 *
 * Provenance (decision 8): the principal sets the authority floor. The owner floor is trusted local; a frame's
 * `remote: true` only narrows a call to a remote caller. `remote: false` from a principal whose floor is remote
 * refuses (`remote_mismatch`). No non-owner principal exists before L4, so every accepted connection has the owner
 * floor today.
 *
 * Freshness (decision 5): `recheck` re-verifies the token; the server calls it at most every RECHECK_MS for a live
 * connection and refuses new work as soon as it fails.
 */
import type { BrainEngine } from '../../engine.ts';
import type { CallerAccess } from '../../search/private-visibility.ts';
import { servedAuthRefused } from './errors.ts';

export const OWNER_TOKEN_IDS_CONFIG_KEY = 'rust_server.owner_token_ids';
/** How old a connection's last credential check may be when the server admits a call. */
export const RECHECK_MS = 2_000;

export interface AuthenticatedPrincipal {
  kind: 'local_owner' | 'owner_token';
  /** A stable key for request ids: `local_owner` or `owner_token:<id>`. */
  key: string;
  /** True when every call on the connection is a remote caller's (never for the owner floor). */
  floorRemote: boolean;
  /** Epoch ms after which the credential stops working (undefined: does not expire). */
  expiresAt?: number;
  /**
   * The caller access record the store built for this principal (B3): every call runs under it and a frame claiming
   * another is refused (owner-ipc/frame-access.ts). Unset for the owner's floor, whose frames narrow its trusted view.
   */
  record?: CallerAccess;
}

export const LOCAL_OWNER: AuthenticatedPrincipal = Object.freeze({ kind: 'local_owner', key: 'local_owner', floorRemote: false });

/** The owner token ids the brain config lists. A missing or unreadable list is empty (fail closed). */
export async function ownerTokenIds(engine: Pick<BrainEngine, 'getConfig'>): Promise<Set<string>> {
  try {
    const raw = await engine.getConfig(OWNER_TOKEN_IDS_CONFIG_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && v !== '') : []);
  } catch { return new Set(); } // silent-read-ok: an unreadable owner list is the empty list, so every network token refuses (fail closed)
}

type AuthInfo = Record<string, unknown> & { principal?: { kind?: unknown; id?: unknown }; scopes?: unknown; expiresAt?: unknown };

const RESTRICTION_FIELDS = ['allowedOperations', 'allowedSources', 'boundSlugPrefixes', 'fenceProjectionDegraded',
  'takesHoldersAllowList', 'minTrust', 'member', 'mayActFor', 'attest', 'boundTools', 'boundSourceId', 'boundBrainId', 'delegatedSlugPrefixes'] as const;

/** The restriction an owner token must not carry, or null when it carries none. Exported for the tests. */
export function ownerTokenRestriction(info: AuthInfo): string | null {
  const scopes = Array.isArray(info.scopes) ? info.scopes as unknown[] : [];
  for (const scope of ['read', 'write', 'admin']) if (!scopes.includes(scope)) return `scope_${scope}_missing`;
  for (const field of RESTRICTION_FIELDS) {
    const value = info[field];
    if (value === undefined || value === null || value === false) continue;
    return field;
  }
  // The source axis: only the historical no-grant floor (write source `default`, no source grant) is the owner's view.
  if (info.hasSourceGrant !== false) return 'hasSourceGrant';
  if (info.sourceId !== undefined && info.sourceId !== 'default') return 'sourceId';
  return null;
}

export interface VerifyDeps {
  /** The bearer check; default: the HTTP server's (`GBrainOAuthProvider.verifyAccessToken`) on `engine`. */
  verify?: (engine: BrainEngine, token: string) => Promise<AuthInfo>;
  /** The owner token ids (default: the brain config key); tests that must not write the brain inject them. */
  ownerIds?: (engine: BrainEngine) => Promise<Set<string>>;
  now?: () => number;
}

async function defaultVerify(engine: BrainEngine, token: string): Promise<AuthInfo> {
  const { GBrainOAuthProvider } = await import('../../oauth-provider.ts');
  const { sqlQueryForEngine } = await import('../../sql-query.ts');
  return await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).verifyAccessToken(token) as unknown as AuthInfo;
}

/**
 * Verifies a v3 hello's bearer token and returns its principal, or throws the typed refusal. The token value never
 * appears in an error.
 */
export async function authenticateToken(engine: BrainEngine, token: unknown, deps: VerifyDeps = {}): Promise<AuthenticatedPrincipal> {
  if (typeof token !== 'string' || token === '') throw servedAuthRefused('token_missing', null);
  let info: AuthInfo;
  try { info = await (deps.verify ?? defaultVerify)(engine, token); } catch { throw servedAuthRefused('token_invalid', null); }
  const principal = info.principal;
  if (!principal || principal.kind !== 'legacy_token' || typeof principal.id !== 'string') throw servedAuthRefused('token_not_owner', null);
  const owners = await (deps.ownerIds ?? ownerTokenIds)(engine);
  if (!owners.has(principal.id)) throw servedAuthRefused('token_not_owner', null);
  if (ownerTokenRestriction(info) !== null) throw servedAuthRefused('token_not_owner', null);
  const expiresAt = typeof info.expiresAt === 'number' ? info.expiresAt * 1000 : undefined;
  if (expiresAt !== undefined && expiresAt <= (deps.now ?? Date.now)()) throw servedAuthRefused('token_expired', null);
  return { kind: 'owner_token', key: `owner_token:${principal.id}`, floorRemote: false, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

/** Re-verifies a connection's token: the same principal, or the refusal that ends new work on the connection. */
export async function recheckToken(engine: BrainEngine, token: string, was: AuthenticatedPrincipal, deps: VerifyDeps = {}): Promise<AuthenticatedPrincipal> {
  let now: AuthenticatedPrincipal;
  try { now = await authenticateToken(engine, token, deps); }
  catch (error) {
    const reason = (error as { reason?: string }).reason;
    throw servedAuthRefused(reason === 'token_missing' ? 'token_invalid' : 'token_expired', null);
  }
  if (now.key !== was.key) throw servedAuthRefused('token_expired', null);
  return now;
}

/** The remote mark a call runs with, or the refusal for a mismatch (decision 8). */
export function effectiveRemote(principal: AuthenticatedPrincipal, claimed: unknown, member: string): boolean {
  const remote = claimed === true;
  if (!remote && principal.floorRemote) throw servedAuthRefused('remote_mismatch', member);
  return remote || principal.floorRemote;
}
