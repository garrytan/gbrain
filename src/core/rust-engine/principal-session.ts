/**
 * Multi-user lane L4, interface I-6: a session a multi-user server opens for one authenticated connection.
 *
 * The contract for the server (lane L3): the hello's bearer token goes to `openPrincipalSession(store, token)`, which
 * asks the store to verify the token against its own `access_tokens` records and admit it (rust/crates/gbrain-store/
 * src/scope.rs; napi `mintScope`). Every call of that connection then runs through `session.admit(member)` first, which
 * has the store revalidate the session against its current records (a revoke, a disabled member, a changed owner or a
 * narrowed grant refuses the next call) and refuses a write member for a credential whose grant has no `write` scope.
 * The call's grant comes from `session.grant`, the store-verified token row read through the same grant model the
 * HTTP transport uses (grants/model.ts), never from anything else the client sent. `session.release()` when the
 * connection closes.
 *
 * Fail closed: only the brain owner's own key opens a session for now; every other credential refuses
 * `permission_denied` with one message. Sessions exist only on a store in multi-user mode (I-0.v2).
 */
import { opError } from '../ops/contract.ts';
import { grantFromTokenRow, type PrincipalGrant } from '../grants/model.ts';
import { hasScope } from '../scope.ts';
import { ownerMemberOnlyReads } from './owner-ipc/routes.ts';
import type { RustStore } from './store.ts';
import { storeMultiuser, withAccessStore } from './access-self-check.ts';
import { remotePrivacyHatch, withCallerAccess, withoutCallerAccess, type CallerAccess } from '../search/private-visibility.ts';


/** One authenticated connection's session. */
export interface PrincipalSession {
  /** The store-minted handle (opaque). */
  readonly handle: string;
  /** The verified token's grant (scopes, sources, operations, private-pages and private-facts axes). */
  readonly grant: PrincipalGrant;
  /** Revalidates the session and checks the grant's write ceiling before `member` runs. */
  admit(member: string): Promise<void>;
  /**
   * Runs one call of `member` for the principal: admits it, then runs `fn` under the caller record the store builds
   * for the principal (`scopeCallerRecord`) and in server mode, where every privacy policy is the store's derivation
   * alone. A caller record or policy the client sent never applies.
   */
  run<T>(member: string, opts: SessionCallOptions, fn: () => Promise<T>): Promise<T>;
  /** Forgets the session. */
  release(): void;
}

/** What a call adds to the store's caller record: whether it only reads, and the grant's private sources it may read. */
export interface SessionCallOptions {
  readOnly: boolean;
  privateReadableSources?: readonly string[];
  privateFactSources?: readonly string[];
}

const DENIED = 'This credential cannot open a multi-user session on this brain (only the brain owner\'s own key is admitted for now).';

function denied(detail: string) {
  return opError('permission_denied', DENIED, 'Connect with the brain owner\'s own key, or run the call on the brain host.', { detail });
}

/** Maps the store's refusal to the one `permission_denied` every session refusal gives. */
function asDenied(error: unknown, detail: string): never {
  if ((error as { code?: unknown } | null)?.code === 'permission_denied') throw denied(detail);
  throw error;
}

/** Opens a session for `bearer` on `store`, or refuses `permission_denied`. */
export async function openPrincipalSession(store: RustStore, bearer: string, addon: object = {}): Promise<PrincipalSession> {
  if (!storeMultiuser(store)) throw denied('reason=multiuser_off');
  const brain = store.brain;
  let handle: string;
  let row: Record<string, unknown>;
  try {
    handle = String((await brain.mintScope(bearer) as { handle: string }).handle);
    row = await brain.scopeGrant(handle) as Record<string, unknown>;
  } catch (error) { asDenied(error, 'reason=mint'); }
  const grant = grantFromTokenRow(row as never);
  const writes = hasScope(grant.scopes, 'write');
  let released = false;
  const admit = async (member: string) => {
    if (released) throw denied('reason=released');
    try { await brain.checkScope(handle); } catch (error) { released = true; asDenied(error, `reason=revalidate member=${member}`); }
    if (!ownerMemberOnlyReads(member) && !writes) throw denied(`reason=read_only_grant member=${member}`);
  };
  return {
    handle,
    grant,
    admit,
    async run<T>(member: string, opts: SessionCallOptions, fn: () => Promise<T>): Promise<T> {
      await admit(member);
      let record: Record<string, unknown>;
      try {
        record = await brain.scopeCallerRecord(handle, {
          readOnly: opts.readOnly, privateReadableSources: [...opts.privateReadableSources ?? []],
          privateFactSources: [...opts.privateFactSources ?? []], processPrivacyRelaxed: remotePrivacyHatch(),
        }) as Record<string, unknown>;
      } catch (error) { released = true; asDenied(error, `reason=record member=${member}`); }
      return withoutCallerAccess(() => withCallerAccess(record as Partial<CallerAccess>,
        () => withAccessStore(store, addon, fn, { server: true })));
    },
    release() {
      if (released) return;
      released = true;
      brain.releaseScope(handle);
    },
  };
}
