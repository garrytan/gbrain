/**
 * Multi-user lane L4, audit row B3 (docs/designs/rust-engine/multi-user-server.md, "M2: per-user access"): the
 * caller access record a call on a served brain runs under.
 *
 * Over the owner socket and protocol v3 a client sends the caller's access record with each call (`access`). For the
 * brain owner's floor (the local owner on the Unix socket, or an owner server token) that record is a narrowing claim:
 * the owner's view is trusted local, so a client may only see less. For any other principal the server must not trust
 * a record a client built: the call runs under the record the store built for the principal (`tokenCallerRecord`), and
 * a frame that claims a different record is refused before anything runs. A principal that is not the owner and has no
 * store-built record runs nothing (fail closed). Until ruling A1 lifts, the server admits only the owner, so only the
 * first branch runs.
 */
import { opError } from '../../ops/contract.ts';
import type { CallerAccess } from '../../search/private-visibility.ts';

/** The part of an authenticated principal this decision reads (served/auth.ts `AuthenticatedPrincipal`). */
export interface FramePrincipal {
  readonly kind: string;
  readonly floorRemote: boolean;
  /** The access record the store built for this principal; set for every principal that is not the owner's floor. */
  readonly record?: CallerAccess;
}

/** The kinds whose floor is the owner's trusted local view. */
const OWNER_FLOOR_KINDS: ReadonlySet<string> = new Set(['local_owner', 'owner_token']);

type FrameAccessReason = 'access_mismatch' | 'access_record_missing';

const MESSAGES: Record<FrameAccessReason, string> = {
  access_mismatch: 'The call claimed a caller access record other than the one the server proved for its connection, so nothing ran.',
  access_record_missing: 'The server has no access record for this connection\'s credential, so nothing ran.',
};

function refused(reason: FrameAccessReason, member: string): Error {
  return opError('permission_denied', MESSAGES[reason],
    reason === 'access_mismatch'
      ? 'Send the call without its own access record; the server applies the one it proved. This is a client bug if it repeats.'
      : 'Connect with a credential the server can resolve to a member, or with the brain owner\'s key.',
    { reason, retryable: false, detail: `member=${member} via=served reason=${reason} ran=false written=nothing`,
      why: 'A served brain runs each call under the access the server proved for the connection, never under one a client built.' });
}

/** JSON with object keys sorted at every level, so two records that say the same thing compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v));
}

/**
 * The access record call `member` runs under for `principal`, given the record its frame claims (`claimed`, null when
 * the frame carries none). Null means the principal's own trusted view (the owner, no narrowing). Throws
 * `permission_denied` (`access_mismatch`, `access_record_missing`) before anything runs.
 */
export function frameAccessFor(principal: FramePrincipal, claimed: CallerAccess | null, member: string): CallerAccess | null {
  if (principal.record === undefined && !principal.floorRemote && OWNER_FLOOR_KINDS.has(principal.kind)) return claimed;
  const own = principal.record;
  if (own === undefined) throw refused('access_record_missing', member);
  if (claimed !== null && canonical(claimed) !== canonical(own)) throw refused('access_mismatch', member);
  return own;
}
