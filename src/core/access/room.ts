/**
 * GBRA-498: room-aware results. When a harness says an answer is going into a shared room (a group chat), a read
 * still returns exactly what the caller reads; every returned item gains `room_access`, saying whether the room's
 * audience could have read it itself and, when not, why. One notice tells the agent to use everything for the work,
 * keep what the room cannot read out of the reply unless the ask needs it, and offer the rest in a private chat.
 *
 * Three rules hold everywhere in this module: a room never refuses, shortens or fails a read (every problem becomes
 * `readable: "unknown"` plus a degraded notice); with no room the result is untouched; and nothing here changes what
 * any caller reads. The decision per page is the same predicate an on_behalf_of read of the room applies
 * (privatePagesFilterForCaller under the room's own access record), so "readable: true" means exactly "a read as the
 * room would have returned it". Channels: request-level `_meta.room` or the X-Gbrain-Room header (the harness's,
 * authoritative), or a `room` tool argument, which can only add people to the harness's room.
 */
import type { BrainEngine } from '../engine.ts';
import type { AuthInfo } from '../ops/contract.ts';
import type { Action, Notice } from '../agent-output.ts';
import { logAudienceAssertion, normalizePrincipals, type AudiencePrincipal } from './audience.ts';
import { audienceCallerAccess, resolveAudienceIdentities } from './caller.ts';
import { ownerMemberId } from './owner.ts';
import { factVisibilitySql } from './member-facts.ts';
import { hiddenPersonalSources } from './member-sources.ts';
import {
  callerIdentities, currentCallerAccess, folderRulesAllowedSql, labelledOnlyForSql, privacyForCaller, privacyPartSql,
  privatePagesFilterForCaller, privateProvenanceFilterUnderPolicy, readersAllowedSql, withCallerAccess, worldOnlyFacts,
  type CallerAccess,
} from '../search/private-visibility.ts';

export const ROOM_HEADER = 'X-Gbrain-Room';
export const ROOM_ARGUMENT = 'room';
/** The per-item key. Namespaced so it never collides with a page field or frontmatter key named room. */
export const ROOM_ACCESS_KEY = 'room_access';
/** Assessment budget per call: past it every item is unknown and the read goes out unchanged otherwise. */
export const ROOM_DEADLINE_MS = 3_000;
/** At most this many distinct refs are judged per call; the rest are unknown. */
export const ROOM_MAX_REFS = 2_000;

/** Why the room could not read an item. */
export type RoomReason = 'readers' | 'folder_rule' | 'labelled_only' | 'private_label' | 'derived' | 'personal_source';
/** Why an item, or the whole answer, could not be judged. */
export type RoomUnknownReason = 'invalid' | 'not_permitted' | 'unknown_principal' | 'unbound' | 'mark_failed' | 'deadline' | 'response_cap'
  | 'op_not_covered' | 'not_found' | 'not_identified' | 'over_limit' | 'not_supported';
export type RoomAccess = { readable: true } | { readable: false; reason: RoomReason } | { readable: 'unknown'; reason: RoomUnknownReason };

/** The room channels a transport saw: the header and request-level _meta (its `room` key). */
export interface RoomChannels { header?: string | null; requestMeta?: unknown }

