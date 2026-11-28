/**
 * BrainEngine parity: the two probes a remote search or query makes before it ranks, over the served wire: the page-type
 * probe of a `types` filter (probePageTypes) and the explain_target probe (probeTargetRows).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded or served) a remote search (MCP stdio,
 *    dispatchToolCall with remote: true) answers the same, and carries no marker of a page the caller may not read: an
 *    owner-private page and a page only a named member may read, each with its own marker, page type and slug.
 *    - A `types` filter naming a type whose only pages are hidden drops the filter with a notice that lists the page types
 *      the caller can see (probePageTypes under the caller's scope): the notice names neither hidden type.
 *    - `explain_target` naming a slug whose only copy is hidden answers like a missing page (probeTargetRows under the
 *      caller's policy), and one naming an open page is found, with no diagnosis.
 *  - Regression: on the served arm both probes were refused for a remote caller (not on OWNER_IPC_REMOTE_TYPED_READS), so a
 *    remote search with a type filter or explain_target failed with a typed engine_capability_missing refusal.
 *  - Why existing coverage misses it: hidden-refusals-2.test.ts and list-reads.test.ts call the members with a hand-built
 *    scope on the arm's own engine; no parity file ran the remote search that sends them over the served wire.
 *  - Seam: none. Pages are seeded with putPage and sealChunks; each case runs the real operation.
 */
import { expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { chunk } from './chunk-fixtures.ts';
import { NoticeLedger } from '../../src/core/notice-ledger.ts';

const { parityTest } = parityArms(testBackends());

/** A fresh notice ledger per call: the process ledger shows a notice once, so a second arm would not see it. */
const stdio = () => ({ remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default', noticeLedger: new NoticeLedger() }) as never;
const OPEN = 'probemarkopenpage3b7e';
const PRIVATE = 'probemarkprivatepage8c14';
const READERS = 'probemarkreaderspage5d92';
const HIDDEN = [PRIVATE, READERS];

async function seed(engine: BrainEngine): Promise<void> {
  const pages: Array<[slug: string, type: string, body: string, frontmatter: Record<string, unknown>]> = [
    [`notes/${OPEN}`, 'note', `${OPEN} is an open note.`, {}],
    [`secrets/${PRIVATE}`, 'vault', `${PRIVATE} ${OPEN} private body.`, { visibility: 'private' }],
    [`shared/${READERS}`, 'ledger', `${READERS} ${OPEN} readers body.`, { readable_by: ['alice-example'] }],
  ];
  for (const [slug, type, body, frontmatter] of pages) {
    await engine.putPage(slug, { type: type as never, title: slug.split('/')[1]!, compiled_truth: body, timeline: '', frontmatter });
    await engine.sealChunks(slug, [chunk(0, body)]);
  }
}

/** The remote answer as text, whether it errored, and every hidden marker it carries. */
async function ask(engine: BrainEngine, op: string, params: Record<string, unknown>) {
  const out = await dispatchToolCall(engine, op, params, stdio());
  const text = out.content.map(c => c.text ?? '').join('\n');
  return { error: out.isError === true ? text.slice(0, 300) : false, text, leaked: [...HIDDEN, 'ledger'].filter(m => text.includes(m)) };
}

parityTest('a remote search with a type filter naming only hidden pages drops the filter and lists no hidden page type', { methods: ['putPage', 'sealChunks', 'probePageTypes'], timeout: 240_000 }, async (engine: BrainEngine) => {
  await seed(engine);
  const out = await ask(engine, 'search', { query: OPEN, types: ['vault'] });
  expect({ error: out.error, leaked: out.leaked }).toEqual({ error: false, leaked: [] });
  // The notice echoes the type the caller asked for; the list of types in the brain holds the open page's type only.
  expect(out.text).toContain('Page types in this brain: note');
  return { error: out.error, leaked: out.leaked, notice: /No pages have type[^"]*/.exec(out.text)?.[0] ?? null };
});

parityTest('a remote search with explain_target answers like a missing page for a hidden target and finds an open one', { methods: ['putPage', 'sealChunks', 'probeTargetRows'], timeout: 240_000 }, async (engine: BrainEngine) => {
  await seed(engine);
  const hidden = await ask(engine, 'search', { query: OPEN, explain_target: `secrets/${PRIVATE}` });
  const open = await ask(engine, 'search', { query: OPEN, explain_target: `notes/${OPEN}` });
  expect({ error: hidden.error, leaked: hidden.leaked }).toEqual({ error: false, leaked: [] });
  expect({ error: open.error, leaked: open.leaked }).toEqual({ error: false, leaked: [] });
  const diagnosis = (text: string) => /gbrain notice (target_[a-z_]+)/.exec(text)?.[1] ?? null;
  expect(diagnosis(hidden.text)).toBe('target_not_found_or_not_visible');
  expect(diagnosis(open.text)).toBeNull();
  return { hidden: diagnosis(hidden.text), open: diagnosis(open.text), openRetrieved: open.text.includes(`notes/${OPEN}`) };
});
