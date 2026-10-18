/**
 * Wave B managed import of a Markdown file over the single-string ceiling
 * (decision 4, lane 1d).
 *
 * 1. Protects: on a managed brain with `pages.segmented_storage` on, a file
 *    over PAGE_MAX_BYTES inside the canonical root imports through its owner
 *    with an intent that holds a `body_ref` (sha256, bytes) and no content; the
 *    page round-trips byte-identical from its manifest, `content_hash` equals
 *    `contentHash`, and the canonical file is left untouched. A file within
 *    the ceiling stages its segments in the owner's preparation (the writer
 *    guard admits it) and publishes segmented. Segment GC on a managed brain
 *    collects an abandoned preparation's staged rows under the guard. A file that
 *    changes between admission and preparation publishes nothing; a request_id
 *    replayed with other bytes is `idempotency_conflict`; with the switch off
 *    the refusal is the one before Wave B. With the switch on a file-backed
 *    source takes a page over 24 MiB only by import of its own canonical
 *    file, never by a managed write of new content.
 * 2. Fails when: the journal carries the body, the preparer skips the hash
 *    check, the publication rewrites the canonical file, or the switch-off
 *    refusal changes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { prepareManagedImportMutation, type ManagedImportIntent } from '../../src/core/persistence/import-prepare.ts';
import { claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite, sweepSegmentStorage } from '../../src/core/persistence/journal.ts';
import { preparePageAdmission } from '../../src/core/persistence/page-mutations.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { reconstructedPage } from '../helpers/segmented-page-checks.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-streamed-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const content = conversationPage(PAGE_MAX_BYTES + 2 * 1024 * 1024, { seed: 51 });

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

async function fixture(engine: BrainEngine) {
  const sourceId = `streamed-${randomUUID().slice(0, 8)}`;
  const root = join(home, sourceId);
  mkdirSync(join(root, 'notes'), { recursive: true });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { sourceId, root };
}

/** A body_ref intent for `file`, admitted and claimed (the owner's next request). */
async function admitted(engine: BrainEngine, sourceId: string, file: string, sourcePath: string, bytes: Buffer, base?: { pageId: number; revision: string }) {
  const binding = (await getWorktreeBinding(engine, sourceId))!;
  const slug = sourcePath.replace(/\.md$/, '');
  const ctx = { engine, remote: false, sourceId } as OperationContext;
  const authority = await submissionAuthority(ctx, 'put_page', sourceId, binding.source_incarnation, slug);
  const hash = sha256(bytes);
  const intent: ManagedImportIntent = { kind: 'managed_file_import', slug, sourcePath, path: sourcePath, inputPath: file, inputHash: hash, targetHash: hash,
    body_ref: { kind: 'input_file', input_path: file, sha256: hash, bytes: bytes.length }, ownerEpoch: String(binding.owner_epoch), noEmbed: true,
    ...(base ? { expected_revision: base.revision } : {}) };
  await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId, sourceIncarnation: binding.source_incarnation,
    slug, pageId: base?.pageId ?? null, requestId: randomUUID(), callerIntent: intent, intent, authority, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  return (await claimNextWrite(engine, localHostId()))!;
}

