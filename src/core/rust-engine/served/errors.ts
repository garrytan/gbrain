/**
 * The typed errors of protocol v3 (docs/designs/rust-engine/multi-user-server.md, "M1 as built", error table). Each
 * says what happened, whether anything ran or was written, the bounded next step, and never advises a local
 * takeover: a served client has no brain of its own to open. No message carries a credential or a token-bearing URL.
 */
import { opError, type OperationError } from '../../ops/contract.ts';
import { confirmingReadAdvice, ownerMemberOnlyReads } from '../owner-ipc/routes.ts';

export type ServedAuthReason = 'token_missing' | 'token_invalid' | 'token_not_owner' | 'token_expired' | 'remote_mismatch';

const AUTH_MESSAGES: Record<ServedAuthReason, string> = {
  token_missing: 'The brain server needs a token in the connection hello, and none was sent, so nothing ran.',
  token_invalid: 'The brain server did not accept the token: it is unknown, revoked or unreadable, so nothing ran.',
  token_not_owner: 'The brain server accepts only the brain owner\'s server token until per-user access is turned on, and this token is not one, so nothing ran.',
  token_expired: 'The token this connection authenticated with has expired or lost its grant, so the server ran nothing more on it.',
  remote_mismatch: 'The call said it came from a trusted local caller, but the connection\'s credential allows only remote callers, so nothing ran.',
};

/** The connection or the call was refused for its credential (`permission_denied`). */
export function servedAuthRefused(reason: ServedAuthReason, member: string | null): OperationError {
  return opError('permission_denied', AUTH_MESSAGES[reason],
    reason === 'remote_mismatch'
      ? 'Send the call without claiming local trust; this is a client bug if it repeats.'
      : 'On the brain server host, create an owner server token with `gbrain auth create <name> --rust-server-owner`, put it in the variable your rust_server.token_env names, and connect again.',
    { reason, retryable: false,
      detail: `${member ? `member=${member} ` : ''}via=served reason=${reason} ran=false written=nothing`,
      why: 'A served Rust brain runs every call with the authority the server proved for the connection. Until per-user access is on, only the brain owner\'s server token gets in.' });
}

export type ServedProtocolReason = 'hello_timeout' | 'hello_too_large' | 'frame_malformed' | 'budget_exhausted';

/** The connection broke a v3 admission rule (`owner_ipc_protocol`); it was closed and nothing ran. */
export function servedProtocol(reason: ServedProtocolReason, detail: string): OperationError {
  const messages: Record<ServedProtocolReason, string> = {
    hello_timeout: 'The connection did not finish its TLS handshake and hello in time, so the brain server closed it; nothing ran.',
    hello_too_large: 'The connection\'s first frame was larger than a hello may be, so the brain server closed it; nothing ran.',
    frame_malformed: 'A frame on the connection was not a valid protocol v3 frame, so the brain server closed it; nothing ran.',
    budget_exhausted: 'The brain server is holding too many partly received frames, so it closed this connection; nothing of the frame ran.',
  };
  return opError('owner_ipc_protocol', messages[reason],
    reason === 'budget_exhausted' ? 'Connect again and resend; if it repeats, the server is overloaded: ask its operator.' : 'Upgrade the client to the server\'s gbrain version and connect again; if it repeats, report it with the reason.',
    { reason, retryable: reason === 'budget_exhausted', detail: `via=served reason=${reason} ${detail}`.trim() });
}

/** The client could not reach or trust the server (`owner_unavailable`); nothing was sent. */
export function servedUnreachable(reason: 'server_unreachable' | 'tls_untrusted', detail: string): OperationError {
  return opError('owner_unavailable',
    reason === 'tls_untrusted'
      ? 'The brain server\'s TLS certificate was not trusted (an unknown authority or a host name that does not match), so no token was sent and nothing ran.'
      : 'The brain server did not answer, so nothing was sent.',
    reason === 'tls_untrusted'
      ? 'Set rust_server.ca_file to the certificate authority that signed the server certificate, check the host name in rust_server.url, then run the command again. Never turn certificate checks off.'
      : 'Check that gbrain serve --rust-listen runs on the server host and that rust_server.url names it, then run the command again.',
    { reason, retryable: reason === 'server_unreachable', detail: `via=served reason=${reason} sent=false ${detail}`.trim(),
      why: 'This process reaches its brain through a brain server; it has no brain of its own to open.' });
}

