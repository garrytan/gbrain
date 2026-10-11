/**
 * A conflicted coordinated write keeps PageRevisionConflictError's own
 * message, so a caller that never supplied expected_revision is not told its
 * revision went stale (#5659), and since #5385 it also gets its own code
 * (`revision_required`) while a stale revision stays `revision_conflict`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;
const ctx = { remote: true, transport: 'stdio' as const, sourceId: 'default' };
const page = (body: string) => `---\ntitle: Revision example\ntype: note\n---\n${body}`;
const body = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('schema_pack', 'gbrain-base');
});
afterAll(async () => { await engine.disconnect(); });

test('a missing expected_revision and a stale one report different conflicts', async () => {
  const slug = 'notes/revision-message-example';
  const created = await dispatchToolCall(engine, 'put_page', { slug, content: page('first body') }, ctx);
  expect(created.isError ?? false).toBe(false);
  const before = await engine.readPageSnapshot(slug, { sourceId: 'default' });

  const missing = await dispatchToolCall(engine, 'put_page', { slug, content: page('second body') }, ctx);
  expect(missing.isError).toBe(true);
  // #5385: the missing precondition is the caller's omission, not a race, so it carries its own code.
  expect(body(missing)).toMatchObject({ write_error: 'revision_required',
    message: 'The page already exists; an expected revision is required.' });

  const stale = await dispatchToolCall(engine, 'put_page', { slug, content: page('second body'),
    expected_revision: '11111111-1111-1111-1111-111111111111' }, ctx);
  expect(stale.isError).toBe(true);
  expect(body(stale)).toMatchObject({ write_error: 'revision_conflict',
    message: 'The page changed after it was read. Read its current revision before retrying.' });

  expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toEqual(before);
});
