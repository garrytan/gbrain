/**
 * Wave C 1H-a (ceo-r3-outside-1, read side): while a strict git-first write's committed head waits for its index (the
 * index step paused here), the admission and preparation sites read the page's pending head, not its rows. A whole-page
 * put or upload bound to the head's revision (the indexing receipt's index.revision) replaces it, a put over a
 * never-indexed create sees the page as existing, the size guard measures the head, and a precondition naming the rows'
 * stale revision refuses index_pending. Git always ends with the newest write.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { _resetGitFirstGateForTests, _unregisterIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { assertLargePageAdmission } from '../../src/core/persistence/large-page-guard.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { MiB, pageBody, write } from './helpers.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const strict = (engine: BrainEngine) => engine.executeRaw("UPDATE sources SET config = config || '{\"canonical\":\"git\"}'::jsonb WHERE id='default'");
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string }) => error);
const pendingRequest = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ request_id: string }>(
  "SELECT request_id::text AS request_id FROM page_pending_heads WHERE source_id = 'default' AND slug = $1", [slug]))[0]?.request_id ?? null;
const committed = (root: string, slug: string) => git(root, 'show', 'HEAD:' + slug + '.md');

async function upload(engine: BrainEngine, ctx: OperationContext, slug: string, text: string, expectedRevision: string) {
  const begun = await op('begin_page_upload').handler(ctx, { slug, mode: 'replace', expected_revision: expectedRevision,
    total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() }) as { upload_id: string };
  for (let part = 0, at = 0; at < text.length; part++, at += 3_000_000) {
    const slice = text.slice(at, at + 3_000_000);
    await op('upload_page_part').handler(ctx, { upload_id: begun.upload_id, part, text: slice, part_sha256: hex(slice) });
  }
  await op('commit_page_upload').handler(ctx, { upload_id: begun.upload_id, wait_ms: 3_000 }).catch((error: { code?: string }) => { if (error.code !== 'write_pending') throw error; });
  const [row] = await engine.executeRaw<{ id: string; state: string; error_code: string | null; error_message: string | null }>(
    "SELECT id::text AS id, state, error_code, error_message FROM persistence_requests WHERE slug = $1 AND operation = 'put_page' ORDER BY created_at DESC LIMIT 1", [slug]);
  return row!;
}

for (const backend of testBackends()) describe('[' + backend + '] admission reads the pending head (ceo-r3-outside-1)', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined }); });
  afterEach(() => { _unregisterIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test("a put bound to the committed head's revision replaces it; the rows' revision refuses index_pending", () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const slug = 'notes/pending-replace';
    expect((await write(engine, ctx, slug, pageBody(4 * 1024, 'MARKERFIRSTSMALL'), 'put')).state).toBe('committed');
    const rows = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    const large = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERLARGEHEAD'), 'put', { expectedRevision: rows });
    expect(large.state).toBe('indexing');
    const head = large.outcome?.index?.revision as string;
    expect(head).toMatch(/^[0-9a-f-]{36}$/);
    expect(head).not.toBe(rows);

    const stale = await refusal(op('put_page').handler(ctx, { slug, content: pageBody(4 * 1024, 'MARKERSTALE'), expected_revision: rows, request_id: randomUUID(), wait_ms: 3_000 }));
    expect(stale?.code).toBe('index_pending');
    const replaced = await write(engine, ctx, slug, pageBody(700 * 1024, 'MARKERREPLACED'), 'put', { expectedRevision: head });
    expect(replaced.error).toBeUndefined();
    expect(replaced.state).toBe('committed');
    expect(committed(root, slug)).toContain('MARKERREPLACED');
    expect(await pendingRequest(engine, slug)).toBeNull();
  }, { databaseUrl, setup }), 180_000);

  test('an upload bound to the head replaces a never-indexed create; a create and an unbound put see the page as existing', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const slug = 'notes/pending-upload';
    const large = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERCREATEHEAD'), 'put');
    expect(large.state).toBe('indexing');
    const head = large.outcome?.index?.revision as string;
    const text = pageBody(3 * MiB, 'MARKERUPLOADED');
    const create = await refusal(op('begin_page_upload').handler(ctx, { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() }));
    expect(create?.code).toBe('revision_required');
    const unbound = await write(engine, ctx, slug, pageBody(4 * 1024, 'MARKERUNBOUND'), 'put');
    expect((unbound.error as { code?: string } | undefined)?.code).toBe('revision_required');

    const uploaded = await upload(engine, ctx, slug, text, head);
    expect({ state: uploaded.state, error: uploaded.error_code, message: uploaded.error_message }).toMatchObject({ state: 'indexing', error: null });
    expect(committed(root, slug)).toContain('MARKERUPLOADED');
    expect(await pendingRequest(engine, slug)).toBe(uploaded.id);
  }, { databaseUrl, setup }), 180_000);

  test("the size guard measures the pending head, not the rows", () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const slug = 'notes/pending-size';
    expect((await write(engine, ctx, slug, pageBody(4 * 1024, 'MARKERSIZESMALL'), 'put')).state).toBe('committed');
    const rows = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
    expect((await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKERSIZELARGE'), 'put', { expectedRevision: rows })).state).toBe('indexing');
    const forced = await refusal(assertLargePageAdmission(engine, slug, 'default', { content: pageBody(4 * 1024, 'MARKERFORCED'), force: true }));
    expect(forced?.code).toBe('revision_required');
    const shrunk = await refusal(assertLargePageAdmission(engine, slug, 'default', { content: pageBody(4 * 1024, 'MARKERSHRUNK'), expected_revision: rows }));
    expect(shrunk?.code).toBe('page_shrink_refused');
  }, { databaseUrl, setup }), 180_000);

  test('an edit refuses index_pending, and an append to a never-indexed create refuses index_pending, not page_not_found', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const slug = 'notes/pending-edit';
    const large = await write(engine, ctx, slug, pageBody(2 * MiB, 'MARKEREDITHEAD'), 'put');
    expect(large.state).toBe('indexing');
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const edit = await refusal(op('edit_page').handler(ctx, { slug, expected_revision: large.outcome?.index?.revision,
      edits: [{ old_text: 'MARKEREDITHEAD', new_text: 'MARKEREDITED' }], request_id: randomUUID() }));
    expect(edit?.code).toBe('index_pending');
    const append = await refusal(op('append_page').handler(ctx, { slug, text: '\nMARKERAPPENDED line.\n', request_id: randomUUID(), wait_ms: 3_000 }));
    expect(append?.code).toBe('index_pending');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
  }, { databaseUrl, setup }), 180_000);
});
