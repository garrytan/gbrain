/**
 * pages-03: the one-time re-read after the upgrade keeps the paid scan state of a page whose frontmatter `title:` the
 * older parser typed (`title: 1.10` stored as the title '1.1').
 *
 * 1. Protects: the title is lifted out of the frontmatter into the page's title, which the content hash covers. When an
 *    older gbrain stored `title: 1.10` as '1.1' and the file did not change, the re-read stores the title as written
 *    ('1.10') and carries extract_atoms' scan state to the new hash, so the page is not scanned again: whether the title
 *    is the only value the old typing changed or other values changed too, on the inline import and on the streamed
 *    import of a page over the single-string ceiling. A file whose title really changed is scanned again.
 * 2. Fails when: the legacy hash check rebuilds the old hash from the old typing of the frontmatter only (the title it
 *    hashes is today's), or skips the check when the stored frontmatter holds no old-typed value.
 * 3. Runs on PGLite (the managed-brain fixture, and a bare engine for the streamed page). No network, no model calls:
 *    the embedding provider is a stub.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { legacyTypedFrontmatter } from '../src/core/frontmatter-legacy.ts';
import { contentHash } from '../src/core/utils.ts';
import { discoverExtractablePages } from '../src/core/cycle/extract-atoms.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { ContentHashStream } from '../src/core/page-body/content-hash-stream.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { withEnv } from './helpers/with-env.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { conversationPage } from './helpers/conversation-page.ts';
import { ownerImportFile } from './helpers/owner-import.ts';

const DIMS = 1536, MODEL = 'openai:text-embedding-3-small';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
/** HEAD's tree as a new root commit, so the next sync walks the whole tree (as the first sync of a new binary does). */
function rewriteHistory(root: string): void {
  const rewritten = git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit-tree', 'HEAD^{tree}', '-m', `rewritten ${randomUUID().slice(0, 8)}`);
  git(root, 'reset', '-q', '--soft', rewritten); git(root, 'reflog', 'expire', '--expire=now', '--all'); git(root, 'gc', '-q', '--prune=now');
}
const vector = (text: string) => { const d = createHash('sha256').update(text).digest(); return Float32Array.from({ length: DIMS }, (_, i) => (d[i % 32]! - 128) / 128); };
const withStubEmbeddings = (run: () => Promise<void>) => withEnv({ GBRAIN_EMBEDDING_MODEL: MODEL, GBRAIN_EMBEDDING_DIMENSIONS: String(DIMS), OPENAI_API_KEY: 'sk-test-reread-title' }, async () => {
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test-reread-title' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(v => Array.from(vector(v))) })) as never);
  try { await run(); } finally { __setEmbedTransportForTests(null); resetGateway(); }
});
async function drainEffects(engine: BrainEngine): Promise<void> {
  await disposePersistenceConsumer(engine);
  for (let i = 0; i < 20; i++) if (!await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 50 })) break;
}
const revisionOf = async (engine: BrainEngine, slug: string, sourceId = 'default') => (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!.revision;
type Row = { id: number; title: string; type: string; compiled_truth: string; timeline: string | null; frontmatter: Record<string, unknown>; content_hash: string };
const pageRow = async (engine: BrainEngine, slug: string, sourceId = 'default') => (await engine.executeRaw<Row>(
  'SELECT id, title, type, compiled_truth, timeline, frontmatter, content_hash FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!;
/** A finished atom scan at `hash`, and no other scan state for the page (what an older gbrain left). */
async function scannedAt(engine: BrainEngine, id: number, hash: string, sourceId = 'default'): Promise<void> {
  await engine.executeRaw('DELETE FROM extract_atoms_page_state WHERE page_id=$1', [id]);
  await engine.executeRaw(`INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned)
    SELECT incarnation, $1, $2, 0, true FROM sources WHERE id=$3`, [id, hash, sourceId]);
}
const scanStateAt = (engine: BrainEngine, id: number, hash: string) => engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM extract_atoms_page_state WHERE page_id=$1 AND content_hash=$2', [id, hash]);

describe('pages-03: the upgrade re-read of a page whose title the old typing changed', () => {
  // (a) the title is the only value the old typing changed; (b) the title and other values; (c) the file's title changed.
  const PAGES = { titleOnly: 'notes/title-only', titleAndValues: 'notes/title-and-values', retitled: 'notes/retitled' };
  const SLUGS = Object.values(PAGES);
  const file = (slug: string, title = '1.10') => slug === PAGES.titleAndValues
    ? `---\ntype: meeting\ntitle: ${title}\ndate: 2024-03-01\nroom: 0101\n---\n\n${`The committed notes of ${slug}, about acme-example and widget-co. `.repeat(12)}\n`
    : `---\ntype: meeting\ntitle: ${title}\n---\n\n${`The committed notes of ${slug}, about acme-example and widget-co. `.repeat(12)}\n`;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), file(slug));
    commit(root, 'notes');
  };
  const hashOf = (row: Row, title: string, frontmatter: Record<string, unknown>) =>
    contentHash({ title, type: row.type as never, compiled_truth: row.compiled_truth, timeline: row.timeline ?? '', frontmatter, tags: [] });

  test('an unchanged file keeps its scan state and stores the title as written; a real title edit is scanned again', () => managedBrain(async ({ engine, root }) => {
    await withStubEmbeddings(async () => {
      const opts = { sourceId: 'default', noPull: true };
      expect((await performManagedSync(engine, opts)).status).toBe('first_sync');
      await drainEffects(engine);
      // What an older gbrain left: the title '1.1' (and the old typing of every other value), the hash it computed over
      // those, a finished atom scan at that hash, and its parser named in every record.
      const oldHash = new Map<string, string>();
      await withManagedFixtureWrite(engine, ['default'], async tx => {
        for (const slug of SLUGS) {
          const row = await pageRow(tx, slug);
          expect(row.title).toBe('1.10');
          expect(hashOf(row, row.title, row.frontmatter)).toBe(row.content_hash); // the stored hash is the formula over the stored values
          const legacy = { ...row.frontmatter, ...legacyTypedFrontmatter(file(slug)) };
          delete legacy.title; delete legacy.type; // lifted into the page's columns, never stored in its frontmatter
          oldHash.set(slug, hashOf(row, '1.1', legacy));
          await tx.executeRaw('UPDATE pages SET title=$1, frontmatter=$2::text::jsonb, content_hash=$3 WHERE slug=$4', ['1.1', JSON.stringify(legacy), oldHash.get(slug), slug]);
        }
      });
      expect((await pageRow(engine, PAGES.titleOnly)).frontmatter).toEqual({}); // the title was the only affected value
      expect((await pageRow(engine, PAGES.titleAndValues)).frontmatter).toMatchObject({ date: '2024-03-01T00:00:00.000Z', room: 101 });
      for (const slug of SLUGS) {
        const { id } = await pageRow(engine, slug);
        await scannedAt(engine, id, oldHash.get(slug)!);
        await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,revision}',to_jsonb($2::text)) WHERE op=$1 AND fingerprint LIKE '%:' || $3`,
          [SYNC_IMPORT_PROVENANCE_OP, await revisionOf(engine, slug), String(id)]);
      }
      await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,parser,parser_version}','"an-older-parser"'::jsonb) WHERE op=$1`, [SYNC_IMPORT_PROVENANCE_OP]);
      await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,converged,parser_fp}','\"an-older-parser\"'::jsonb) WHERE op='managed-sync-pass'");
      expect(await discoverExtractablePages(engine, 'default', SLUGS)).toEqual([]);

      // One file's title really changed before the new binary's first sync, which walks the whole tree.
      writeFileSync(join(root, `${PAGES.retitled}.md`), file(PAGES.retitled, '1.20'));
      commit(root, 'retitle');
      rewriteHistory(root);
      expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'synced', modified: SLUGS.length });

      const titleOnly = await pageRow(engine, PAGES.titleOnly), titleAndValues = await pageRow(engine, PAGES.titleAndValues), retitled = await pageRow(engine, PAGES.retitled);
      expect(titleOnly.title).toBe('1.10');
      expect(titleAndValues.title).toBe('1.10');
      expect(titleAndValues.frontmatter).toMatchObject({ date: '2024-03-01', room: '0101' });
      expect(retitled.title).toBe('1.20');
      for (const row of [titleOnly, titleAndValues]) {
        expect(row.content_hash).toBe(hashOf(row, '1.10', row.frontmatter));
        expect(await scanStateAt(engine, row.id, row.content_hash)).toEqual([{ n: 1 }]);
      }
      // extract_atoms discovery: only the page whose title the file changed is scanned again.
      expect((await discoverExtractablePages(engine, 'default', SLUGS)).map(page => page.slug)).toEqual([PAGES.retitled]);
      expect(await scanStateAt(engine, retitled.id, retitled.content_hash)).toEqual([{ n: 0 }]);
    });
  }, { setup }), 240_000);
});