export interface RoomDeclaration {
  /** The effective room: the harness's room plus any principal the argument adds (never fewer). */
  principals: AudiencePrincipal[];
  declared_by: 'harness' | 'argument';
  /** The argument (or the two harness channels) named a different room than the harness; the union was used. */
  conflict: boolean;
  /** A channel was malformed (or present but empty): every item is unknown. */
  invalid: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseChannel(value: unknown, channel: string): AudiencePrincipal[] | { invalid: string } {
  if (typeof value === 'string') return normalizePrincipals(value.trim() === '' ? [] : value.split(',').map(s => s.trim()), channel);
  if (Array.isArray(value)) return normalizePrincipals(value, channel);
  return { invalid: `${channel} is not a list of member ids, group:<id> or guest` };
}

/**
 * The room a call declares, or null when it declares none, and the tool arguments with `room` removed (so no
 * handler, cache, retry call or stored write intent ever sees it). Never throws: a malformed or empty channel is a
 * declared room that could not be read (`invalid`), so the answer is still marked, all unknown.
 */
export function readRoomDeclaration(channels: RoomChannels | undefined, args: Record<string, unknown> | undefined): { declaration: RoomDeclaration | null; args: Record<string, unknown> | undefined } {
  const meta = isObj(channels?.requestMeta) ? channels!.requestMeta as Record<string, unknown> : null;
  const metaPresent = !!meta && Object.prototype.hasOwnProperty.call(meta, ROOM_ARGUMENT);
  const headerPresent = channels?.header !== undefined && channels?.header !== null;
  const argPresent = !!args && Object.prototype.hasOwnProperty.call(args, ROOM_ARGUMENT);
  let rest = args;
  if (argPresent) { const { [ROOM_ARGUMENT]: _dropped, ...others } = args!; rest = others; }
  if (!metaPresent && !headerPresent && !argPresent) return { declaration: null, args: rest };
  const parsed: Array<{ from: 'harness' | 'argument'; value: AudiencePrincipal[] | { invalid: string } }> = [];
  if (headerPresent) parsed.push({ from: 'harness', value: parseChannel(channels!.header, `the ${ROOM_HEADER} header`) });
  if (metaPresent) parsed.push({ from: 'harness', value: parseChannel(meta![ROOM_ARGUMENT], '_meta.room') });
  if (argPresent) parsed.push({ from: 'argument', value: parseChannel(args![ROOM_ARGUMENT], 'the room argument') });
  const invalid = parsed.find(p => 'invalid' in p.value);
  const lists = parsed.filter(p => Array.isArray(p.value)) as Array<{ from: 'harness' | 'argument'; value: AudiencePrincipal[] }>;
  const harness = lists.filter(p => p.from === 'harness');
  const principals = [...new Set(lists.flatMap(p => p.value))].sort() as AudiencePrincipal[];
  const keys = lists.map(p => p.value.join(','));
  return {
    declaration: {
      principals,
      declared_by: headerPresent || metaPresent ? 'harness' : 'argument',
      conflict: new Set(keys).size > 1 && (harness.length > 0 || lists.length > 1),
      invalid: invalid ? (invalid.value as { invalid: string }).invalid : null,
    },
    args: rest,
  };
}

type PageRef = { kind: 'page'; source_id: string; slug: string } | { kind: 'page_id'; id: number };
type FactRef = { kind: 'fact'; id: number };
type Ref = PageRef | FactRef;
/**
 * One marked item: its own ref, plus the other pages that gate it (a timeline event's page, a link's target and origin).
 * `unknown` marks it unknown whatever its refs decide (a think answer built partly from takes, which carry no page or fact id here).
 */
interface Slot { holder: Record<string, unknown>; ref: Ref | null; also?: Ref[]; unknown?: RoomUnknownReason }

/** What a think answer was built from: every page, take and fact its synthesis retrieved (the trust taint refs). */
export type RoomEvidence = ReadonlyArray<{ table: 'pages'; sourceId: string; slug: string } | { table: string; id: number }>;
const ROOM_EVIDENCE = Symbol('gbrain.room_evidence');
/**
 * Keeps a think answer's evidence on its result for room marking. Symbol-keyed, so object spread keeps it while JSON
 * and structuredClone drop it: it never reaches a response, a stored write or a log.
 */
export function keepRoomEvidence<T extends object>(result: T, evidence: RoomEvidence | undefined): T {
  if (evidence) (result as Record<symbol, unknown>)[ROOM_EVIDENCE] = evidence;
  return result;
}
/** A think answer is marked at the strictest class of all its evidence; without recorded evidence, or with a take, it is unknown. */
function thinkSlot(r: unknown, original: unknown): Slot | null {
  if (!isObj(r)) return null;
  const evidence = isObj(original) ? (original as Record<symbol, unknown>)[ROOM_EVIDENCE] : undefined;
  if (!Array.isArray(evidence) || evidence.length === 0) return { holder: r, ref: null };
  const refs: Ref[] = [];
  let takes = false;
  for (const e of evidence as RoomEvidence) {
    if (e.table === 'pages' && 'slug' in e) refs.push({ kind: 'page', source_id: e.sourceId, slug: e.slug });
    else if (e.table === 'facts' && 'id' in e) refs.push({ kind: 'fact', id: e.id });
    else takes = true;
  }
  return { holder: r, ref: refs[0] ?? null, also: refs.slice(1), ...(takes ? { unknown: 'not_identified' as const } : {}) };
}

const str = (v: unknown) => typeof v === 'string' && v ? v : undefined;
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
function pageSlot(o: unknown, src: string): Slot | null {
  if (!isObj(o)) return null;
  return { holder: o, ref: typeof o.slug === 'string' ? { kind: 'page', source_id: str(o.source_id) ?? src, slug: o.slug } : null };
}
function pageIdSlot(o: unknown): Slot | null {
  if (!isObj(o)) return null;
  return { holder: o, ref: typeof o.page_id === 'number' ? { kind: 'page_id', id: o.page_id } : null };
}
function factSlot(o: unknown): Slot | null {
  if (!isObj(o)) return null;
  const id = typeof o.id === 'number' ? o.id : typeof o.id === 'string' && /^\d+$/.test(o.id) ? Number(o.id) : null;
  return { holder: o, ref: id === null ? null : { kind: 'fact', id } };
}
function timelineSlot(o: unknown): Slot | null {
  const s = pageIdSlot(o);
  if (s && typeof s.holder.event_page_id === 'number') s.also = [{ kind: 'page_id', id: s.holder.event_page_id }];
  return s;
}
function linkSlot(o: unknown, src: string): Slot | null {
  if (!isObj(o) || typeof o.from_slug !== 'string') return pageSlot(o, src);
  const also: Ref[] = [];
  if (typeof o.to_slug === 'string') also.push({ kind: 'page', source_id: str(o.to_source_id) ?? src, slug: o.to_slug });
  if (typeof o.origin_slug === 'string') also.push({ kind: 'page', source_id: str(o.origin_source_id) ?? src, slug: o.origin_slug });
  return { holder: o, ref: { kind: 'page', source_id: str(o.from_source_id) ?? src, slug: o.from_slug }, also };
}
function listOf(r: unknown): unknown[] {
  if (Array.isArray(r)) return r;
  if (isObj(r)) return Array.isArray(r.pages) ? r.pages : Array.isArray(r.results) ? r.results : Array.isArray(r.rows) ? r.rows : [];
  return [];
}
const SKIP_KEYS = new Set(['next', 'arguments', 'fix', 'verify', 'coverage', '_meta', ROOM_ACCESS_KEY]);
/** entity and other composites: every object naming a page by slug, and every fact row in a `facts` list. */
function walk(v: unknown, src: string, out: Slot[], depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(v)) { for (const x of v) walk(x, src, out, depth + 1); return; }
  if (!isObj(v)) return;
  // A nested row without its own source_id belongs to the nearest enclosing object that names one (entity cards span sources).
  src = str(v.source_id) ?? (isObj(v.entity) ? str(v.entity.source_id) : undefined) ?? src;
  if (typeof v.slug === 'string') out.push(pageSlot(v, src)!);
  for (const [k, x] of Object.entries(v)) {
    if (SKIP_KEYS.has(k)) continue;
    if ((k === 'facts' || k === 'recent_facts') && Array.isArray(x)) { for (const f of x) { const s = factSlot(f); if (s) out.push(s); } continue; }
    walk(x, src, out, depth + 1);
  }
}

