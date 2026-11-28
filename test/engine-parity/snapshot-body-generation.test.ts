/**
 * BrainEngine parity: the body generation a page snapshot carries (`PageSnapshot.bodyGeneration`), and restore_page of
 * a segmented page, which reads it.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `readPageSnapshot` and `readPageSnapshotsBatch` of a segmented page carry the page's live body generation
 *    as `bodyGeneration`; an inline page's snapshot has no such key. restore_page of a soft-deleted segmented page
 *    gives the same answer on every arm, over the single-string ceiling (PAGE_MAX_BYTES, the restore reads the stored
 *    manifest at the snapshot's generation) and under it (the restore reads the body back as strings).
 *  - Regression: the Rust store built its snapshot without `bodyGeneration`. A restore over the ceiling then passed
 *    `Number(undefined)` (NaN) to readManifest, so restore_page failed with storage_error on Rust and the page stayed
 *    deleted, while PGLite and Postgres restored it. Read pins (get_page/fetch windows) lost their generation check
 *    too; test/engine-parity/segmented-callers.test.ts pins that case.
 *  - Why existing coverage misses it: test/large-pages/ runs restore_page on PGLite and Postgres only;
 *    chronicle-decision.test.ts pinned the missing key on Rust as a known gap.
 *  - Seam: none. Real engines; the pages are imported through the streamed segmented import and changed through the
 *    delete_page and restore_page tools.
 */
import { afterAll, describe, expect } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importStreamedMarkdownFile } from '../../src/core/page-body/streamed-import.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { acceptedPendingReceipt, dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const root = mkdtempSync(join(tmpdir(), 'gbrain-parity-snapshot-body-generation-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const LOCAL = { remote: false, admissionOrigin: 'interactive', transport: 'stdio', sourceId: 'default' } as const;
const SLUG = 'notes/long-log';

/** A note of at least `bytes` bytes of short entries. */
function longNote(bytes: number): string {
  const entries: string[] = [];
  let size = 0;
  for (let i = 1; size < bytes; i++) {
    const entry = `## Entry ${i}\n\nLine about item ${i} and the brain index.\n`;
    entries.push(entry);
    size += entry.length + 1;
  }
  return `---\ntype: note\ntitle: Long log\n---\n\n# Long log\n\n${entries.join('\n')}`;
}

/** The note imported as sync imports a large file: streamed, stored segmented. */
async function importLong(engine: BrainEngine, backend: string, bytes: number): Promise<void> {
  await engine.setConfig('pages.segmented_storage', 'on');
  const file = join(root, `${backend}-${bytes}.md`);
  writeFileSync(file, longNote(bytes));
  const imported = await importStreamedMarkdownFile(engine, file, `${SLUG}.md`, { noEmbed: true, sourceId: 'default' }, statSync(file),
    await readPageBodyPolicy(engine));
  expect(imported.status).toBe('imported');
}

/** One tool call as an agent makes it, repeated with the same request_id while the write is still pending. */
async function tool(engine: BrainEngine, name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  let out = await dispatchToolCall(engine, name, { ...params }, LOCAL as never);
  for (let pending = acceptedPendingReceipt(out); pending; pending = acceptedPendingReceipt(out)) {
    out = await dispatchToolCall(engine, name, { ...params, request_id: pending.request_id }, LOCAL as never);
  }
  return JSON.parse((out as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
}

const revisionOf = async (engine: BrainEngine) => (await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true }))!.revision;

/** The parts of a delete or restore answer an agent acts on; revisions and request ids differ per run. */
const answer = (out: Record<string, unknown>) => ({
  code: out.code ?? null, status: out.status ?? null, noop: out.noop ?? null, chunks: out.chunks ?? null,
  projection: out.projection ?? null, size_state: out.size_state ?? null,
});

describe('engine parity: the body generation of a page snapshot', () => {
  parityTest('a segmented page snapshot carries its body generation, single and batched; an inline one has no such key', {
    methods: ['readPageSnapshot', 'readPageSnapshotsBatch', 'putPage'],
  }, async (engine, backend) => {
    await importLong(engine, backend, 1_300_000);
    await engine.putPage('notes/short', { type: 'note', title: 'Short', compiled_truth: 'A short page.', timeline: '' });
    const single = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
    const inline = await engine.readPageSnapshot('notes/short', { sourceId: 'default' });
    const batch = await engine.readPageSnapshotsBatch([{ slug: SLUG, sourceId: 'default' }, { slug: 'notes/short', sourceId: 'default' }]);
    const [batchSegmented, batchInline] = [...batch.snapshots.values()];
    const out = {
      storage: single?.page.body_storage ?? null,
      single: single?.bodyGeneration ?? null,
      batch: batchSegmented?.bodyGeneration ?? null,
      inlineHasKey: inline ? 'bodyGeneration' in inline : null,
      batchInlineHasKey: batchInline ? 'bodyGeneration' in batchInline : null,
      covered: batch.covered,
    };
    expect(out).toEqual({ storage: 'segmented', single: 1, batch: 1, inlineHasKey: false, batchInlineHasKey: false, covered: 2 });
    return out;
  });

  for (const [label, bytes, restored] of [
    ['under the single-string ceiling (read back whole)', 1_300_000, { code: null, status: 'restored', noop: false, chunks: 0, projection: null }],
    ['over the single-string ceiling (manifest read at the snapshot generation)', PAGE_MAX_BYTES + 4096, { code: null, status: 'restored', noop: false, chunks: 0, projection: null }],
  ] as const) {
    parityTest(`restore_page of a soft-deleted segmented page ${label} restores it`, {
      methods: ['readPageSnapshot', 'readManifest'], timeout: 300_000,
    }, async (engine, backend) => {
      await importLong(engine, backend, bytes);
      const deleted = answer(await tool(engine, 'delete_page', { slug: SLUG, expected_revision: await revisionOf(engine) }));
      const restore = answer(await tool(engine, 'restore_page', { slug: SLUG, expected_revision: await revisionOf(engine) }));
      const after = await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
      const live = after ? await engine.readManifest(Number(after.page.id)) : [];
      const out = { deleted: { code: deleted.code, status: deleted.status }, restore, page: {
        deleted: after?.page.deleted_at != null, storage: after?.page.body_storage ?? null, manifestRows: live.length > 0,
      } };
      expect(out).toMatchObject({ deleted: { code: null, status: 'soft_deleted' }, restore: restored,
        page: { deleted: false, storage: 'segmented', manifestRows: true } });
      return out;
    });
  }
});
