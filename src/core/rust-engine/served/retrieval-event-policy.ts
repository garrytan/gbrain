/**
 * The brain server's check on the retrieval event a remote caller sends (`insertRetrievalEvents`, a member of
 * owner-ipc/routes.ts OWNER_IPC_REMOTE_SIDE_WRITES). Called by remote-member-policy.ts on both call paths, against the
 * engine or the transaction handle the call runs on. A local caller's call runs unchanged.
 *
 * The event feeds later ratings and the ranking weights, so the server stores it only when all of this holds, and
 * refuses the whole batch with `permission_denied` (nothing written) otherwise:
 *   - the call frame carries a claim (member-claim.ts) and every event names exactly that claim's client;
 *   - each event is well formed and bounded (answer id, op, page and link counts, field sizes);
 *   - every page, link target and edge end the event names, that names a stored page, is a page the caller may read
 *     (persistence/page-visibility.ts remotePageAccess) and, when the claim lists sources, in the claim's sources. A
 *     slug that names no page is harmless: the store keeps rows for existing pages only;
 *   - the answer id is not another client's: an id already stored for a different client or op refuses (`answer_id_taken`),
 *     and an exact retry (same client and op) writes nothing, so a stored answer never grows. Ids are locked in this
 *     process from the check to the write, so two calls cannot both pass the check for one id. The lock does not span a
 *     transaction frame's commit, and two server processes do not share it: a transaction frame can still race a retry of
 *     the same id until its commit (reported, not closed here: that needs a store-level conflict rule).
 */
import { opError } from '../../ops/contract.ts';
import { currentMemberClaim, type MemberClaim } from '../../member-claim.ts';
import { ANSWER_ID_RE } from '../../feedback/answer-id.ts';
import type { BrainEngine } from '../../engine.ts';

type Member = (...args: unknown[]) => Promise<unknown>;
type Raw = Record<string, unknown>;

const OPS: ReadonlySet<string> = new Set(['query', 'search', 'think', 'synthesize', 'recall']);
const MAX_EVENTS = 100;
const MAX_PAGES = 500;
const MAX_LINKS = 2000;
const MAX_TEXT = 1024;
const MAX_EDGE = 3200;
const MAX_RANK = 1_000_000;

const locks = new Map<string, Promise<void>>();

function refused(reason: string, why: string, detail = ''): Error {
  return opError('permission_denied', `The retrieval event was refused: ${why}, so nothing was stored.`,
    'A remote caller stores only its own answers, for pages it may read; this is a client bug if it repeats.',
    { reason, retryable: false, detail: `member=insertRetrievalEvents via=served written=nothing${detail ? ` ${detail}` : ''}` });
}

const isObject = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

interface Ref { source_id: string; slug: string }

/** The shape and bounds of the batch; returns the events and every page row they name. */
function checked(args: readonly unknown[], claim: MemberClaim): { events: Raw[]; refs: Ref[] } {
  const events = args[0];
  if (args.length !== 1 || !Array.isArray(events) || events.length < 1 || events.length > MAX_EVENTS) throw refused('event_malformed', `the batch is not 1 to ${MAX_EVENTS} events`);
  const ids = new Set<string>();
  const refs = new Map<string, Ref>();
  // A non-empty allowlist replaces the scalar source (sourceScopeOpts' precedence). With no allowlist the claim's scalar
  // source may be the 'default' a claim fills in for an unscoped caller, so no source is checked; page readability still is.
  const allowed = claim.allowedSources && claim.allowedSources.length > 0 ? new Set(claim.allowedSources) : null;
  const note = (source: unknown, slug: unknown): void => {
    if (!isText(source) || !isText(slug)) throw refused('event_malformed', 'a page or link names no source and slug');
    if (allowed && !allowed.has(source)) throw refused('source_out_of_scope', 'a page or link names a source outside the caller\'s sources');
    refs.set(`${source}\u0000${slug}`, { source_id: source, slug });
  };
  for (const e of events as unknown[]) {
    if (!isObject(e) || !isText(e.id, 64) || !ANSWER_ID_RE.test(e.id)) throw refused('event_malformed', 'an event has no valid answer id');
    if (ids.has(e.id)) throw refused('event_malformed', 'an answer id repeats in the batch');
    ids.add(e.id);
    if (e.client_id !== claim.clientId) throw refused('client_mismatch', 'an event names a client other than the caller\'s');
    if (typeof e.op !== 'string' || !OPS.has(e.op)) throw refused('event_malformed', 'an event has an unknown op');
    if (!Array.isArray(e.pages) || e.pages.length > MAX_PAGES || !Array.isArray(e.links) || e.links.length > MAX_LINKS) {
      throw refused('event_malformed', `an event has no page list of at most ${MAX_PAGES} or no link list of at most ${MAX_LINKS}`);
    }
    for (const p of e.pages as unknown[]) {
      if (!isObject(p) || typeof p.cited !== 'boolean' || !(p.content_hash === null || isText(p.content_hash, 128))
        || typeof p.rank !== 'number' || !Number.isInteger(p.rank) || p.rank < 0 || p.rank > MAX_RANK) throw refused('event_malformed', 'a page entry is malformed');
      note(p.source_id, p.slug);
    }
    for (const l of e.links as unknown[]) {
      if (!isObject(l) || !isText(l.edge_key, MAX_EDGE)) throw refused('event_malformed', 'a link entry is malformed');
      const ends = (l.edge_key as string).split('|');
      if (ends.length < 3) throw refused('event_malformed', 'a link edge key is not from|type|to');
      note(l.source_id, l.to_slug);
      note(l.source_id, ends[0]);
      note(l.source_id, ends[ends.length - 1]);
    }
  }
  return { events: events as Raw[], refs: [...refs.values()] };
}

/** Holds the in-process lock of every id (taken in sorted order, so two batches cannot deadlock) while `fn` runs. */
async function locked<T>(ids: readonly string[], fn: () => Promise<T>): Promise<T> {
  const releases: Array<() => void> = [];
  try {
    for (const id of [...ids].sort()) {
      const before = locks.get(id) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>(resolve => { release = resolve; });
      const tail = before.then(() => mine);
      locks.set(id, tail);
      releases.push(() => { release(); if (locks.get(id) === tail) locks.delete(id); });
      await before;
    }
    return await fn();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/** The call target for `insertRetrievalEvents` on `engine`: the remote caller's checks first, else the member itself. */
export function retrievalEventPolicy(engine: object, plain: Member, isRemote: () => boolean): Member {
  return async (...args) => {
    if (!isRemote()) return plain(...args);
    const claim = currentMemberClaim();
    if (!claim) throw refused('claim_required', 'the call names no client it is for');
    const { events, refs } = checked(args, claim);
    const typed = engine as BrainEngine;
    const { remotePageAccess } = await import('../../persistence/page-visibility.ts');
    const { known, readable } = await remotePageAccess(typed, refs);
    if (known.size > readable.size) throw refused('read_out_of_scope', `${known.size - readable.size} of the pages it names are pages the caller may not read`);
    return locked(events.map(e => e.id as string), async () => {
      const fresh: Raw[] = [];
      for (const e of events) {
        const stored = await typed.readRetrievalEvent(e.id as string);
        if (!stored) { fresh.push(e); continue; }
        if (stored.client_id !== e.client_id || stored.op !== e.op) throw refused('answer_id_taken', 'the answer id is already stored for another client or op');
      }
      if (fresh.length > 0) await plain(fresh);
      return undefined;
    });
  };
}