/**
 * Ops whose items room marking covers, and where their items are (`original` is the handler's own object, for evidence
 * kept off the response). Every other op answers op_not_covered.
 */
const EXTRACTORS: Record<string, (result: unknown, src: string, original: unknown) => Array<Slot | null>> = {
  get_page: (r, src) => [pageSlot(r, src)],
  search: (r, src) => listOf(r).map(i => pageSlot(i, src)),
  query: (r, src) => listOf(r).map(i => pageSlot(i, src)),
  list_pages: (r, src) => listOf(r).map(i => pageSlot(i, src)),
  find_pages: (r, src) => listOf(r).map(i => pageSlot(i, src)),
  get_chunks: r => arr(r).map(pageIdSlot),
  get_timeline: r => arr(r).map(timelineSlot),
  get_backlinks: (r, src) => listOf(r).map(i => linkSlot(i, src)),
  recall: (r, src) => isObj(r) ? [...arr(r.facts).map(factSlot), ...arr(r.results).map(i => pageSlot(i, src))] : [],
  entity: (r, src) => { const out: Slot[] = []; walk(r, src, out); return out; },
  think: (r, _src, original) => [thinkSlot(r, original)],
  put_page: (r, src) => [pageSlot(r, src)],
  remember: r => isObj(r) && Array.isArray(r.items) ? r.items.map(factSlot) : [factSlot(r)],
};
/** Writes mark their own result, but a write's answer is never stamped degraded for its marks: a committed write must not read as one to retry. */
const ROOM_WRITE_OPS: ReadonlySet<string> = new Set(['put_page', 'remember']);
export const ROOM_COVERED_OPS: ReadonlySet<string> = new Set(Object.keys(EXTRACTORS));