describe('managed import over the single-string ceiling', () => {
  test('switch on: imports by reference, round-trips byte-identical, leaves the canonical file and keeps the intent small', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine);
      await engine.setConfig('pages.segmented_storage', 'on');
      const f = await fixture(engine);
      const file = join(f.root, 'notes/huge.md');
      writeFileSync(file, content);
      const before = statSync(file);
      const result = await importManagedFile(engine, file, 'notes/huge.md', { sourceId: f.sourceId, noEmbed: true });
      expect(result).toMatchObject({ slug: 'notes/huge', status: 'imported' });
      const parsed = parseMarkdown(content, 'notes/huge.md');
      const { page, body, hash } = await reconstructedPage(engine, 'notes/huge', f.sourceId);
      expect(page.body_storage).toBe('segmented');
      expect(body.compiled_truth).toBe(parsed.compiled_truth);
      expect(body.timeline).toBe(parsed.timeline);
      expect(page.content_hash).toBe(hash);
      expect(page.text_projection_revision).toBe(page.knowledge_revision);
      const after = statSync(file);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(sha256(readFileSync(file))).toBe(sha256(Buffer.from(content)));
      const [request] = await engine.executeRaw<{ intent_bytes: string; intent: Record<string, unknown>; state: string }>(
        `SELECT intent_bytes::text AS intent_bytes, intent, state FROM persistence_requests WHERE source_id=$1 AND slug=$2`, [f.sourceId, 'notes/huge']);
      expect(request!.state).toBe('committed');
      expect(Number(request!.intent_bytes)).toBeLessThan(16 * 1024);
      expect(request!.intent.content).toBeUndefined();
      expect(request!.intent.body_ref).toMatchObject({ kind: 'input_file', sha256: sha256(Buffer.from(content)), bytes: Buffer.byteLength(content) });

      const again = await importManagedFile(engine, file, 'notes/huge.md', { sourceId: f.sourceId, noEmbed: true });
      expect(again.status).toBe('skipped');
      expect((await reconstructedPage(engine, 'notes/huge', f.sourceId)).page.body_generation).toBe(page.body_generation);

      // An owner preparation that never publishes leaves staged rows; segment GC collects them under the writer guard.
      await disposePersistenceConsumer(engine);
      const appended = Buffer.from(`${content}\nA closing note.\n`);
      writeFileSync(file, appended);
      const snapshot = (await engine.readPageSnapshot('notes/huge', { sourceId: f.sourceId }))!;
      await prepareManagedImportMutation(engine, await admitted(engine, f.sourceId, file, 'notes/huge.md', appended,
        { pageId: Number(snapshot.page.id), revision: snapshot.revision }), { engine: engine.kind });
      const staged = async () => Number((await engine.executeRaw<{ n: string }>(
        'SELECT count(*)::text AS n FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NOT NULL', [page.id]))[0]!.n);
      expect(await staged()).toBeGreaterThan(0);
      await engine.executeRaw(`UPDATE page_body_stagings SET state='aborted' WHERE page_id=$1 AND state IN ('open','prepared')`, [page.id]);
      await sweepSegmentStorage(engine);
      expect(await staged()).toBe(0);
    }
  }), 600_000);

  test('a file within the ceiling stages segments in the owner\'s preparation and publishes segmented', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine);
      await engine.setConfig('pages.segmented_storage', 'on');
      const f = await fixture(engine);
      const file = join(f.root, 'notes/mid.md');
      const mid = conversationPage(3 * 1024 * 1024, { seed: 52 });
      writeFileSync(file, mid);
      expect(await importManagedFile(engine, file, 'notes/mid.md', { sourceId: f.sourceId, noEmbed: true })).toMatchObject({ slug: 'notes/mid', status: 'imported' });
      const parsed = parseMarkdown(mid, 'notes/mid.md');
      const { page, body, hash } = await reconstructedPage(engine, 'notes/mid', f.sourceId);
      expect(page.body_storage).toBe('segmented');
      expect(body.compiled_truth).toBe(parsed.compiled_truth);
      expect(page.content_hash).toBe(hash);
    }
  }), 600_000);

  test('a file changed between admission and preparation is refused', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine);
      await engine.setConfig('pages.segmented_storage', 'on');
      const f = await fixture(engine);
      const file = join(f.root, 'notes/edited.md');
      const bytes = Buffer.from(content);
      writeFileSync(file, bytes);
      const row = await admitted(engine, f.sourceId, file, 'notes/edited.md', bytes);
      const edited = Buffer.from(bytes);
      edited.write('Edited', bytes.length - 64, 'utf8');
      writeFileSync(file, edited);
      await expect(prepareManagedImportMutation(engine, row, { engine: engine.kind })).rejects.toMatchObject({ code: 'source_changed' });
      expect(await engine.getPage('notes/edited', { sourceId: f.sourceId })).toBeNull();
    }
  }), 600_000);

  test('a request_id replayed with other bytes is idempotency_conflict', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine);
      await engine.setConfig('pages.segmented_storage', 'on');
      const f = await fixture(engine);
      const binding = (await getWorktreeBinding(engine, f.sourceId))!;
      const file = join(f.root, 'notes/replay.md');
      const ctx = { engine, remote: false, sourceId: f.sourceId } as OperationContext;
      const requestId = randomUUID();
      const params = (hash: string) => ({ kind: 'managed_file_import', slug: 'notes/replay', sourcePath: 'notes/replay.md', path: 'notes/replay.md', inputPath: file,
        inputHash: hash, targetHash: hash, body_ref: { kind: 'input_file', input_path: file, sha256: hash, bytes: 1 }, ownerEpoch: String(binding.owner_epoch),
        noEmbed: true, source_id: f.sourceId, request_id: requestId });
      const first = await preparePageAdmission(ctx, { operation: 'put_page', params: params('a'.repeat(64)), managedFileImport: true });
      await admitWrite(engine, first.admission!);
      await expect(preparePageAdmission(ctx, { operation: 'put_page', params: params('b'.repeat(64)), managedFileImport: true }))
        .rejects.toMatchObject({ code: 'idempotency_conflict' });
      expect((await preparePageAdmission(ctx, { operation: 'put_page', params: params('a'.repeat(64)), managedFileImport: true })).prior?.request_id).toBe(requestId);
    }
  }), 120_000);

  test('switch on: a file over 24 MiB imports only from its place in the canonical root; put_page content stays within 24 MiB', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine);
      await engine.setConfig('pages.segmented_storage', 'on');
      const f = await fixture(engine);
      const outside = join(home, `${f.sourceId}-outside.md`);
      writeFileSync(outside, content);
      await expect(importManagedFile(engine, outside, 'notes/outside.md', { sourceId: f.sourceId, noEmbed: true }))
        .rejects.toMatchObject({ code: 'invalid_params', message: `File too large (${Buffer.byteLength(content)} bytes, max ${PAGE_MAX_BYTES}): a file over the single-string import limit `
          + `imports only from its place inside the source root. Move it to ${join(f.root, 'notes/outside.md')} and import it there.` });
      expect(await engine.getPage('notes/outside', { sourceId: f.sourceId })).toBeNull();

      const file = join(f.root, 'notes/inside.md');
      writeFileSync(file, content);
      const before = statSync(file);
      expect(await importManagedFile(engine, file, 'notes/inside.md', { sourceId: f.sourceId, noEmbed: true })).toMatchObject({ slug: 'notes/inside', status: 'imported' });
      expect((await reconstructedPage(engine, 'notes/inside', f.sourceId)).page.body_storage).toBe('segmented');
      expect(statSync(file).mtimeMs).toBe(before.mtimeMs);

      const ctx = { engine, remote: false, sourceId: f.sourceId } as OperationContext;
      await expect(preparePageAdmission(ctx, { operation: 'put_page', params: { slug: 'notes/put-huge', content, source_id: f.sourceId, request_id: randomUUID() } }))
        .rejects.toMatchObject({ code: 'request_too_large' });
      expect(await engine.getPage('notes/put-huge', { sourceId: f.sourceId })).toBeNull();
    }
  }), 600_000);

  test('switch off: the refusal is the one before segmented storage', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine);
      await engine.setConfig('pages.segmented_storage', 'off');
      const f = await fixture(engine);
      const file = join(f.root, 'notes/off.md');
      writeFileSync(file, content);
      await expect(importManagedFile(engine, file, 'notes/off.md', { sourceId: f.sourceId, noEmbed: true }))
        .rejects.toMatchObject({ code: 'invalid_params', message: `File too large (max ${PAGE_MAX_BYTES} bytes).` });
      expect(await engine.getPage('notes/off', { sourceId: f.sourceId })).toBeNull();
    }
  }), 120_000);
});
