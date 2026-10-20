/**
 * The file drift check of a segmented page over the single-string ceiling on a file-backed source (Wave B).
 *
 * 1. Protects: on a managed source with a claimed worktree, delete_page (soft
 *    and purge:true) and restore_page of a page whose body is over
 *    PAGE_MAX_BYTES compare the canonical file with the stored body by digest,
 *    streamed (no segment read or hashed piece over one segment), and succeed
 *    when the file matches: the soft delete removes the file, the purge
 *    removes page and file, and the restore of a page sync soft-deleted
 *    clears deleted_at without re-importing, writes the file back from the
 *    segments (a file the next drift check matches) and reseals. A file edited
 *    on disk still refuses all three as drift (source_changed, "The canonical
 *    file contains an uncoordinated local edit."), the refusal an inline page gets.
 * 2. Fails when: the drift check (or the restore) reads the body through the
 *    page's throwing getters (page_body_segmented), reads the stored body in
 *    batches over a segment, or a drifted file is taken for a match.
 * 3. Existing coverage: page-purge-segments.test.ts purges on a source with
 *    no worktree, so no file is compared; no test restores such a page.
 * 4. No production seam: bodyDigestWork is the module's own work counter.
 * The huge page is seeded through the owner's own steps (helpers/owner-import.ts), sealed before the test goes on: the
 * subject is the drift check, and on a loaded host the projection of a 24.5 MiB page can outlast importManagedFile's wait.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { bodyDigestWork } from '../../src/core/page-body/body-digests.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { ownerImportFile } from '../helpers/owner-import.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-file-drift-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const logger = { info() {}, warn() {}, error() {} };
// Over the single-string ceiling, under the 25 MiB pre-push scan cap a restored file must fit.
const huge = conversationPage(PAGE_MAX_BYTES + 512 * 1024, { seed: 97, needles: [{ at: 0.5, word: 'midpointmarker' }] });

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

interface Fixture { sourceId: string; root: string; ctx: OperationContext }

async function managedSource(engine: BrainEngine): Promise<Fixture> {
  await disposePersistenceConsumer(engine);
  await engine.setConfig('pages.segmented_storage', 'on');
  const root = join(home, `src-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const sourceId = `drift-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
  return { sourceId, root, ctx };
}

async function importHuge(engine: BrainEngine, f: Fixture, slug: string): Promise<string> {
  const file = join(f.root, `${slug}.md`);
  writeFileSync(file, huge);
  await disposePersistenceConsumer(engine);
  await ownerImportFile(engine, f.sourceId, file, `${slug}.md`);
  const [row] = await engine.executeRaw<{ body_storage: string; body_bytes: string }>('SELECT body_storage, body_bytes::text AS body_bytes FROM pages WHERE source_id=$1 AND slug=$2', [f.sourceId, slug]);
  expect(row?.body_storage).toBe('segmented');
  expect(Number(row?.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
  return file;
}

async function pageState(engine: BrainEngine, f: Fixture, slug: string) {
  const [row] = await engine.executeRaw<{ deleted: boolean; content_hash: string; body_bytes: string; sealed: boolean }>(`SELECT deleted_at IS NOT NULL AS deleted, content_hash,
    body_bytes::text AS body_bytes, text_projection_revision = knowledge_revision AS sealed FROM pages WHERE source_id=$1 AND slug=$2`, [f.sourceId, slug]);
  return row ?? null;
}

const revisionOf = async (engine: BrainEngine, f: Fixture, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: f.sourceId, includeDeleted: true }))!.revision;

async function submit(engine: BrainEngine, f: Fixture, operation: 'delete_page' | 'restore_page', slug: string, extra: Record<string, unknown> = {}) {
  return submitPageMutation(f.ctx, { operation, params: { slug, expected_revision: await revisionOf(engine, f, slug), request_id: randomUUID(), ...extra } }) as Promise<Record<string, any>>;
}

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try { await p; } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message }; }
  throw new Error('expected a refusal');
}

/** Every segment text read one at a time, none over a segment. */
function spySegmentReads(engine: BrainEngine) {
  const original = engine.readSegmentTexts.bind(engine);
  const reads = { calls: 0, maxShas: 0, maxBytes: 0 };
  engine.readSegmentTexts = async (sourceId, shas) => {
    const texts = await original(sourceId, shas);
    reads.calls++;
    reads.maxShas = Math.max(reads.maxShas, shas.length);
    for (const text of texts.values()) reads.maxBytes = Math.max(reads.maxBytes, text.byteLength);
    return texts;
  };
  return { reads, restore: () => { engine.readSegmentTexts = original; } };
}

const coordinated = <T>(engine: BrainEngine, sourceId: string, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => fn(tx), TEST_WRITE_ATTRIBUTION));
const resetWork = () => Object.assign(bodyDigestWork, { fileBytes: 0, segmentBytes: 0, largestPiece: 0 });