const refKey = (r: Ref) => r.kind === 'page' ? `p:${r.source_id}:${r.slug}` : r.kind === 'page_id' ? `i:${r.id}` : `f:${r.id}`;
const refOut = (r: Ref) => r.kind === 'page' ? { source_id: r.source_id, slug: r.slug } : r.kind === 'page_id' ? { page_id: r.id } : { fact_id: r.id };

interface PageRow { id: number; source_id: string; slug: string; ok: boolean; readers_ok: boolean; folder_ok: boolean; labelled_ok: boolean; privacy_ok: boolean }
interface FactRow { id: number; ok: boolean; world: boolean }

function pageReason(r: PageRow): RoomAccess {
  if (r.ok) return { readable: true };
  const reason: RoomReason = !r.readers_ok ? 'readers' : !r.folder_ok ? 'folder_rule' : !r.labelled_ok ? 'labelled_only' : !r.privacy_ok ? 'private_label' : 'derived';
  return { readable: false, reason };
}

/** The room's decisions for the refs, judged under the room's own access record (the same predicates its reads use). */
async function decide(engine: BrainEngine, access: Partial<CallerAccess>, principals: AudiencePrincipal[], refs: Ref[]): Promise<Map<string, RoomAccess>> {
  const pages = refs.filter((r): r is Extract<Ref, { kind: 'page' }> => r.kind === 'page');
  const ids = refs.filter((r): r is Extract<Ref, { kind: 'page_id' }> => r.kind === 'page_id').map(r => r.id);
  const facts = refs.filter((r): r is FactRef => r.kind === 'fact').map(r => r.id);
  const { pageSql, factSql } = withCallerAccess(access, () => {
    const room = currentCallerAccess();
    const readers = callerIdentities().map(identity => readersAllowedSql('p', identity)).join(' AND ');
    const labelled = room.labelledOnly ? labelledOnlyForSql('p', callerIdentities(), room.satisfiedRuleIds) : 'TRUE';
    return {
      pageSql: `SELECT p.id, p.source_id, p.slug, (${privatePagesFilterForCaller('p')}) AS ok, (${readers}) AS readers_ok,
        (${folderRulesAllowedSql('p', room.satisfiedRuleIds)}) AS folder_ok, (${labelled}) AS labelled_ok,
        (${privacyForCaller('p', privacyPartSql('p'))}) AS privacy_ok
        FROM pages p WHERE p.id = ANY($3::int[]) OR (p.source_id, p.slug) IN (SELECT u.s, u.g FROM unnest($1::text[], $2::text[]) AS u(s, g))`,
      factSql: `SELECT f.id, (${worldOnlyFacts(true) ? factVisibilitySql('f', ['world']) : 'TRUE'} AND ${privateProvenanceFilterUnderPolicy('f')}) AS ok,
        f.visibility = 'world' AS world FROM facts f WHERE f.id = ANY($1::bigint[])`,
    };
  });
  const out = new Map<string, RoomAccess>();
  if (pages.length || ids.length) {
    const rows = await engine.executeRaw<PageRow>(pageSql, [pages.map(p => p.source_id), pages.map(p => p.slug), ids]);
    const sources = [...new Set(rows.filter(r => r.ok).map(r => r.source_id))];
    const personal = new Set<string>();
    for (const p of principals) {
      for (const s of await hiddenPersonalSources(engine, sources, p.startsWith('member:') ? p.slice('member:'.length) : '', false)) personal.add(s);
    }
    for (const row of rows) {
      const access: RoomAccess = row.ok && personal.has(row.source_id) ? { readable: false, reason: 'personal_source' } : pageReason(row);
      out.set(`p:${row.source_id}:${row.slug}`, access);
      out.set(`i:${row.id}`, access);
    }
  }
  if (facts.length) {
    for (const row of await engine.executeRaw<FactRow>(factSql, [facts])) {
      out.set(`f:${row.id}`, row.ok ? { readable: true } : { readable: false, reason: row.world ? 'derived' : 'private_label' });
    }
  }
  return out;
}