/**
 * The connection to the server ended after the call was sent: the server may have run it. A read is safe to rerun;
 * a write names the read that confirms it. Never advises opening the brain here.
 */
export function servedGone(member: string, sent: boolean): OperationError {
  return opError('owner_unavailable',
    sent
      ? `The connection to the brain server ended before it answered ${member}; a write may or may not have committed.`
      : `The connection to the brain server ended, so ${member} was not sent.`,
    sent ? `${confirmingReadAdvice(member)} The client resends it with the same request id when it reconnects.` : 'Run the command again once the brain server answers.',
    { reason: sent ? 'outcome_unknown' : 'not_sent', retryable: !sent || ownerMemberOnlyReads(member),
      detail: `member=${member} via=served sent=${sent}`,
      why: 'This process reaches its brain through a brain server. A call in flight when the connection ended may have run there.' });
}

/** Why a write's replica confirmation never came (served/replica-gate.ts). */
export type ReplicationEnd = 'timeout' | 'detached' | 'budget' | 'closed' | 'no_position' | 'cover_failed';

const REPLICATION_END_TEXT: Record<ReplicationEnd, (ms: number) => string> = {
  timeout: ms => `within ${ms} ms`,
  detached: () => 'before the replica was detached',
  closed: () => 'before the brain server closed',
  budget: () => 'because too many answers already waited for it',
  no_position: () => 'because the server could not read the commit position of the write',
  cover_failed: () => 'because the server could not read the replica state',
};

function positionText(p: { sequence: number; index: number } | null): string {
  return p ? `cp1:${p.sequence}.${p.index}` : 'unknown';
}

/**
 * A write committed on the primary, and the attached replica did not confirm it in time (`replication_timeout`,
 * reason `outcome_unknown`). The commit is durable on the primary; a same-id resend reads its stored outcome.
 */
export function servedReplicationTimeout(member: string, req: string, position: { sequence: number; index: number } | null,
  timeoutMs: number, ackedThrough: { sequence: number; index: number } | null, end: ReplicationEnd = 'timeout'): OperationError {
  return opError('replication_timeout',
    `The primary committed request ${req} at ${positionText(position)}, but replica confirmation did not arrive ${REPLICATION_END_TEXT[end](timeoutMs)}. Do not submit a new write.`,
    'Resend the same request id to check its stored outcome; if the replica stays unavailable, the brain-host operator runs the detach step in rust/docs/store/commit-log.md, Replica acks.',
    { reason: 'outcome_unknown', retryable: false,
      detail: `member=${member} via=served req=${req} position=${positionText(position)} acked_through=${positionText(ackedThrough)} durable=primary rerun=false end=${end}`,
      why: 'A brain with an attached replica answers a write only after the replica holds it, so a promoted replica never loses an answered write. Without that confirmation the write is on the primary only.' });
}

/** Too many answers already wait for replica confirmation, so this write did not run (`replication_busy`). */
export function servedReplicationBusy(member: string, req: string, maxWaiters: number): OperationError {
  return opError('replication_busy',
    `${maxWaiters} answers already wait for replica confirmation, so the brain server did not run request ${req} (${member}); nothing was written.`,
    'Retry the same request id after a short wait; if it keeps failing, the brain-host operator checks that the replica is following (rust/docs/store/commit-log.md, Replica acks).',
    { retryable: true, detail: `member=${member} via=served req=${req} max_waiters=${maxWaiters} ran=false written=nothing` });
}

/** A retried request whose outcome the server no longer has; it was not run again. */
export function servedOutcomeUnknown(member: string, req: string): OperationError {
  return opError('owner_unavailable',
    `The brain server has no record of how request ${req} (${member}) ended, so it did not run it again; a write may or may not have committed.`,
    confirmingReadAdvice(member),
    { reason: 'outcome_unknown', retryable: ownerMemberOnlyReads(member), detail: `member=${member} via=served req=${req} rerun=false`,
      why: 'The server keeps the outcome of a request for a while; after a restart or a long wait it is gone, and running a write again could repeat it.' });
}

