/**
 * B-14 (#6948 on the large-file path): managed sync of a Markdown file over the single-string ceiling whose origin is
 * recorded by a page at another slug.
 *
 * 1. Protects: the streamed import targets the admitted page, the one that records the file as its origin (a page
 *    renamed with \`updateSlug\` keeps its old origin, B-1's fourth writer), as the inline import does; the publication
 *    records the origin through \`bindOrigin\`, so a live page at the path's own slug never becomes a second claimant,
 *    and the rest of the source syncs. Several live pages recording the file stay one \`origin_conflict\` hold of that
 *    file alone while the rest syncs (B-1's twins), with neither page written.
 * 2. Fails when: the streamed writer refuses the file \`revision_conflict\` ("A different page already owns this file
 *    identity") and the run stops at it (\`blocked_by_failures\`, the other file not imported), imports it into the
 *    path's slug beside the page recording it (a twin), or writes into a twin.
 *
 * PGLite and, with DATABASE_URL, Postgres. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { dropOriginIndex } from '../helpers/origin-index.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { reconstructedPage } from '../helpers/segmented-page-checks.ts';

const huge = conversationPage(PAGE_MAX_BYTES + 1024 * 1024, { seed: 83 });
const edited = `${huge.trimEnd()}\n\n**alice-example**: a closing streamed remark.\n`;
const small = (body: string) => `---\ntitle: Small\n---\n${body}\n`;

function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(root: string): void { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'synthetic content'); }

for (const backend of testBackends()) describe(`[${backend}] B-14 streamed sync of a file another page records`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-b14-${backend}-`));
  const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
  const write = (sourceId: string, fn: (tx: BrainEngine) => Promise<unknown>) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => fn(tx), TEST_WRITE_ATTRIBUTION));
  const claimants = async (sourceId: string, origin: string) => (await engine.executeRaw<{ slug: string }>(
    'SELECT slug FROM pages WHERE source_id=$1 AND source_path=$2 AND deleted_at IS NULL ORDER BY slug', [sourceId, origin])).map(row => row.slug);
  const row = async (sourceId: string, slug: string) => (await engine.executeRaw<{ compiled_truth: string; source_path: string | null; body_generation: string | null; revision: string }>(
    'SELECT compiled_truth, source_path, body_generation::text AS body_generation, knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0] ?? null;
  const holds = async (sourceId: string) => (await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? [];

  /** A managed Git source holding notes/huge.md (over the ceiling) and notes/small.md, synced once with the switch on. */
  async function source() {
    await disposePersistenceConsumer(engine);
    const sourceId = `b14-${randomUUID().slice(0, 8)}`, root = join(home, sourceId);
    mkdirSync(join(root, 'notes'), { recursive: true });
    git(root, 'init', '-q');
    writeFileSync(join(root, 'notes/huge.md'), huge);
    writeFileSync(join(root, 'notes/small.md'), small('A small note.'));
    commit(root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect(await sync(sourceId)).toMatchObject({ status: 'first_sync', filesImported: 2 });
    expect((await reconstructedPage(engine, 'notes/huge', sourceId)).page.body_storage).toBe('segmented');
    return { sourceId, root };
  }
  /** One managed sync to a settled result: a streamed page outlasts a pass's bounded wait, as the drain's next pass picks it up. */
  async function sync(sourceId: string) {
    for (let pass = 0; ; pass++) {
      const result = await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true });
      if (result.status !== 'partial' || result.reason !== 'writer_pending' || pass === 30) return result;
    }
  }
  function editBoth(root: string) {
    writeFileSync(join(root, 'notes/huge.md'), edited);
    writeFileSync(join(root, 'notes/small.md'), small('A small note, edited.'));
    commit(root);
  }

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
    await engine.setConfig('pages.segmented_storage', 'on');
    // Twins exist only on brains written before pages_live_origin_key, whose index is pending.
    await dropOriginIndex(engine);
  }, 120_000);
  afterAll(async () => {
    await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); await closePostgres?.(); });
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('a renamed page keeping its origin and a live page at the path\'s slug: the file streams into the page recording it, no twin, the rest syncs', async () => withEnv(env, async () => {
    const f = await source();
    await write(f.sourceId, tx => tx.updateSlug('notes/huge', 'archive/huge', { sourceId: f.sourceId }));
    await write(f.sourceId, tx => tx.putPage('notes/huge', { type: 'note', title: 'At the path', compiled_truth: 'A page at the path, recording no file.', timeline: '', frontmatter: {},
      content_hash: randomUUID() }, { sourceId: f.sourceId }));
    expect(await claimants(f.sourceId, 'notes/huge.md')).toEqual(['archive/huge']);
    editBoth(f.root);
    const result = await sync(f.sourceId);
    expect(result.failures ?? []).toEqual([]);
    expect(result.status).toBe('synced');
    expect((await row(f.sourceId, 'notes/small'))!.compiled_truth).toContain('A small note, edited.');
    const parsed = parseMarkdown(edited, 'notes/huge.md');
    const { page, body, hash } = await reconstructedPage(engine, 'archive/huge', f.sourceId);
    expect(page.body_storage).toBe('segmented');
    expect(body.compiled_truth).toBe(parsed.compiled_truth);
    expect(page.content_hash).toBe(hash);
    expect(await claimants(f.sourceId, 'notes/huge.md')).toEqual(['archive/huge']);
    expect(await row(f.sourceId, 'notes/huge')).toMatchObject({ source_path: null, compiled_truth: 'A page at the path, recording no file.' });
    expect(await holds(f.sourceId)).toEqual([]);
    expect((await sync(f.sourceId)).status).not.toBe('blocked_by_failures');
  }), 300_000);

  test('regression: two live pages recording the file hold it origin_conflict alone, neither is written, and the rest syncs', async () => withEnv(env, async () => {
    const f = await source();
    await write(f.sourceId, async tx => {
      await tx.putPage('notes/huge-copy', { type: 'note', title: 'Copy', compiled_truth: 'A copy.', timeline: '', frontmatter: {}, content_hash: randomUUID() }, { sourceId: f.sourceId });
      // Legacy data: no writer records a held origin on a second page, so the twin's origin is set directly.
      await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [f.sourceId, 'notes/huge-copy', 'notes/huge.md']);
    });
    const before = { huge: await row(f.sourceId, 'notes/huge'), copy: await row(f.sourceId, 'notes/huge-copy') };
    editBoth(f.root);
    const result = await sync(f.sourceId);
    expect(result.status).toBe('synced');
    expect((await row(f.sourceId, 'notes/small'))!.compiled_truth).toContain('A small note, edited.');
    const held = (await holds(f.sourceId)).filter(h => h.code === 'origin_conflict');
    expect(held.map(h => [h.path, h.meta.canonical_slug])).toEqual([['notes/huge.md', 'notes/huge']]);
    expect(await row(f.sourceId, 'notes/huge')).toEqual(before.huge);
    expect(await row(f.sourceId, 'notes/huge-copy')).toEqual(before.copy);
    expect(await claimants(f.sourceId, 'notes/huge.md')).toEqual(['notes/huge', 'notes/huge-copy']);
  }), 300_000);
});