/** Who asks for the marks: the call's own access record (the owner is exempt from may_act_for), credential and transport. */
export interface RoomCaller {
  access: CallerAccess;
  auth?: AuthInfo;
  transport?: string;
  stdioMember?: string;
  /** An attested actor call (x-qm-actor): never marked. */
  attested?: boolean;
  /**
   * The trusted local CLI: it marks the view it reads, the brain owner's (or the member `--as` names), so it needs no
   * may_act_for. With no owner set and no `--as`, it is bound to no one and every item is unknown.
   */
  local?: true;
}

export interface RoomMeta {
  principals: AudiencePrincipal[];
  declared_by: 'harness' | 'argument';
  conflict?: true;
  /** Every item was judged (true), or at least one is unknown (false). */
  complete: boolean;
  counts: { items: number; readable: number; above: number; unknown: number };
  by_reason: Record<string, number>;
  /** The refs of every item the room could not read or that is unknown, for a harness that tracks what entered a room. */
  above: Array<Record<string, unknown>>;
  /** Why no item could be judged, when that is the case. */
  unavailable?: RoomUnknownReason;
}

export interface RoomOutcome {
  /** The notices the degraded stamp may read: a tool that marks nothing (op_not_covered) is not a partial answer. */
  stamped: Notice[];
  /** A detached copy of the result with room_access on every item (the original object is never written). */
  result: unknown;
  meta: RoomMeta;
  notices: Notice[];
}

class RoomUnavailable extends Error {
  constructor(readonly reason: RoomUnknownReason, readonly detail?: string, readonly fix?: Action) { super(reason); }
}

const OWNER_SET_FIX: Action = { ask_user: true, argv: ['gbrain', 'access', 'owner', 'set', '<MEMBER>'], consent: [], actor: 'user', requires_exclusive: false,
  inputs: [{ name: 'MEMBER', how: 'Ask the user which enabled member is the brain owner (gbrain access member list), or pass --as <member> to mark that member\'s view instead.' }],
  why: 'Names the brain owner, whose view the CLI compares with the room. Choosing the owner is the user\'s decision.' };

