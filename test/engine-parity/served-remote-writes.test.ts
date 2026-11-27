/**
 * BrainEngine parity: the remote whole operations of the served wire (rust-engine/served/remote-whole-ops.ts
 * REMOTE_WHOLE_OPERATIONS) that no other parity file calls as a remote caller: add_tag, remove_tag, add_link, remove_link,
 * remember, forget, restore_page and edit_page, each called over MCP stdio (dispatchToolCall with remote: true).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded or served) each operation answers
 *    the same and leaves the same state, read back through typed reads.
 *  - Regression: on the served arm (GBRAIN_TEST_RUST_SERVED=1, multi-user), a remote caller's write was refused before it
 *    was sent; it now crosses as one whole operation the brain server runs as in process. A server that ran it under
 *    another context, or a client that sent its members one by one, answers differently or writes differently.
 *  - Why existing coverage misses it: these operations had no remote parity case (test/rust-served-remote-whole-ops.test.ts
 *    requires one per listed operation).
 *  - Seam: none. Pages are seeded with putPage; each tool runs through dispatchToolCall; ids and revisions are compared by
 *    shape, never by value.
 */
import { expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

const { parityTest } = parityArms(testBackends());

const STDIO = { remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default' } as const;
const NOTE = (title: string, body: string) => ({ type: 'note' as never, title, compiled_truth: body, timeline: '', frontmatter: {} });

/** One MCP call over the stdio options: whether it erred, and its code when it did. */
async function tool(engine: BrainEngine, name: string, params: Record<string, unknown>): Promise<{ ok: boolean; code?: string; body: Record<string, unknown> }> {
  const out = await dispatchToolCall(engine, name, params, STDIO as never);
  // The answer is the first content block (memory verbs add a summary block after it).
  const text = out.content[0]?.text ?? '';
  let body: Record<string, unknown>;
  try { body = JSON.parse(text); } catch { body = { text }; }
  return out.isError ? { ok: false, code: String(body.code ?? body.error), body } : { ok: true, body };
}

parityTest('remote add_tag and remove_tag change the page\'s tags', { methods: ['putPage', 'getTags'] }, async (engine) => {
  await engine.putPage('notes/tagged', NOTE('Tagged', 'A tagged note.'));
  const add = await tool(engine, 'add_tag', { slug: 'notes/tagged', tag: 'alpha' });
  const afterAdd = await engine.getTags('notes/tagged');
  const remove = await tool(engine, 'remove_tag', { slug: 'notes/tagged', tag: 'alpha' });
  const afterRemove = await engine.getTags('notes/tagged');
  const out = { add: add.ok, afterAdd, remove: remove.ok, afterRemove };
  expect(out).toEqual({ add: true, afterAdd: ['alpha'], remove: true, afterRemove: [] });
  return out;
});

parityTest('remote add_link and remove_link change the links between two pages', { methods: ['putPage', 'getLinks'] }, async (engine) => {
  await engine.putPage('notes/from', NOTE('From', 'The source page.'));
  await engine.putPage('notes/to', NOTE('To', 'The target page.'));
  const targets = async () => (await engine.getLinks('notes/from')).map(l => l.to_slug).sort();
  const add = await tool(engine, 'add_link', { from: 'notes/from', to: 'notes/to' });
  const afterAdd = await targets();
  const remove = await tool(engine, 'remove_link', { from: 'notes/from', to: 'notes/to' });
  const afterRemove = await targets();
  const out = { add: add.ok, afterAdd, remove: remove.ok, afterRemove };
  expect(out).toEqual({ add: true, afterAdd: ['notes/to'], remove: true, afterRemove: [] });
  return out;
});

parityTest('remote remember stores a fact and forget withdraws it', { methods: ['putPage'] }, async (engine) => {
  await engine.putPage('people/alice-example', { ...NOTE('Alice Example', 'A person.'), type: 'person' as never });
  const remembered = await tool(engine, 'remember', { fact: 'Alice Example likes tea.', entity: 'people/alice-example', content_origin: 'user_said', provenance: 'parity case' });
  const factId = typeof remembered.body.id === 'string' ? remembered.body.id : undefined;
  const forgot = factId ? await tool(engine, 'forget', { id: factId, reason: 'parity case' }) : { ok: false, code: 'no_fact_id' };
  const again = factId ? await tool(engine, 'forget', { id: factId, reason: 'parity case' }) : { ok: false, code: 'no_fact_id' };
  const out = { remembered: remembered.ok, status: remembered.body.status, hasId: typeof factId === 'string', forgot: forgot.ok, again: again.ok ? 'ok' : again.code };
  expect({ remembered: out.remembered, status: out.status, hasId: out.hasId, forgot: out.forgot }).toEqual({ remembered: true, status: 'inserted', hasId: true, forgot: true });
  return out;
});

parityTest('remote restore_page brings back a soft-deleted page at its revision', { methods: ['putPage', 'softDeletePage', 'getPage'] }, async (engine) => {
  // delete_page is not on the remote list yet: a remote delete reaches a raw-SQL guest check on Rust (guests/admission.ts).
  await engine.putPage('notes/gone', NOTE('Gone', 'Soon deleted.'));
  await engine.softDeletePage('notes/gone');
  const unread = await tool(engine, 'restore_page', { slug: 'notes/gone' });
  const deletedRevision = (await engine.getPage('notes/gone', { includeDeleted: true } as never))?.knowledge_revision;
  const restored = await tool(engine, 'restore_page', { slug: 'notes/gone', expected_revision: deletedRevision });
  const back = await engine.getPage('notes/gone');
  const out = { unread: unread.ok ? 'ok' : unread.code, restored: restored.ok ? 'ok' : restored.code, body: back?.compiled_truth ?? null };
  expect(out).toEqual({ unread: 'revision_required', restored: 'ok', body: 'Soon deleted.' });
  return out;
});

parityTest('remote edit_page replaces text at the revision it read', { methods: ['putPage', 'getPage'] }, async (engine) => {
  await engine.putPage('notes/edited', NOTE('Edited', 'The old words stay here.'));
  const revision = (await engine.getPage('notes/edited'))?.knowledge_revision;
  const edited = await tool(engine, 'edit_page', { slug: 'notes/edited', expected_revision: revision, edits: [{ old_text: 'old words', new_text: 'new words' }] });
  const stale = await tool(engine, 'edit_page', { slug: 'notes/edited', expected_revision: revision, edits: [{ old_text: 'new words', new_text: 'other words' }] });
  const body = (await engine.getPage('notes/edited'))?.compiled_truth ?? null;
  const out = { edited: edited.ok ? 'ok' : edited.code, stale: stale.ok ? 'ok' : stale.code, body };
  expect(out.edited).toBe('ok');
  expect(out.body).toContain('new words');
  return out;
});
