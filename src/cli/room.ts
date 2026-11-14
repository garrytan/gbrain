/**
 * GBRA-498: `--room` on the CLI. A command that names a room prints exactly what it reads; its result is marked for
 * the room (`room_access` on every item) by the same assessment MCP dispatch runs (core/access/room.ts). The direct
 * path marks here, a live PGLite owner marks on its side, and a thin client asks its host through `_meta.room`; a
 * brain that cannot mark leaves every item unknown, never unmarked. `--json` carries the diagnostics in
 * `_meta.room` (an array result becomes `{ results, _meta }`); human output keeps its form and stderr names what the
 * room cannot read. Nothing here fails the command.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { Notice } from '../core/agent-output.ts';
import { assessRoom, readRoomDeclaration, type RoomMeta, type RoomUnknownReason } from '../core/access/room.ts';
import { currentCallerAccess } from '../core/search/private-visibility.ts';
import { applyCliOpNotices, captureOpNotice, withRoutedDegradedStamp } from './op-notices.ts';
import { PERSISTENCE_ROOM_MAX_CHARS } from '../core/persistence/ipc.ts';

export interface CliRoomMarked { result: unknown; meta: RoomMeta }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Marks a result for the room `--room` named. `engine` null (a brain that could not mark) marks every item unknown
 * for `unavailable`. The notices the degraded stamp reads are captured for applyCliOpNotices.
 */
export async function markCliResult(engine: BrainEngine | null, op: string, result: unknown, room: string,
  opts: { sourceId: string; run?: <T>(fn: () => Promise<T>) => Promise<T>; unavailable?: { reason: RoomUnknownReason; detail?: string } }): Promise<CliRoomMarked> {
  const access = opts.run ? await opts.run(async () => currentCallerAccess()) : currentCallerAccess();
  const marked = await assessRoom(engine, { op, result, sourceId: opts.sourceId, declaration: readRoomDeclaration({ requestMeta: { room } }, undefined).declaration!,
    caller: { access, transport: 'cli', local: true }, ...(opts.unavailable ? { unavailable: opts.unavailable } : {}) });
  for (const n of marked.stamped) captureOpNotice(n);
  return { result: marked.result, meta: marked.meta };
}

/** A live owner's marks, or (an owner that predates room marks) every item unknown. */
export async function delegatedRoom(op: string, delegated: { result: unknown; room?: { meta: unknown; notices: unknown[] } }, room: string): Promise<CliRoomMarked> {
  if (delegated.room && isObj(delegated.room.meta)) {
    for (const n of delegated.room.notices) if (isObj(n) && typeof n.code === 'string') captureOpNotice(n as unknown as Notice);
    return { result: delegated.result, meta: delegated.room.meta as unknown as RoomMeta };
  }
  return markCliResult(null, op, delegated.result, room, { sourceId: 'default', unavailable: { reason: 'not_supported', detail: room.length > PERSISTENCE_ROOM_MAX_CHARS
    ? 'the room is too long to pass to the running brain owner' : 'the running brain owner predates room marks; restart it on this release' } });
}

/** The host's marks (`_meta.room`), or every item unknown: for a host that predates room marks, or one whose marks did not fit. */
export async function routedRoom(op: string, result: unknown, hostRoom: unknown, room: string): Promise<{ marked: CliRoomMarked; local: boolean }> {
  if (isObj(hostRoom) && Array.isArray(hostRoom.principals)) return { marked: { result, meta: hostRoom as unknown as RoomMeta }, local: false };
  const reason: RoomUnknownReason = isObj(hostRoom) && hostRoom.unavailable === 'response_cap' ? 'response_cap' : 'not_supported';
  return { marked: await markCliResult(null, op, result, room, { sourceId: 'default',
    unavailable: { reason, ...(reason === 'not_supported' ? { detail: 'the brain host predates room marks' } : {}) } }), local: true };
}

/** The document `--json` prints: the marked result with the room's diagnostics in `_meta.room`. */
export function cliRoomResult(marked: CliRoomMarked, json: boolean): unknown {
  if (!json) return marked.result;
  if (Array.isArray(marked.result)) return { results: marked.result, _meta: { room: marked.meta } };
  if (isObj(marked.result)) return { ...marked.result, _meta: { ...(isObj(marked.result._meta) ? marked.result._meta : {}), room: marked.meta } };
  return { result: marked.result, _meta: { room: marked.meta } };
}

