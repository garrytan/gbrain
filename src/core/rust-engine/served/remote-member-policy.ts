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
 * caller may read refuses the whole call with `permission_denied`, and nothing is stamped. The same page-id pre-check guards
 * the reads keyed by page ids the client chose (PAGE_ID_GUARDS), with reason `read_out_of_scope`. A local caller's call,
 * and every member off the table, runs unchanged.
 */
import { opError } from '../../ops/contract.ts';
import { isRemoteCaller } from '../../remote-caller.ts';
import type { BrainEngine } from '../../engine.ts';

type Member = (...args: unknown[]) => Promise<unknown>;
/** The page ids one call names, read from its arguments; a value that is not a list of safe integers is refused. */
type PageIds = (args: readonly unknown[]) => unknown;

/**
 * The page-id pre-check: every page id the call names must name a page the caller may read, else the whole call is
 * refused with `permission_denied` and nothing runs. An empty id list runs the member (its own empty answer).
 */
interface PageIdGuard { ids: PageIds; reason: string; what: string }

const one: PageIds = args => [args[0]];
const list: PageIds = args => args[0];
const read = (what: string, ids: PageIds): PageIdGuard => ({ ids, reason: 'read_out_of_scope', what });

/** The closed guard table: members a remote caller reaches whose answer is keyed by page ids the client chose. */
const PAGE_ID_GUARDS: Readonly<Record<string, PageIdGuard>> = {
  bumpPageRetrievals: { ids: list, reason: 'stamp_out_of_scope', what: 'The retrieval stamp' },
  readPageFeedbackWeights: read('The feedback weights read', list),
  readBriefPageVersions: read('The page versions read', one),
  readPageDateFieldsByIds: read('The page dates read', list),
  readSegmentedPageHead: read('The segmented page head read', one),
  readSegmentedVersionBodyBytes: read('The segmented body size read', one),
  readBodyManifestMeta: read('The body manifest read', one),
  readBodyManifestRows: read('The body manifest read', one),
  readGuestMarks: read('The guest marks read', list),
};

/** The owner's call target for `member` on `engine` (the engine or a transaction handle): the remote caller's check first, else the member itself. */
export function remoteMemberPolicy(engine: object, member: string, method: Member): Member {
  const plain: Member = (...args) => method.apply(engine, args);
  const guard = Object.hasOwn(PAGE_ID_GUARDS, member) ? PAGE_ID_GUARDS[member]! : undefined;
  if (!guard) return plain;
  return async (...args) => {
    if (!isRemoteCaller()) return plain(...args);
    const raw = guard.ids(args);
    const ids = Array.isArray(raw) ? (raw as unknown[]) : [raw];
    if (!ids.every(id => typeof id === 'number' && Number.isSafeInteger(id))) throw refused(member, guard, ids.length, 'an id is not a page id');
    if (ids.length === 0) return plain(...args);
    const typed = engine as BrainEngine;
    const refs = await typed.listPageRefsByIds([...new Set(ids as number[])]);
    const { remotePageAccess } = await import('../../persistence/page-visibility.ts');
    const { readable } = await remotePageAccess(typed, refs.map(r => ({ source_id: r.source_id, slug: r.slug })));
    const allowed = new Set(refs.filter(r => readable.has(`${r.source_id}\u0000${r.slug}`)).map(r => r.id));
    const outside = (ids as number[]).filter(id => !allowed.has(id)).length;
    if (outside > 0) throw refused(member, guard, ids.length, `${outside} of the ids name no page the caller may read`);
    return plain(...args);
  };
}

function refused(member: string, guard: PageIdGuard, count: number, why: string): Error {
  const stamp = guard.reason === 'stamp_out_of_scope';
  return opError('permission_denied', `${guard.what} was refused: ${why}, so nothing ${stamp ? 'was stamped' : 'was read'}.`,
    stamp ? 'A remote caller stamps only pages it read; this is a client bug if it repeats.'
      : 'A remote caller reads only pages it may read; this is a client bug if it repeats.',
    { reason: guard.reason, retryable: false, detail: `member=${member} via=served ids=${count} ${stamp ? 'written' : 'read'}=nothing` });
}