/** A request id came back with different arguments (`idempotency_conflict`); nothing ran. */
export function servedReqConflict(member: string, req: string): OperationError {
  return opError('idempotency_conflict',
    `Request id ${req} was already used for a different call, so the brain server did not run ${member}.`,
    'Send the call with a new request id; reuse an id only to resend the identical call.',
    { detail: `member=${member} via=served req=${req} ran=false` });
}

/** A read that asked for a position the server had not published by its deadline. */
export function servedPositionNotReached(member: string, wanted: string, published: string | null, ms: number): OperationError {
  return opError('timeout',
    `${member} waited ${ms} ms for the brain to reach position ${wanted} and it did not (published: ${published ?? 'unknown'}); it did not run.`,
    'Retry the read with the same token once within a new deadline; if it still fails, ask the server operator to check that writes are committing.',
    { reason: 'position_not_reached', retryable: true, detail: `member=${member} via=served min_position=${wanted} published=${published ?? 'unknown'} ran=false` });
}

/** A read token that is not `cp1:<sequence>.<index>`, or one this store cannot honour yet. */
export function servedPositionRefused(member: string, why: 'malformed' | 'unsupported'): OperationError {
  return opError('owner_ipc_protocol',
    why === 'malformed'
      ? `${member} carried a read token that is not of the form cp1:<sequence>.<index>, so it did not run.`
      : `${member} carried a read token, and this brain's store mode cannot compare positions yet, so it did not run.`,
    why === 'malformed' ? 'Send the token exactly as a write result gave it.' : 'Send the read without a token, or wait for a gbrain release with per-commit positions.',
    { reason: 'frame_malformed', retryable: false, detail: `member=${member} via=served min_position=${why}` });
}

/** A callback the server called on the client did not answer within its bound. */
export function servedCallbackTimeout(member: string, ms: number): OperationError {
  return opError('timeout',
    `${member} called back into the client, and the client did not answer within ${ms} ms, so the call stopped and its transaction rolled back.`,
    'Retry the call; if it repeats, the client process is stalled or the network is slow.',
    { reason: 'callback_timeout', retryable: true, detail: `member=${member} via=served callback_ms=${ms} written=nothing` });
}

/**
 * The server engine's commit of a transaction over the wire lost to another writer, and it would run the callback
 * again; over the wire that callback belongs to the client, so the server ends the transaction instead and the client
 * runs its callback again from a fresh transaction (served/engine.ts). Nothing of the lost run was kept.
 */
export const SERVED_TXN_CONFLICT_REASON = 'transaction_conflict';
export function servedTransactionConflict(): OperationError {
  return opError('revision_conflict',
    'The transaction lost its commit to another writer, so nothing it wrote was kept.',
    'Run the transaction again from a fresh read; the client does this by itself a bounded number of times.',
    { reason: SERVED_TXN_CONFLICT_REASON, retryable: true, detail: 'member=transaction via=served written=nothing' });
}

/** The client's reruns of a transaction that kept losing its commit ran out (the in-process engine's limit). */
export function servedTransactionContention(attempts: number): OperationError {
  return opError('revision_conflict',
    `The transaction lost to concurrent writers ${attempts} times in a row, so nothing it wrote was kept.`,
    'Retry later, or narrow what the transaction reads and writes.',
    { reason: 'transaction_contention', retryable: true, detail: `member=transaction via=served attempts=${attempts} written=nothing` });
}

/** A transaction over the wire passed its deadline before it committed; it rolled back. */
export function servedTransactionDeadline(ms: number): OperationError {
  return opError('timeout',
    `The transaction did not commit within ${ms} ms, so the brain server rolled it back; nothing of it was written.`,
    'Retry the transaction with fewer steps, or a longer deadline.',
    { reason: 'transaction_deadline', retryable: true, detail: `member=transaction via=served deadline_ms=${ms} written=nothing` });
}

/** A whole operation names a path, and a served client's paths are not the server's. */
export function servedAdminPath(name: string): OperationError {
  return opError('engine_capability_missing',
    `${name} names a file path on the brain server host, and this process reaches the brain over the network, so nothing ran.`,
    'Run it on the brain server host.',
    { reason: 'served', detail: `member=${name} capability=served outcome=none written=nothing via=served`,
      why: 'A served client\'s file paths are its own; the server never reads a path a client names.' });
}
