/**
 * Shared seeding and views for the served-remote-*-reads parity files (lane L3 S4): one brain with an entity, an open page
 * and facts about it, plus a page the owner keeps private and a page only a named member may read, each carrying its own
 * marker, so a case can prove a remote answer never carries text the caller may not read.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { chunk } from './chunk-fixtures.ts';

/** The owner's stdio pipe as a remote caller: world facts only, the default source. */
export const STDIO = { remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default' } as const;

export const OPEN_MARK = 'novamarkopenpage3a91';
export const PRIVATE_MARK = 'novamarkprivatepage6c42';
export const READERS_MARK = 'novamarkreaderspage8e17';
export const PRIVATE_FACT_MARK = 'novamarkprivatefact5b03';
/** What no remote answer may carry. */
export const HIDDEN_MARKS = [PRIVATE_MARK, READERS_MARK, PRIVATE_FACT_MARK] as const;

const SRC = 'default';

/**
 * The entity `people/nova-example` ("Nova Example"), an open note and a private note and a readers-only note that each
 * link to it and name it, and three facts about it (two world, one private). Every page has one sealed chunk, so search
 * finds it.
 */
export async function seedNova(engine: BrainEngine): Promise<void> {
  const put = async (slug: string, type: string, title: string, body: string, day: number, frontmatter: Record<string, unknown> = {}) => {
    await engine.putPage(slug, { type: type as never, title, compiled_truth: body, timeline: '', frontmatter,
      effective_date: new Date(Date.UTC(2026, 2, day)), effective_date_source: 'date' });
    await engine.sealChunks(slug, [chunk(0, body)]);
  };
  await put('people/nova-example', 'person', 'Nova Example', `Nova Example builds widgets. ${OPEN_MARK}`, 1, { date: '2026-02-13' });
  await put('notes/nova-open', 'note', 'Nova open note', `Met Nova Example in Lisbon about widgets. ${OPEN_MARK}`, 2, { date: '2026-02-14' });
  await put('notes/nova-private', 'note', 'Nova private note', `Nova Example private widgets. ${PRIVATE_MARK}`, 3, { visibility: 'private' });
  await put('notes/nova-readers', 'note', 'Nova readers note', `Nova Example readers widgets. ${READERS_MARK}`, 4, { readable_by: ['alice-example'] });
  for (const from of ['notes/nova-open', 'notes/nova-private', 'notes/nova-readers']) await engine.addLink(from, 'people/nova-example', '', 'works_with', 'manual');
  const fact = (text: string, day: number, visibility: 'world' | 'private') => ({ fact: text, kind: 'fact' as const, visibility, source: 'fence',
    entity_slug: 'people/nova-example', valid_from: new Date(Date.UTC(2026, 5, day)) });
  await engine.insertFacts([
    fact(`Nova leads the widgets team ${OPEN_MARK}`, 1, 'world'),
    fact('Nova moved to Lisbon', 2, 'world'),
    fact(`Nova private fact ${PRIVATE_FACT_MARK}`, 3, 'private'),
  ] as never, { source_id: SRC });
}

type Reply = Awaited<ReturnType<typeof dispatchToolCall>>;

/** One remote op through the MCP stdio dispatch: the parsed answer, whether it was an error, and the text itself. */
export async function remoteCall(engine: BrainEngine, op: string, params: Record<string, unknown>, ctx: Record<string, unknown> = STDIO): Promise<{ error: boolean; body: Record<string, any>; text: string; rows: Array<Record<string, any>> }> {
  const out: Reply = await dispatchToolCall(engine, op, params, ctx as never);
  const text = out.content.map(c => c.text ?? '').join('\n');
  let body: Record<string, any> = {};
  try { body = JSON.parse(out.content[0]?.text ?? '') as Record<string, any>; } catch { /* an error text */ }
  // A search answers rows as one JSON line, then notices as text: the rows are that first line.
  let rows: Array<Record<string, any>> = [];
  try { const first = JSON.parse(text.split('\n')[0] ?? ''); if (Array.isArray(first)) rows = first; } catch { /* not a row list */ }
  return { error: out.isError === true, body, text, rows };
}

/** The hidden markers a text carries. */
export const leaked = (text: string): string[] => HIDDEN_MARKS.filter(mark => text.includes(mark));
