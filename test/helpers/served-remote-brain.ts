/**
 * The brain the served-remote parity files (test/engine-parity/served-remote-*.test.ts) read through the real remote
 * operations: one open set of pages and, for each hiding rule, a page the remote caller may not read, each with its own
 * marker. A marker never appears in an answer to a remote caller, on any arm.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { chunk } from '../engine-parity/chunk-fixtures.ts';

/** The owner's stdio pipe as a remote caller. */
export const STDIO = { remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default' } as const;
/** A non-owner member's read-only grant that names no source list, so its read set is the floor (memberFloorScope). */
export const MEMBER_AUTH = {
  token: 'served-remote-member-token', clientId: 'served-remote-member-client', principal: { kind: 'oauth_client', id: 'served-remote-member-client' },
  member: { id: 'bob-example', groups: [] }, scopes: ['read'], sourceId: 'default', hasSourceGrant: false,
};
/** Markers carried only by pages a remote caller may not read: an owner-private page and a page only alice-example may read. */
export const HIDDEN = ['zqprivmark', 'zqreadersmark'] as const;

type Frontmatter = Record<string, unknown>;
const PRIVATE: Frontmatter = { visibility: 'private' };
const READERS: Frontmatter = { readable_by: ['alice-example'] };

async function put(engine: BrainEngine, slug: string, type: string, title: string, body: string, frontmatter: Frontmatter = {}): Promise<void> {
  await engine.putPage(slug, { type: type as never, title, compiled_truth: body, timeline: '', frontmatter });
  await engine.sealChunks(slug, [chunk(0, body)]);
}

/** The pages the resolver, relational and entity-card reads work over: an entity with an alias, people, meetings, a prefix family and hidden pages of each kind. */
export async function seedEntityBrain(engine: BrainEngine): Promise<void> {
  await put(engine, 'companies/acme', 'company', 'Acme', 'Acme is a company. Current status of Acme: growing. Contact [Jane Doe](people/jane-doe).');
  await put(engine, 'people/jane-doe', 'person', 'Jane Doe', 'Jane Doe works at [Acme](companies/acme). She promised a deck.');
  await put(engine, 'people/jane-zqprivmark', 'person', 'Jane Zqprivmark', 'Jane Zqprivmark works at Acme. zqprivmark private note.', PRIVATE);
  await put(engine, 'people/jane-zqreadersmark', 'person', 'Jane Zqreadersmark', 'Jane Zqreadersmark works at Acme. zqreadersmark readers note.', READERS);
  await put(engine, 'meetings/2026-01-01-acme', 'meeting', 'Acme sync', 'Met with [Acme](companies/acme) and [Jane Doe](people/jane-doe).');
  await put(engine, 'meetings/2026-01-02-zqprivmark', 'meeting', 'Acme sync zqprivmark', 'Private meeting with [Acme](companies/acme) and [Jane Doe](people/jane-doe). zqprivmark.', PRIVATE);
  await put(engine, 'companies/globex-labs-1', 'company', 'Globex Labs', 'Globex Labs is a lab.');
  await put(engine, 'companies/globex-inc-2', 'company', 'Globex', 'Globex is a company.');
  await put(engine, 'companies/globex-zqprivmark-3', 'company', 'Globex Zqprivmark', 'Globex Zqprivmark private company. zqprivmark.', PRIVATE);
  await put(engine, 'companies/globex-zqreadersmark-4', 'company', 'Globex Zqreadersmark', 'Globex Zqreadersmark readers company. zqreadersmark.', READERS);
  await put(engine, 'people/zed-x', 'person', 'Zed X', 'Zed X is a person.');
  await put(engine, 'companies/zed-x', 'company', 'Zed X', 'Zed X is a company.');
  await put(engine, 'notes/zed-zqprivmark-note', 'note', 'Zed X private note', 'Notes on Zed X and Jane Doe. zqprivmark.', PRIVATE);
  await put(engine, 'notes/zed-zqreadersmark-note', 'note', 'Zed X readers note', 'Notes on Zed X and Jane Doe. zqreadersmark.', READERS);
  await put(engine, 'notes/zed-open-note', 'note', 'Zed X open note', 'Notes on Zed X and Jane Doe, open to all.');
  await engine.setPageAliases('companies/acme', 'default', ['acme corp']);
  const links: Array<[string, string, string]> = [
    ['people/jane-doe', 'companies/acme', 'works_at'], ['people/jane-zqprivmark', 'companies/acme', 'works_at'],
    ['people/jane-zqreadersmark', 'companies/acme', 'works_at'], ['people/jane-doe', 'meetings/2026-01-01-acme', 'attended'],
    ['people/jane-doe', 'companies/globex-inc-2', 'works_at'],
    ['meetings/2026-01-01-acme', 'people/jane-doe', 'attended'], ['meetings/2026-01-01-acme', 'companies/acme', 'mentions'],
    ['meetings/2026-01-02-zqprivmark', 'people/jane-doe', 'attended'], ['meetings/2026-01-02-zqprivmark', 'companies/acme', 'mentions'],
  ];
  for (const [from, to, type] of links) await engine.addLink(from, to, 'context', type);
  await engine.setConfig('search.entity_anchoring', 'true');
  await engine.setConfig('entity.record_types', 'meeting');
}

export type Reply = Awaited<ReturnType<typeof dispatchToolCall>>;

/** One remote call as the caller sees it: the text and, when it parses, the body. */
export async function remote(engine: BrainEngine, op: string, params: Record<string, unknown>, auth?: typeof MEMBER_AUTH): Promise<{ text: string; body: unknown; isError: boolean }> {
  const reply = await dispatchToolCall(engine, op, params, (auth ? { ...STDIO, auth } : STDIO) as never);
  const text = reply.content.map(c => c.text ?? '').join('\n');
  let body: unknown = null;
  // A compact JSON answer is its first line; a notice (the one-time trust notice) may follow it. An error message is not JSON.
  try { body = JSON.parse(text.split('\n')[0]!); } catch { /* not JSON */ }
  return { text, body, isError: reply.isError === true };
}

/** Every `slug` string in `value`, sorted and unique: which pages an answer names, without ids, times or scores. */
export function slugsIn(value: unknown, found = new Set<string>()): string[] {
  if (Array.isArray(value)) for (const v of value) slugsIn(v, found);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'slug' && typeof v === 'string') found.add(v);
      else slugsIn(v, found);
    }
  }
  return [...found].sort();
}