/** search and query render their own rows: the rows inside a `--json` room document, and that document's `_meta` put back on what they render. */
export function splitRoomDocument(result: unknown): { rows: unknown; wrap: (doc: unknown) => unknown } {
  if (!isObj(result) || !Array.isArray(result.results) || !isObj(result._meta) || !('room' in result._meta)) return { rows: result, wrap: doc => doc };
  const meta = result._meta;
  return { rows: result.results, wrap: doc => Array.isArray(doc) ? { results: doc, _meta: meta } : isObj(doc) ? { ...doc, _meta: { ...(isObj(doc._meta) ? doc._meta : {}), ...meta } } : doc };
}

const SHOWN = 20;
/** Human mode's stderr summary: the counts, then each item the room cannot read or that is unknown. */
export function roomSummaryLine(meta: RoomMeta): string {
  const who = meta.principals.length ? meta.principals.join(', ') : 'no one readable';
  const c = meta.counts;
  const lines = [`[gbrain room: ${who}] ${meta.unavailable
    ? `no item could be judged (${meta.unavailable}); treat all ${c.items} as above the room's level`
    : `${c.readable} of ${c.items} items readable by the room, ${c.above} above its level, ${c.unknown} unknown`}`];
  for (const a of meta.above.slice(0, SHOWN)) {
    const ref = typeof a.slug === 'string' ? `${a.source_id}:${a.slug}` : a.page_id !== undefined ? `page ${a.page_id}` : `fact ${a.fact_id}`;
    lines.push(`  ${ref} (${a.reason ?? `unknown: ${a.unknown}`})`);
  }
  if (meta.above.length > SHOWN) lines.push(`  and ${meta.above.length - SHOWN} more (--json lists every one in _meta.room.above)`);
  return lines.join('\n') + '\n';
}

/** The direct path: marks the result, then the notices and stamp as applyCliOpNotices renders them, then the summary. */
export async function directWithRoom(engine: BrainEngine, op: string, result: unknown, room: string, json: boolean,
  opts: { sourceId: string; run: <T>(fn: () => Promise<T>) => Promise<T>; retrieval: Record<string, unknown> | null; enforced?: boolean }): Promise<{ result: unknown; stderr?: string }> {
  // An enforced member (GBRAIN_ENFORCED_MEMBER) is not the trusted owner: it may not ask what another room reads here.
  const marked = await markCliResult(engine, op, result, room, { sourceId: opts.sourceId, run: opts.run,
    ...(opts.enforced ? { unavailable: { reason: 'not_permitted' as const, detail: 'a CLI under GBRAIN_ENFORCED_MEMBER marks no room; ask through the connection bound to that member' } } : {}) });
  const out = applyCliOpNotices(cliRoomResult(marked, json), json, { op, retrieval: opts.retrieval });
  return { result: out.result, stderr: (out.stderr ?? '') + (json ? '' : roomSummaryLine(marked.meta)) };
}

/** The thin-client path: the host's marks (or every item unknown), its stamp, the CLI's own notices when it marked, then the summary. */
export async function routedWithRoom(op: string, result: unknown, envelopeMeta: Record<string, unknown> | undefined, json: boolean, room: string): Promise<{ result: unknown; stderr?: string }> {
  const { marked, local } = await routedRoom(op, result, envelopeMeta?.room, room);
  const routed = withRoutedDegradedStamp(op, cliRoomResult(marked, json), envelopeMeta, json);
  const own = local ? applyCliOpNotices(routed.result, json, { op, retrieval: null }) : { result: routed.result };
  return { result: own.result, stderr: (routed.stderr ?? '') + (own.stderr ?? '') + (json ? '' : roomSummaryLine(marked.meta)) };
}

/** A command outside the operations cannot mark what it prints; it runs unchanged and says so. */
export function roomNotMarkedLine(command: string): string {
  return `[gbrain room] gbrain ${command} does not mark its results for a room: treat all of its output as above the room's level.\n`;
}
