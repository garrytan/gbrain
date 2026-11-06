/**
 * Page purge (#5575 CEO-4, CEO-8, ENG-19): `delete_page purge:true` sweeps the
 * page's live stores, deletes its stored blobs after commit, and records a
 * slug-free content tombstone. The same content is refused (typed
 * purged_content) under any slug until `unpurge_page`; edited content imports.
 * Real PGLite, local blob storage, no provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';
import { screenImportContent } from '../src/core/import-screen.ts';
import { readPagePurgeTombstones } from '../src/core/persistence/page-purge.ts';

let engine: PGLiteEngine;
let storageDir: string;
const home = mkdtempSync(join(tmpdir(), 'gbrain-page-purge-'));
const op = (name: string) => operations.find(o => o.name === name)!;
const SLUG = 'notes/leaked-key';
const CONTENT = `---\ntitle: Leaked key\ntype: note\n---\n# Leaked key\n\nThe key is AKIA-EXAMPLE-NOT-REAL.\n\n## Facts\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Deploy key lives in vault-a | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->\n`;

function context(remote = false): OperationContext {
  return { engine, config: { engine: 'pglite', embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: storageDir } } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'default' };
}
const call = (name: string, params: Record<string, unknown>, remote = false) =>
  withEnv({ GBRAIN_HOME: home }, () => op(name).handler(context(remote), params)) as Promise<Record<string, any>>;
async function purgePage(slug = SLUG) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  return call('delete_page', { slug, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision });
}
async function errorText(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok'; } catch (e) { return e instanceof OperationError ? `${e.canonical ?? e.code}: ${e.message}` : String((e as Error).message); }
}

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);
beforeEach(async () => {
  await disposePersistenceConsumer(engine); await resetPgliteState(engine); _resetWriteThroughCacheForTest();
  storageDir = mkdtempSync(join(home, 'storage-'));
});

describe('page purge', () => {
  test('sweeps every page-keyed store, deletes the blob after commit and reports counts', async () => {
    await importFromContent(engine, SLUG, CONTENT, { noEmbed: true, sourceId: 'default' });
    await runExtractFacts(engine, { slugs: [SLUG] });
    const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1', [SLUG]);
    mkdirSync(join(storageDir, 'notes'), { recursive: true });
    writeFileSync(join(storageDir, 'notes/leaked.png'), 'blob-bytes');
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      await tx.createVersion(SLUG, { sourceId: 'default' });
      await tx.executeRaw(`INSERT INTO takes(page_id,row_num,claim,kind,holder) VALUES ($1,1,'A take on the key','take','brain')`, [page.id]);
    }, TEST_WRITE_ATTRIBUTION));
    await engine.executeRaw(`INSERT INTO take_proposals(source_id,page_slug,content_hash,prompt_version,wave_version,proposal_run_id,claim_text,kind,holder,weight,status,model_id)
      VALUES ('default',$1,'h','p','w','run-1','Proposed take','take','brain',0.5,'pending','m')`, [SLUG]);
    await engine.executeRaw(`INSERT INTO open_loops(source_id,dedup_key,loop_type,summary,page_slug,status,detector,confidence)
      VALUES ('default','k1','commitment_owed_by_me','Rotate the key',$1,'open','manual',0.9)`, [SLUG]);
    await engine.executeRaw(`INSERT INTO core_edit_notices(source_id,slug,base_text,actor) VALUES ('default',$1,'old body','agent')`, [SLUG]);
    await engine.executeRaw(`INSERT INTO files(source_id,page_slug,page_id,filename,storage_path,mime_type,size_bytes,content_hash)
      VALUES ('default',$1,$2,'leaked.png','notes/leaked.png','image/png',10,'fh')`, [SLUG, page.id]);
    const result = await purgePage();
    expect(result.status).toBe('purged');
    expect(result.purge.removed).toMatchObject({ facts: 1, take_proposals: 1, open_loops: 1, core_edit_notices: 1, files: 1, takes: 1, page_versions: 1 });
    expect(result.purge.blobs_remaining).toEqual([]);
    expect(existsSync(join(storageDir, 'notes/leaked.png'))).toBe(false);
    expect(String(result.residuals)).toContain('git history');
    for (const sql of ['SELECT 1 FROM pages WHERE slug=$1', 'SELECT 1 FROM facts WHERE source_markdown_slug=$1', 'SELECT 1 FROM take_proposals WHERE page_slug=$1',
      'SELECT 1 FROM open_loops WHERE page_slug=$1', 'SELECT 1 FROM core_edit_notices WHERE slug=$1', 'SELECT 1 FROM files WHERE page_slug=$1']) {
      expect(await engine.executeRaw(sql, [SLUG])).toHaveLength(0);
    }
    expect(await engine.executeRaw(`SELECT 1 FROM content_chunks WHERE strpos(chunk_text,'AKIA-EXAMPLE')>0`)).toHaveLength(0);
    const [tombstone] = await engine.executeRaw<{ slug: string; content_hash: string }>('SELECT slug,content_hash FROM page_purges');
    expect(tombstone.slug).toBe(SLUG);
    expect(await engine.executeRaw(`SELECT 1 FROM fact_purges WHERE reason='page purge'`)).toHaveLength(1);
  }, 60_000);

  test('a file_upload to a page in a non-default source records that page, so purging it removes the row and the stored object (#8513)', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT DO NOTHING");
    await importFromContent(engine, 'notes/plan', '---\ntitle: Plan\ntype: note\n---\n# Plan\n\nBody.\n', { noEmbed: true, sourceId: 'source-a' });
    const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/plan' AND source_id='source-a'");
    const upload = join(storageDir, '..', 'attachment.txt');
    writeFileSync(upload, 'attachment bytes');
    const ctx = { ...context(), sourceId: 'source-a' };
    await withEnv({ GBRAIN_HOME: home }, () => op('file_upload').handler(ctx, { path: upload, page_slug: 'notes/plan' }));
    expect(await engine.executeRaw('SELECT source_id, page_id FROM files')).toEqual([{ source_id: 'source-a', page_id: page!.id }]);
    expect(existsSync(join(storageDir, 'notes/plan/attachment.txt'))).toBe(true);
    const snapshot = await engine.readPageSnapshot('notes/plan', { sourceId: 'source-a', includeDeleted: true });
    const result = await withEnv({ GBRAIN_HOME: home }, () => op('delete_page').handler(ctx, { slug: 'notes/plan', purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision })) as Record<string, any>;
    expect([result.status, result.purge.removed.files, result.purge.blobs_remaining]).toEqual(['purged', 1, []]);
    expect(await engine.executeRaw('SELECT 1 FROM files')).toEqual([]);
    expect(existsSync(join(storageDir, 'notes/plan/attachment.txt'))).toBe(false);
  });

  test('a file_upload never takes another source\'s live attachment: different bytes are refused, identical bytes leave the row with its owner', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT DO NOTHING");
    const page = '---\ntitle: Plan\ntype: note\n---\n# Plan\n\nBody.\n';
    await importFromContent(engine, 'notes/plan', page, { noEmbed: true, sourceId: 'default' });
    await importFromContent(engine, 'notes/plan', page, { noEmbed: true, sourceId: 'source-a' });
    const [owner] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/plan' AND source_id='default'");
    const upload = join(storageDir, '..', 'attachment.txt');
    writeFileSync(upload, 'default bytes');
    await call('file_upload', { path: upload, page_slug: 'notes/plan' });
    const ctx = { ...context(), sourceId: 'source-a' };
    const uploadAsA = () => withEnv({ GBRAIN_HOME: home }, () => op('file_upload').handler(ctx, { path: upload, page_slug: 'notes/plan' })) as Promise<Record<string, any>>;
    expect((await uploadAsA()).status).toBe('already_exists');
    writeFileSync(upload, 'source-a bytes');
    expect(await errorText(uploadAsA())).toStartWith('invalid_params: ');
    expect(readFileSync(join(storageDir, 'notes/plan/attachment.txt'), 'utf8')).toBe('default bytes');
    expect(await engine.executeRaw('SELECT source_id, page_id FROM files')).toEqual([{ source_id: 'default', page_id: owner!.id }]);
    const snapshot = await engine.readPageSnapshot('notes/plan', { sourceId: 'source-a', includeDeleted: true });
    const result = await withEnv({ GBRAIN_HOME: home }, () => op('delete_page').handler(ctx, { slug: 'notes/plan', purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision })) as Record<string, any>;
    expect([result.status, result.purge.removed.files]).toEqual(['purged', 0]);
    expect(existsSync(join(storageDir, 'notes/plan/attachment.txt'))).toBe(true);
  });

  test('an upload over a row with no page id records the uploader\'s page, so purging that page in a non-default source removes the row and its bytes', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT DO NOTHING");
    const upload = join(storageDir, '..', 'attachment.txt');
    writeFileSync(upload, 'early bytes');
    await call('file_upload', { path: upload, page_slug: 'notes/plan' });
    await importFromContent(engine, 'notes/plan', '---\ntitle: Plan\ntype: note\n---\n# Plan\n\nBody.\n', { noEmbed: true, sourceId: 'source-a' });
    const [pageA] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/plan' AND source_id='source-a'");
    writeFileSync(upload, 'source-a bytes');
    const ctx = { ...context(), sourceId: 'source-a' };
    await withEnv({ GBRAIN_HOME: home }, () => op('file_upload').handler(ctx, { path: upload, page_slug: 'notes/plan' }));
    expect(await engine.executeRaw('SELECT source_id, page_id FROM files')).toEqual([{ source_id: 'source-a', page_id: pageA!.id }]);
    const snapshot = await engine.readPageSnapshot('notes/plan', { sourceId: 'source-a', includeDeleted: true });
    const result = await withEnv({ GBRAIN_HOME: home }, () => op('delete_page').handler(ctx, { slug: 'notes/plan', purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision })) as Record<string, any>;
    expect([result.status, result.purge.removed.files]).toEqual(['purged', 1]);
    expect(existsSync(join(storageDir, 'notes/plan/attachment.txt'))).toBe(false);
  });

  test('an identical re-upload from a source with no such page leaves the row with its page, so purging that page still removes it', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING");
    await importFromContent(engine, 'notes/plan', '---\ntitle: Plan\ntype: note\n---\n# Plan\n\nBody.\n', { noEmbed: true, sourceId: 'default' });
    const [owner] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/plan' AND source_id='default'");
    const upload = join(storageDir, '..', 'attachment.txt');
    writeFileSync(upload, 'plan bytes');
    await call('file_upload', { path: upload, page_slug: 'notes/plan' });
    const ctx = { ...context(), sourceId: 'source-b' };
    expect((await withEnv({ GBRAIN_HOME: home }, () => op('file_upload').handler(ctx, { path: upload, page_slug: 'notes/plan' })) as Record<string, any>).status).toBe('already_exists');
    expect(await engine.executeRaw('SELECT source_id, page_id FROM files')).toEqual([{ source_id: 'default', page_id: owner!.id }]);
    const result = await purgePage('notes/plan');
    expect([result.status, result.purge.removed.files]).toEqual(['purged', 1]);
    expect(existsSync(join(storageDir, 'notes/plan/attachment.txt'))).toBe(false);
  });

  test('re-uploading identical bytes to a page that took a renamed page\'s slug records the new page, so purging the renamed page keeps the attachment', async () => {
    const page = '---\ntitle: Old\ntype: note\n---\n# Old\n\nBody.\n';
    await importFromContent(engine, 'notes/old', page, { noEmbed: true, sourceId: 'default' });
    const upload = join(storageDir, '..', 'attachment.txt');
    writeFileSync(upload, 'same bytes');
    await call('file_upload', { path: upload, page_slug: 'notes/old' });
    await engine.executeRaw("UPDATE pages SET slug='notes/moved' WHERE slug='notes/old' AND source_id='default'");
    await importFromContent(engine, 'notes/old', page, { noEmbed: true, sourceId: 'default' });
    const [replacement] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/old' AND source_id='default'");
    expect((await call('file_upload', { path: upload, page_slug: 'notes/old' })).status).toBe('already_exists');
    expect(await engine.executeRaw('SELECT page_id FROM files')).toEqual([{ page_id: replacement!.id }]);
    expect((await purgePage('notes/moved')).status).toBe('purged');
    expect(await engine.executeRaw('SELECT page_id FROM files')).toEqual([{ page_id: replacement!.id }]);
    expect(existsSync(join(storageDir, 'notes/old/attachment.txt'))).toBe(true);
  });

  test('purging a page that took a renamed page\'s slug keeps the attachment the renamed page still owns', async () => {
    const page = '---\ntitle: Old\ntype: note\n---\n# Old\n\nBody.\n';
    await importFromContent(engine, 'notes/old', page, { noEmbed: true, sourceId: 'default' });
    const [owner] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/old' AND source_id='default'");
    const upload = join(storageDir, '..', 'attachment.txt');
    writeFileSync(upload, 'owned bytes');
    await call('file_upload', { path: upload, page_slug: 'notes/old' });
    await engine.executeRaw("UPDATE pages SET slug='notes/moved' WHERE id=$1", [owner!.id]);
    await importFromContent(engine, 'notes/old', page, { noEmbed: true, sourceId: 'default' });
    const result = await purgePage('notes/old');
    expect([result.status, result.purge.removed.files]).toEqual(['purged', 0]);
    expect(await engine.executeRaw('SELECT page_id FROM files')).toEqual([{ page_id: owner!.id }]);
    expect(existsSync(join(storageDir, 'notes/old/attachment.txt'))).toBe(true);
  });

  test('a file_upload under a source that is not registered refuses before writing, leaving the stored object and its row as they were', async () => {
    await importFromContent(engine, 'notes/plan', '---\ntitle: Plan\ntype: note\n---\n# Plan\n\nBody.\n', { noEmbed: true, sourceId: 'default' });
    const upload = join(storageDir, '..', 'attachment.txt');
    writeFileSync(upload, 'default bytes');
    await call('file_upload', { path: upload, page_slug: 'notes/plan' });
    const before = await engine.executeRaw('SELECT source_id, page_id, content_hash FROM files');
    writeFileSync(upload, 'other bytes');
    const ctx = { ...context(), sourceId: 'source-missing' };
    expect(await errorText(withEnv({ GBRAIN_HOME: home }, () => op('file_upload').handler(ctx, { path: upload, page_slug: 'notes/plan' })))).toStartWith('unknown_source: ');
    expect(readFileSync(join(storageDir, 'notes/plan/attachment.txt'), 'utf8')).toBe('default bytes');
    expect(await engine.executeRaw('SELECT source_id, page_id, content_hash FROM files')).toEqual(before);
  });

  test('the tombstone refuses the same content under any slug until unpurge; edited content imports', async () => {
    await importFromContent(engine, SLUG, CONTENT, { noEmbed: true, sourceId: 'default' });
    await runExtractFacts(engine, { slugs: [SLUG] });
    await purgePage();
    expect(await errorText(importFromContent(engine, SLUG, CONTENT, { noEmbed: true, sourceId: 'default' }))).toContain('purged_content');
    // The prefetched tombstones match the stale file's own bytes, so sync holds it at screen time.
    const screen = screenImportContent({ content: CONTENT, path: `${SLUG}.md`, purgedPages: await readPagePurgeTombstones(engine, 'default') });
    expect(screen.status === 'refused' && screen.refusal.code).toBe('purged_content');
    expect(await errorText(importFromContent(engine, 'notes/renamed-copy', CONTENT, { noEmbed: true, sourceId: 'default' }))).toContain('purged_content');
    expect(await errorText(call('put_page', { slug: SLUG, content: CONTENT, request_id: randomUUID() }))).toContain('purged_content');
    await importFromContent(engine, 'notes/edited', CONTENT.replace('AKIA-EXAMPLE-NOT-REAL', 'rotated'), { noEmbed: true, sourceId: 'default' });
    expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1', ['notes/edited'])).toHaveLength(1);
    const listed = await call('list_page_purges', {});
    expect(listed.purges.length).toBeGreaterThanOrEqual(1);
    expect(listed.purges.every((p: { slug: string }) => p.slug === SLUG)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('AKIA');
    expect(await errorText(call('unpurge_page', { slug: SLUG }, true))).toContain('trusted_local_only');
    const cleared = await call('unpurge_page', { slug: SLUG });
    expect(cleared).toMatchObject({ cleared: listed.purges.length, fact_tombstones_cleared: 1 });
    await importFromContent(engine, SLUG, CONTENT, { noEmbed: true, sourceId: 'default' });
    await runExtractFacts(engine, { slugs: [SLUG] });
    expect(await engine.executeRaw(`SELECT 1 FROM facts WHERE fact='Deploy key lives in vault-a'`)).toHaveLength(1);
  }, 60_000);
});