async function roomAccessFor(engine: BrainEngine, caller: RoomCaller, principals: AudiencePrincipal[]): Promise<Partial<CallerAccess>> {
  if (caller.attested) throw new RoomUnavailable('unbound', 'an attested actor call is not marked for a room');
  const bound = caller.access.owner || caller.access.identity.some(p => p.startsWith('member:'))
    || (caller.local === true && await ownerMemberId(engine) !== null);
  if (!bound && caller.local) throw new RoomUnavailable('unbound', 'this brain names no owner, so the CLI cannot say whose view to compare with the room', OWNER_SET_FIX);
  if (!bound) throw new RoomUnavailable('unbound', 'this connection is bound to no member, so it cannot ask what a room may read');
  let identities: string[][];
  try {
    identities = await resolveAudienceIdentities(engine, { auth: caller.auth, transport: caller.transport }, principals,
      { mayActFor: caller.access.owner || caller.local ? 'owner_room_assessment' : 'enforce' });
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '');
    const detail = e instanceof Error ? e.message.replace('so nothing was read', 'so the answer carries no room marks') : undefined;
    if (code === 'on_behalf_of_not_permitted') throw new RoomUnavailable('not_permitted', detail, (e as { fix?: Action }).fix);
    if (code === 'on_behalf_of_unknown_member') throw new RoomUnavailable('unknown_principal', detail);
    throw new RoomUnavailable('mark_failed');
  }
  // A room is judged without the calling credential's private-pages grant: that grant is the caller's, never the room's.
  return audienceCallerAccess(engine, caller.auth, [], caller.transport, principals, identities, caller.stdioMember, true);
}

let deadlineForTests: { ms: number; delay: () => Promise<void> } | null = null;
/** Test seam: a shorter deadline and a slow judgment, so the deadline path runs through dispatch. */
export function __setRoomDeadlineForTests(v: { ms: number; delay: () => Promise<void> } | null): void { deadlineForTests = v; }

