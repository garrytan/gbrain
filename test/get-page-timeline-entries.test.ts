/**
 * #5709: `add_timeline_entry` writes timeline_entries rows only, so get_page's
 * `timeline` (the markdown section after the sentinel) reads "" for a page
 * whose timeline lives in rows. get_page now takes `include_timeline_entries`
 * and returns the same rows get_timeline returns for the same caller, under
 * their own key. The body fields (compiled_truth, timeline, content) are
 * unchanged by the flag, so the `page` evidence unit (#5769), which mirrors
 * get_page's sanitized body + timeline, needs no change.
 *
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;
const ctxOf = (remote: boolean) => ({
  engine, remote, sourceId: 'default', config: { engine: 'pglite' },
  logger: { info() {}, warn() {}, error() {} },
}) as unknown as OperationContext;
const call = (name: string, remote: boolean, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctxOf(remote), params) as Promise<Record<string, unknown>>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importFromContent(engine, 'notes/example', '---\ntype: note\ntitle: Example\n---\n\nAn example note.\n', { noEmbed: true });
  await engine.addTimelineEntry('notes/example', { date: '2026-09-01', source: 'meeting', summary: 'Kickoff held' });
  await engine.addTimelineEntry('notes/example', { date: '2026-09-15', source: 'email', summary: 'Plan approved' });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

describe('#5709 get_page include_timeline_entries', () => {
  test('without the flag the payload is unchanged and has no timeline_entries', async () => {
    const page = await call('get_page', false, { slug: 'notes/example' });
    expect(page.timeline).toBe('');
    expect('timeline_entries' in page).toBe(false);
  });

  for (const remote of [false, true]) {
    test(`remote=${remote}: returns the rows get_timeline returns for the same caller`, async () => {
      const page = await call('get_page', remote, { slug: 'notes/example', include_timeline_entries: true });
      const rows = await call('get_timeline', remote, { slug: 'notes/example' });
      expect(page.timeline_entries).toEqual(rows);
      expect((page.timeline_entries as Array<{ summary: string }>).map(e => e.summary).sort()).toEqual(['Kickoff held', 'Plan approved']);
    });

    test(`remote=${remote}: body fields match the call without the flag`, async () => {
      const plain = await call('get_page', remote, { slug: 'notes/example', include_content: true });
      const withRows = await call('get_page', remote, { slug: 'notes/example', include_content: true, include_timeline_entries: true });
      const { timeline_entries: _rows, ...rest } = withRows;
      expect(rest).toEqual(plain);
    });
  }

  test('a private page stays hidden from a remote caller with the flag', async () => {
    await importFromContent(engine, 'notes/secret', '---\ntype: note\ntitle: Secret\nvisibility: private\n---\n\nHidden.\n', { noEmbed: true });
    await engine.addTimelineEntry('notes/secret', { date: '2026-09-02', source: 'note', summary: 'Private row' });
    await expect(call('get_page', true, { slug: 'notes/secret', include_timeline_entries: true })).rejects.toMatchObject({ code: 'page_not_found' });
  });
});