/** What an answer shows the remote caller: whether it failed, the pages it names, and every hidden marker it carries. */
export async function remoteView(engine: BrainEngine, op: string, params: Record<string, unknown>, auth?: typeof MEMBER_AUTH) {
  const out = await remote(engine, op, params, auth);
  return { isError: out.isError, slugs: slugsIn(out.body), leaked: HIDDEN.filter(marker => out.text.includes(marker)) };
}

/** `engine` behind a proxy that records each member that refused with the typed capability refusal (`engine_capability_missing`), by name. */
export function watchRefusals(engine: BrainEngine): { engine: BrainEngine; refused: Set<string> } {
  const refused = new Set<string>();
  const note = (name: string, e: unknown) => { if ((e as { code?: unknown } | null)?.code === 'engine_capability_missing') refused.add(name); };
  const wrapped = new Proxy(engine, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof name !== 'string' || typeof value !== 'function' || name === 'constructor') return value;
      return (...args: unknown[]) => {
        let ran: unknown;
        try { ran = (value as (...a: unknown[]) => unknown).apply(target, args); } catch (e) { note(name, e); throw e; }
        return ran instanceof Promise ? ran.catch((e: unknown) => { note(name, e); throw e; }) : ran;
      };
    },
  });
  return { engine: wrapped, refused };
}
