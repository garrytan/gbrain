/**
 * The brain server's per-member policy for a remote caller's engine member call over the served wire. It runs on both
 * call paths: an ordinary call frame (owner-ipc/server.ts) and a call inside a transaction the caller holds
 * (served/session-calls.ts), against the engine or the transaction handle the call runs on, so no path skips it.
 *
 * The side write a remote caller may make (owner-ipc/routes.ts OWNER_IPC_REMOTE_SIDE_WRITES, ruled 2026-11-26):
 * `bumpPageRetrievals`, the usage stamp a remote read makes in process too.
 *
 * The stamp feeds ranking and sampling (search stale-bias, brainstorm sampling, volunteered context), so a forged stamp
 * could move what other callers see. The brain server therefore stamps only page ids the caller may read: it resolves each
 * id to its page and checks it against the caller's read scope (persistence/page-visibility.ts remotePageAccess, under the
 * caller's access record and remote mark, which the served session set for this call). One id that names no page the
 * caller may read refuses the whole call with `permission_denied`, and nothing is stamped. A local caller's call, and every
 * other member, runs unchanged.
 */
import { opError } from '../../ops/contract.ts';
import { isRemoteCaller } from '../../remote-caller.ts';
import type { BrainEngine } from '../../engine.ts';

type Member = (...args: unknown[]) => Promise<unknown>;

/** The owner's call target for `member` on `engine` (the engine or a transaction handle): the remote caller's check first, else the member itself. */
export function remoteMemberPolicy(engine: object, member: string, method: Member): Member {
  const plain: Member = (...args) => method.apply(engine, args);
  if (member !== 'bumpPageRetrievals') return plain;
  return async (...args) => {
    if (!isRemoteCaller()) return plain(...args);
    const ids = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
    if (!ids.every(id => typeof id === 'number' && Number.isSafeInteger(id))) throw refused(ids.length, 'an id is not a page id');
    if (ids.length === 0) return undefined;
    const typed = engine as BrainEngine;
    const refs = await typed.listPageRefsByIds(ids as number[]);
    const { remotePageAccess } = await import('../../persistence/page-visibility.ts');
    const { readable } = await remotePageAccess(typed, refs.map(r => ({ source_id: r.source_id, slug: r.slug })));
    const allowed = new Set(refs.filter(r => readable.has(`${r.source_id}\u0000${r.slug}`)).map(r => r.id));
    const outside = (ids as number[]).filter(id => !allowed.has(id)).length;
    if (outside > 0) throw refused(ids.length, `${outside} of the ids name no page the caller may read`);
    return plain(...args);
  };
}

function refused(count: number, why: string): Error {
  return opError('permission_denied', `The retrieval stamp was refused: ${why}, so nothing was stamped.`,
    'A remote caller stamps only pages it read; this is a client bug if it repeats.',
    { reason: 'stamp_out_of_scope', retryable: false, detail: `member=bumpPageRetrievals via=served ids=${count} written=nothing` });
}