describe('pages-03: the streamed re-read of a page over the ceiling whose title the old typing changed', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-reread-title-'));
  const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
  let engine: BrainEngine;
  beforeAll(async () => withEnv(env, async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }), 120_000);
  afterAll(async () => {
    await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
    rmSync(home, { recursive: true, force: true });
  });
  const coordinated = <T>(sourceId: string, fn: (tx: BrainEngine) => Promise<T>) =>
    engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => fn(tx), TEST_WRITE_ATTRIBUTION));
  async function managedSource(): Promise<{ sourceId: string; root: string }> {
    await disposePersistenceConsumer(engine);
    await engine.setConfig('pages.segmented_storage', 'on');
    const root = join(home, `src-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(root, 'notes'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceId = `title-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
    await registerLocalWriter(engine, 'cli');
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    return { sourceId, root };
  }
  // One body over the single-string ceiling; each case differs only in its frontmatter head.
  const body = conversationPage(PAGE_MAX_BYTES + 256 * 1024, { seed: 41, title: 'TITLE' }).replace('title: TITLE\n', '');
  const page = (head: string) => body.replace('---\n', `---\n${head}`);

  /**
   * An older gbrain's state for a file whose head is `writtenHead`: imported with `storedHead` (the title as it typed
   * it, quoted, so every manifest row's hash state is over that title), the old typing of the other values stored, and
   * a finished atom scan at the hash over both. Then the file holds `fileHead` and the new binary imports it.
   */
  async function rereadAfterUpgrade(slug: string, storedHead: string, writtenHead: string, fileHead = writtenHead) {
    const { sourceId, root } = await managedSource();
    const file = join(root, `${slug}.md`);
    writeFileSync(file, page(storedHead));
    await disposePersistenceConsumer(engine);
    await ownerImportFile(engine, sourceId, file, `${slug}.md`);
    const first = await pageRow(engine, slug, sourceId);
    expect(first.title).toBe('1.1');
    const legacy = { ...first.frontmatter, ...legacyTypedFrontmatter(page(writtenHead)) };
    delete legacy.title; delete legacy.type;
    let storedHash = first.content_hash;
    if (JSON.stringify(legacy) !== JSON.stringify(first.frontmatter)) {
      // The rows' hash states hold title and body; the old typing of the frontmatter goes into the page hash only.
      const rows = await engine.readManifest(first.id);
      storedHash = ContentHashStream.fromState(rows[rows.length - 1]!.hashState).finish({ frontmatter: legacy as never, tags: [] });
    }
    await coordinated(sourceId, async tx => {
      await tx.executeRaw('UPDATE pages SET frontmatter=$1::text::jsonb, content_hash=$2 WHERE id=$3', [JSON.stringify(legacy), storedHash, first.id]);
    });
    await scannedAt(engine, first.id, storedHash, sourceId);
    writeFileSync(file, page(fileHead));
    await disposePersistenceConsumer(engine);
    await ownerImportFile(engine, sourceId, file, `${slug}.md`, { pageId: first.id, revision: await revisionOf(engine, slug, sourceId) });
    const reread = await pageRow(engine, slug, sourceId);
    // extract_atoms discovery reads compiled_truth, which a segmented page does not hold, so the scan state itself is read.
    return { first, storedHash, reread, scanState: await scanStateAt(engine, first.id, reread.content_hash) };
  }

  test('(a) the title is the only affected value: the scan state is kept and the title stored as written', async () => withEnv(env, async () => {
    const { storedHash, reread, scanState } = await rereadAfterUpgrade('notes/title-only', 'title: "1.1"\n', 'title: 1.10\n');
    expect(reread.title).toBe('1.10');
    expect(reread.content_hash).not.toBe(storedHash);
    expect(scanState).toEqual([{ n: 1 }]);
  }), 900_000);

  test('(b) the title and another value: the scan state is kept and both stored as written', async () => withEnv(env, async () => {
    const { storedHash, reread, scanState } = await rereadAfterUpgrade('notes/title-and-values', 'title: "1.1"\nzip: "02134"\n', 'title: 1.10\nzip: 02134\n');
    expect(reread.title).toBe('1.10');
    expect(reread.frontmatter).toMatchObject({ zip: '02134' });
    expect(reread.content_hash).not.toBe(storedHash);
    expect(scanState).toEqual([{ n: 1 }]);
  }), 900_000);

  test('(c) a title the file changed is scanned again', async () => withEnv(env, async () => {
    const { reread, scanState } = await rereadAfterUpgrade('notes/retitled', 'title: "1.1"\n', 'title: 1.10\n', 'title: 1.20\n');
    expect(reread.title).toBe('1.20');
    expect(scanState).toEqual([{ n: 0 }]);
  }), 900_000);
});
