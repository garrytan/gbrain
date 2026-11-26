/**
 * Multi-user Rust over HTTP (rust-engine/served/http-session.ts; design note I-6): a remote call in the store session the
 * request's bearer token opened runs in `session.run`, under the caller record the store builds. The record dispatch.ts
 * would build, and the access_control refusal, do not apply to it.
 */
import { opError, type OperationError } from '../core/ops/contract.ts';
import type { DispatchOpts } from './dispatch.ts';

export interface PrincipalSessionRunner {
  run<T>(member: string, opts: { readOnly: boolean; privateReadableSources?: readonly string[]; privateFactSources?: readonly string[] }, fn: () => Promise<T>): Promise<T>;
}

/** Runs one call in the session, with the grant's private sources a read may use. */
export function runInSession<T>(session: PrincipalSessionRunner, name: string, readOnly: boolean, privateSources: readonly string[] | undefined,
  privateFactSources: readonly string[] | undefined, fn: () => Promise<T>): Promise<T> {
  return session.run(name, { readOnly, privateReadableSources: privateSources ?? [], privateFactSources: privateFactSources ?? [] }, fn);
}

/**
 * A request in a multi-user Rust session that names another identity (an actor, an audience, an on-behalf-of person, a
 * guest or a room): refused, because the store session does not model them yet and ignoring them could widen access.
 */
export function sessionHeaderRefusal(opts: DispatchOpts): OperationError | null {
  const named = [opts.actor?.header, opts.actor?.audience, (opts.onBehalfOf as { header?: unknown } | undefined)?.header,
    (opts.guest as { header?: unknown } | undefined)?.header, (opts.room as { header?: unknown } | undefined)?.header];
  if (!named.some(v => typeof v === 'string' && v !== '') && !opts.enforcedMember) return null;
  return opError('permission_denied', 'This brain serves only the owner\'s own key over HTTP for now, so a request that names another person, audience, guest or room is refused.',
    'Send the request without x-qm-actor, audience, on-behalf-of, guest or room headers.', { detail: 'reason=session_identity_header' });
}

