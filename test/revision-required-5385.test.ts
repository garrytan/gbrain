/**
 * #5385 [R13]: a write that names no `expected_revision` for an existing page is `revision_required`, its own code,
 * while a stale supplied revision stays `revision_conflict`.
 *
 * Protects: a client that switches on the code can tell "I forgot the precondition: read the page and resubmit"
 * from "someone else moved the page". The semantic merges (`add_tag`, `remember`, a forced put) submitted without a
 * revision still converge through the coordinator's re-preparation (`mayReprepare` accepts the new code), and a
 * blind stale replacement is still refused and never retried. Internal writers that admitted a page as absent
 * (`expectedRevision: null`) keep `revision_conflict` when another writer created it, so the sync fault classes
 * never see the new code.
 * Fails when: the missing case reports `revision_conflict`, the stale case reports `revision_required`, or a
 * semantic merge without a revision stops converging.
 * Seams: `assertPageRevision`, `mayReprepare`, `dispatchToolCall` on a PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { assertPageRevision, PageRevisionConflictError, REVISION_BACKFILL_PENDING } from '../src/core/page-state/types.ts';
import { mayReprepare } from '../src/core/persistence/semantic.ts';
import { CODES } from '../src/core/error-registry.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';

const REV = '0f6d2f4a-9d6b-4c3e-8a1f-2b7c9d0e1f23';
const OTHER = '11111111-1111-1111-1111-111111111111';
const code = (run: () => void): string => { try { run(); } catch (e) { return (e as PageRevisionConflictError).code; } return 'ok'; };

describe('#5385 assertPageRevision', () => {
  test('no precondition on an existing page is revision_required; a stale or asserted-absent one is revision_conflict', () => {
    expect(code(() => assertPageRevision({ revision: REV }, {}))).toBe('revision_required');
    expect(code(() => assertPageRevision({ revision: REV }))).toBe('revision_required');
    expect(code(() => assertPageRevision({ revision: REV }, { expectedRevision: OTHER }))).toBe('revision_conflict');
    expect(code(() => assertPageRevision({ revision: REV }, { expectedRevision: null }))).toBe('revision_conflict');
    expect(code(() => assertPageRevision(null, { expectedRevision: REV }))).toBe('revision_conflict');
    expect(code(() => assertPageRevision(null, {}))).toBe('ok');
    expect(code(() => assertPageRevision(null, { expectedRevision: null }))).toBe('ok');
    expect(code(() => assertPageRevision({ revision: REV }, { expectedRevision: REV }))).toBe('ok');
    expect(code(() => assertPageRevision({ revision: REV }, { force: true }))).toBe('ok');
    expect(code(() => assertPageRevision({ revision: REVISION_BACKFILL_PENDING }, {}))).toBe('revision_backfill_pending');
    expect(code(() => assertPageRevision({ revision: REVISION_BACKFILL_PENDING }, { expectedRevision: REV }))).toBe('revision_backfill_pending');
  });

  test('each code keeps its own message', () => {
    expect(new PageRevisionConflictError(undefined, REV).message).toBe('The page already exists; an expected revision is required.');
    expect(new PageRevisionConflictError(null, REV).message).toBe('The page was created after it was read. Read its current revision before retrying.');
    expect(new PageRevisionConflictError(OTHER, REV).message).toBe('The page changed after it was read. Read its current revision before retrying.');
    expect(new PageRevisionConflictError(REV, null).message).toBe('The page no longer exists at the expected revision.');
    expect(new PageRevisionConflictError(REV, null).code).toBe('revision_conflict');
  });

  test('the registry names the fix: read the page', () => {
    const entry = CODES.revision_required;
    expect(entry.class).toBe('caller');
    expect(entry.fix?.mcp?.tool).toBe('get_page');
    expect(entry.fix?.argv?.[0]).toBe('gbrain');
    expect(entry.summary).toContain('expected revision');
  });
});

describe('#5385 mayReprepare [R13]', () => {
  const row = (operation: string, intent: Record<string, unknown>) => ({ operation, intent } as unknown as WriteRequest);
  test('a merge without a revision recomputes on either code; a supplied stale revision never does', () => {
    for (const c of ['revision_conflict', 'revision_required']) {
      expect(mayReprepare(row('add_tag', {}), { code: c })).toBe(true);
      expect(mayReprepare(row('remember', { fact: 'x' }), { code: c })).toBe(true);
      expect(mayReprepare(row('put_page', { force: true }), { code: c })).toBe(true);
      expect(mayReprepare(row('add_tag', { expected_revision: OTHER }), { code: c })).toBe(false);
      expect(mayReprepare(row('put_page', {}), { code: c })).toBe(false);
    }
    expect(mayReprepare(row('add_tag', {}), { code: 'revision_backfill_pending' })).toBe(false);
  });
});

describe('#5385 on a PGLite brain through the tool surface', () => {
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

  test('missing → revision_required with the get_page fix; stale → revision_conflict; force and the right revision write', async () => {
    const slug = 'notes/revision-required-example';
    expect((await dispatchToolCall(engine, 'put_page', { slug, content: page('first') }, ctx)).isError ?? false).toBe(false);
    const before = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;

    const missing = body(await dispatchToolCall(engine, 'put_page', { slug, content: page('second') }, ctx));
    expect(missing).toMatchObject({ write_error: 'revision_required' });
    expect(JSON.stringify(missing)).toContain('get_page');

    const stale = body(await dispatchToolCall(engine, 'put_page', { slug, content: page('second'), expected_revision: OTHER }, ctx));
    expect(stale).toMatchObject({ write_error: 'revision_conflict' });
    expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision).toBe(before.revision);

    const forced = await dispatchToolCall(engine, 'put_page', { slug, content: page('forced'), force: true, request_id: randomUUID() }, ctx);
    expect(forced.isError ?? false).toBe(false);
    const after = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    expect(after.revision).not.toBe(before.revision);
    const bound = await dispatchToolCall(engine, 'put_page', { slug, content: page('third'), expected_revision: after.revision, request_id: randomUUID() }, ctx);
    expect(bound.isError ?? false).toBe(false);
  });

  test('semantic merges without a revision converge on an existing page (the retry path stays open)', async () => {
    const slug = 'notes/revision-required-merge';
    await dispatchToolCall(engine, 'put_page', { slug, content: page('prose') }, ctx);
    const results = await Promise.all(['a', 'b', 'c'].map((tag) => dispatchToolCall(engine, 'add_tag', { slug, tag: `tag-${tag}`, request_id: randomUUID() }, ctx)));
    for (const r of results) expect(r.isError ?? false).toBe(false);
    expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.tags).toEqual(['tag-a', 'tag-b', 'tag-c']);
  });
});