test('soft delete, purge and restore of a page over the ceiling compare its file streamed', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await managedSource(engine);
    const files = { soft: await importHuge(engine, f, 'notes/soft'), purge: await importHuge(engine, f, 'notes/purge'), restore: await importHuge(engine, f, 'notes/restore') };
    const before = (await pageState(engine, f, 'notes/soft'))!;
    const fileBytes = statSync(files.soft).size;
    const spy = spySegmentReads(engine);
    const expectStreamed = () => {
      // One pass over the stored body, a scan and a hash pass over the file, nothing larger than a segment.
      expect(bodyDigestWork.segmentBytes).toBe(Number(before.body_bytes));
      expect(bodyDigestWork.fileBytes).toBeGreaterThanOrEqual(fileBytes);
      expect(bodyDigestWork.fileBytes).toBeLessThanOrEqual(2 * fileBytes);
      expect(bodyDigestWork.largestPiece).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
      expect(spy.reads.calls).toBeGreaterThan(0);
      expect(spy.reads.maxShas).toBe(1);
      expect(spy.reads.maxBytes).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    };
    try {
      resetWork();
      expect(await submit(engine, f, 'delete_page', 'notes/soft')).toMatchObject({ status: 'soft_deleted', noop: false });
      expect(existsSync(files.soft)).toBe(false);
      expect((await pageState(engine, f, 'notes/soft'))?.deleted).toBe(true);
      expectStreamed();

      resetWork();
      expect(await submit(engine, f, 'delete_page', 'notes/purge', { purge: true })).toMatchObject({ status: 'purged' });
      expect(existsSync(files.purge)).toBe(false);
      expect(await pageState(engine, f, 'notes/purge')).toBeNull();
      expectStreamed();

      // The page as sync leaves it when its file is removed: soft-deleted, no file. The restore clears deleted_at
      // without re-importing (same body and hash), reseals, and writes the file back from the segments.
      rmSync(files.restore);
      await coordinated(engine, f.sourceId, tx => tx.softDeletePage('notes/restore', { sourceId: f.sourceId }));
      expect(await submit(engine, f, 'restore_page', 'notes/restore')).toMatchObject({ status: 'restored', noop: false });
      expect(await pageState(engine, f, 'notes/restore')).toMatchObject({ deleted: false, content_hash: before.content_hash, body_bytes: before.body_bytes, sealed: true });
      expect(parseMarkdown(readFileSync(files.restore, 'utf8'), 'notes/restore.md').compiled_truth).toBe(parseMarkdown(huge, 'notes/restore.md').compiled_truth);
      expect(spy.reads.maxShas).toBe(1);
      expect(spy.reads.maxBytes).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
      // The written file is the page's canonical file: the next delete's drift check matches it.
      resetWork();
      expect(await submit(engine, f, 'delete_page', 'notes/restore')).toMatchObject({ status: 'soft_deleted' });
      expectStreamed();
    } finally {
      spy.restore();
      await disposePersistenceConsumer(engine);
    }
  }
}), 900_000);

test('a file edited on disk still refuses soft delete, purge and restore as drift, as an inline page does', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await managedSource(engine);
    try {
      const small = 'notes/small';
      const smallFile = join(f.root, `${small}.md`);
      writeFileSync(smallFile, '---\ntitle: Small note\ntype: note\n---\n\nA short body.\n');
      expect(await importManagedFile(engine, smallFile, `${small}.md`, { sourceId: f.sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
      writeFileSync(smallFile, '---\ntitle: Small note\ntype: note\n---\n\nA short body, edited on disk.\n');
      const inline = await refusal(submit(engine, f, 'delete_page', small));
      expect(inline).toMatchObject({ code: 'source_changed', message: 'The canonical file contains an uncoordinated local edit.' });

      const slug = 'notes/huge';
      const file = await importHuge(engine, f, slug);
      const drifted = huge.replace('midpointmarker', 'midpointMARKER');
      expect(drifted).not.toBe(huge);
      writeFileSync(file, drifted);
      expect(await refusal(submit(engine, f, 'delete_page', slug))).toEqual(inline);
      expect(await refusal(submit(engine, f, 'delete_page', slug, { purge: true }))).toEqual(inline);
      expect((await pageState(engine, f, slug))?.deleted).toBe(false);
      expect(readFileSync(file, 'utf8') === drifted).toBe(true);

      writeFileSync(file, huge);
      expect(await submit(engine, f, 'delete_page', slug)).toMatchObject({ status: 'soft_deleted' });
      writeFileSync(file, drifted);
      expect(await refusal(submit(engine, f, 'restore_page', slug))).toEqual(inline);
      expect((await pageState(engine, f, slug))?.deleted).toBe(true);
      expect(readFileSync(file, 'utf8') === drifted).toBe(true);
    } finally {
      await disposePersistenceConsumer(engine);
    }
  }
}), 900_000);