/** Rejects with deadline after ms; onLate tells the raced work to start no further queries. */
function withDeadline<T>(p: Promise<T>, ms: number, onLate: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { onLate(); reject(new RoomUnavailable('deadline')); }, ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const UNAVAILABLE_WHY: Record<RoomUnknownReason, string> = {
  invalid: 'The room this call declared could not be read',
  not_permitted: 'This connection may not ask what that room may read',
  unknown_principal: 'The room names someone who is not a member or group on this brain',
  unbound: 'This connection is bound to no member, so it cannot ask what a room may read',
  mark_failed: 'Judging what the room may read failed (retrying is safe; nothing was changed)',
  deadline: 'Judging what the room may read took too long (retrying is safe; nothing was changed)',
  response_cap: 'The marked answer would not fit this connection, so the answer went out without its room marks',
  op_not_covered: 'This tool does not mark its results for a room',
  not_found: 'Some items could not be found again to judge',
  not_identified: 'Some items carry no page or fact id to judge',
  over_limit: `More than ${ROOM_MAX_REFS} items were returned, so the rest were not judged`,
  not_supported: 'The brain this command reached does not mark answers for a room (it predates room marks)',
};

/** The notice an answer carries when its room marks had to be dropped to fit the connection's response cap. */
export function roomResponseCapNotice(): Notice {
  return { code: 'room_hints_unavailable', kind: 'degraded',
    why: `${UNAVAILABLE_WHY.response_cap}. The answer is complete; treat all of it as above this room's level: use it for the work, keep it out of the reply unless the ask needs it, and offer it in a private chat. [reason: response_cap]` };
}

function emptyMeta(d: RoomDeclaration): RoomMeta {
  return { principals: d.principals, declared_by: d.declared_by, ...(d.conflict ? { conflict: true as const } : {}), complete: true,
    counts: { items: 0, readable: 0, above: 0, unknown: 0 }, by_reason: {}, above: [] };
}

export interface RoomInput {
  op: string; result: unknown; hotMemory?: unknown; retrieval?: unknown; declaration: RoomDeclaration; caller: RoomCaller; sourceId: string; deadlineMs?: number;
  /** The items cannot be judged here (a transport that reached no marking brain): every item is marked unknown for this reason. */
  unavailable?: { reason: RoomUnknownReason; detail?: string };
}

/**
 * Marks `result` (and the given hot-memory payload) for the declared room. With no engine (a client that reached no
 * brain that marks), `unavailable` says why and every item is unknown; no audit row is written. Never throws and never changes what the
 * result holds apart from adding room_access to its items: on any failure the items are marked unknown and a
 * room_hints_unavailable notice says why. Writes one count-only audit row.
 */
export async function assessRoom(engine: BrainEngine | null, input: RoomInput): Promise<RoomOutcome & { hotMemory?: unknown; retrieval?: unknown }> {
  try {
    return await assessRoomUnguarded(engine, input);
  } catch {
    // Marking itself failed (a value it could not copy, a shape it could not walk): the answer goes out unmarked, flagged.
    const d = input.declaration;
    const notice: Notice = { code: 'room_hints_unavailable', kind: 'degraded', why: `${UNAVAILABLE_WHY.mark_failed}. The answer is complete; treat all of it as above this room's level: use it for the work, keep it out of the reply unless the ask needs it, and offer it in a private chat. [reason: mark_failed]` };
    return { result: input.result, meta: { ...emptyMeta(d), complete: false, unavailable: 'mark_failed' }, notices: [notice], stamped: [notice],
      ...(input.hotMemory !== undefined ? { hotMemory: input.hotMemory } : {}), ...(input.retrieval !== undefined ? { retrieval: input.retrieval } : {}) };
  }
}

async function assessRoomUnguarded(engine: BrainEngine | null, input: RoomInput): Promise<RoomOutcome & { hotMemory?: unknown; retrieval?: unknown }> {
  const { op, declaration: d, caller } = input;
  const meta = emptyMeta(d);
  const extractor = EXTRACTORS[op];
  const result = structuredClone(input.result);
  const hot = input.hotMemory === undefined ? undefined : structuredClone(input.hotMemory);
  const slots: Slot[] = extractor ? extractor(result, input.sourceId, input.result).filter((s): s is Slot => !!s) : [];
  if (isObj(hot) && isObj(hot.brain_hot_memory)) for (const f of arr(hot.brain_hot_memory.facts)) { const s = factSlot(f); if (s) slots.push(s); }
  // search and query: the saved facts that ride _meta.retrieval (and the model-visible saved-facts block) are items too.
  const retrieval = isObj(input.retrieval) && Array.isArray(input.retrieval.saved_facts) ? structuredClone(input.retrieval) as Record<string, unknown> : undefined;
  if (retrieval) for (const f of arr(retrieval.saved_facts)) { const s = factSlot(f); if (s) slots.push(s); }
  let unavailable: RoomUnavailable | null = !extractor ? new RoomUnavailable('op_not_covered')
    : d.invalid ? new RoomUnavailable('invalid', d.invalid)
    : input.unavailable ? new RoomUnavailable(input.unavailable.reason, input.unavailable.detail)
    : !engine ? new RoomUnavailable('not_supported') : null;
  let decisions = new Map<string, RoomAccess>();
  const refs = new Map<string, Ref>();
  for (const s of slots) for (const r of s.ref ? [s.ref, ...(s.also ?? [])] : []) if (refs.size < ROOM_MAX_REFS) refs.set(refKey(r), r);
  if (!unavailable && slots.length) {
    try {
      let late = false;
      decisions = await withDeadline((async () => {
        await deadlineForTests?.delay();
        const access = late ? null : await roomAccessFor(engine!, caller, d.principals);
        return access && !late ? decide(engine!, access, d.principals, [...refs.values()]) : new Map<string, RoomAccess>();
      })(), deadlineForTests?.ms ?? input.deadlineMs ?? ROOM_DEADLINE_MS, () => { late = true; });
    } catch (e) {
      unavailable = e instanceof RoomUnavailable ? e : new RoomUnavailable('mark_failed');
    }
  }
  const listed = new Set<string>();
  for (const s of slots) {
    const judge = (r: Ref): RoomAccess => !refs.has(refKey(r)) ? { readable: 'unknown', reason: 'over_limit' }
      : decisions.get(refKey(r)) ?? { readable: 'unknown', reason: 'not_found' };
    // An item is readable only when every page that gates it is; the first page that is not gives the reason.
    const gates = s.ref ? [s.ref, ...(s.also ?? [])].map(judge) : [];
    const access: RoomAccess = unavailable ? { readable: 'unknown', reason: unavailable.reason }
      : !s.ref ? { readable: 'unknown', reason: 'not_identified' }
      : gates.find(a => a.readable === false) ?? (s.unknown ? { readable: 'unknown', reason: s.unknown } : undefined) ?? gates.find(a => a.readable === 'unknown') ?? { readable: true };
    s.holder[ROOM_ACCESS_KEY] = access;
    meta.counts.items++;
    if (access.readable === true) { meta.counts.readable++; continue; }
    if (access.readable === false) { meta.counts.above++; meta.by_reason[access.reason] = (meta.by_reason[access.reason] ?? 0) + 1; }
    else meta.counts.unknown++;
    if (s.ref && !listed.has(refKey(s.ref))) {
      listed.add(refKey(s.ref));
      meta.above.push({ ...refOut(s.ref), ...(access.readable === 'unknown' ? { unknown: access.reason } : { reason: access.reason }) });
    }
  }
  if (unavailable) { meta.unavailable = unavailable.reason; meta.complete = false; }
  if (meta.counts.unknown > 0) meta.complete = false;
  const notices: Notice[] = [];
  if (d.conflict) notices.push({ code: 'room_conflict', kind: 'safety',
    why: `The room named in the tool arguments differs from the room the harness declared, so the answer was marked for everyone either names (${d.principals.join(', ')}). The arguments can add people to the harness's room, never remove them.` });
  if (unavailable) notices.push({ code: 'room_hints_unavailable', kind: 'degraded',
    why: `${UNAVAILABLE_WHY[unavailable.reason]}${unavailable.detail ? ` (${unavailable.detail})` : ''}. The answer is complete; every item is marked unknown, so treat all of it as above this room's level: use it for the work, keep it out of the reply unless the ask needs it, and offer it in a private chat. [reason: ${unavailable.reason}]`,
    ...(unavailable.fix ? { fix: unavailable.fix } : {}) });
  if (!unavailable && meta.counts.above + meta.counts.unknown > 0) {
    const reasons = Object.entries(meta.by_reason).map(([k, n]) => `${n} ${k}`).join(', ');
    notices.push({ code: 'room_above_level', kind: 'safety',
      why: `This answer goes into a room (${d.principals.join(', ')}). ${meta.counts.above} of ${meta.counts.items} items are above the room's level${reasons ? ` (${reasons})` : ''}${meta.counts.unknown ? ` and ${meta.counts.unknown} could not be judged` : ''}; their room_access says so. Use them to do the work. Keep them out of the reply unless the ask needs them, and offer the rest in a private chat. Never refuse the work because of them.` });
  }
  if (engine) logAudienceAssertion({ outcome: 'room_marked', op, audience: [...d.principals], transport: caller.transport ?? 'unknown',
    principal: caller.auth?.principal ? `${caller.auth.principal.kind}:${caller.auth.principal.id}` : caller.transport === 'stdio' ? 'local_stdio' : 'unknown',
    room: { readable: meta.counts.readable, above: meta.counts.above, unknown: meta.counts.unknown, by_reason: { ...meta.by_reason }, declared_by: d.declared_by,
      ...(meta.unavailable ? { unavailable: meta.unavailable } : {}) } });
  const stamped = meta.unavailable === 'op_not_covered' || ROOM_WRITE_OPS.has(op) ? notices.filter(n => n.code !== 'room_hints_unavailable') : notices;
  return { result, meta, notices, stamped, ...(hot !== undefined ? { hotMemory: hot } : {}), ...(retrieval ? { retrieval } : {}) };
}
