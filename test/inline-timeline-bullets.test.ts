/**
 * Bullet-aligned timeline chunks for inline pages (INLINE_TIMELINE_CHUNKER_VERSION) and the preview-first
 * `gbrain reindex --timeline-bullets` that moves existing pages to it.
 *
 * 1. Protects: a new or edited inline body chunks its timeline at bullet starts and is stamped
 *    INLINE_TIMELINE_CHUNKER_VERSION, while a page sealed at MARKDOWN_CHUNKER_VERSION (the pre-bullet chunker) keeps
 *    its chunk rows and version through a schema replay, the post-upgrade re-embed step, `reindex --markdown`, the
 *    projection drain, a frontmatter-only edit and incremental and full syncs of unchanged files. The reindex
 *    previews without writing (in a read-only transaction: no page guard, lock or row) and its apply re-chunks to the new version without touching the unchanged truth rows;
 *    doctor counts the pages still old (informational) and names the preview.
 * 2. Fails when: inline timeline chunks start mid-entry, any upgrade or sync step re-chunks or restamps an old page
 *    (for example a MARKDOWN_CHUNKER_VERSION bump), the preview writes, or the apply leaves the page old.
 * 3. Runs on PGLite, and on an isolated Postgres database when DATABASE_URL is set. No provider is called.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';
import { chunkTimelineBullets } from '../src/core/chunkers/bullet-chunks.ts';
import { credentialSafeProjection } from '../src/core/credential-projection.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { INLINE_TIMELINE_CHUNKER_VERSION, prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';
import { installPageProjection, preparePageProjection, readProjectionSnapshot, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { runTimelineRechunk } from '../src/core/page-state/timeline-rechunk.ts';
import { inlineTimelineChunksEntry } from '../src/commands/doctor/checks/inline-timeline-chunks.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { computeReembedEstimate, runPostUpgradeReembedPrompt } from '../src/core/post-upgrade-reembed.ts';
import { runReindex } from '../src/commands/reindex.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { descendingTimeline } from './helpers/timeline-bullets.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-inline-timeline-'));
const engines = new Map<string, BrainEngine>();
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({});
  await lite.initSchema();
  engines.set('pglite', lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.set('postgres', pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  await engines.get('pglite')?.disconnect();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

const TRUTH = 'Acme-example builds developer tooling for small teams. It was founded by alice-example and sells through partners.';

function pageMarkdown(seed: number, opts: { title?: string; top?: boolean } = {}): string {
  const { bullets, top } = descendingTimeline(seed);
  return `---\ntitle: ${opts.title ?? 'Acme Example'}\ntype: company\n---\n\n${TRUTH}\n\n<!-- timeline -->\n\n${[...(opts.top ? [top] : []), ...bullets].join('\n')}\n`;
}

interface Row { id: number; chunk_index: number; chunk_source: string; chunk_text: string; projected_byte_start: number | null; projected_byte_end: number | null }

async function rows(engine: BrainEngine, slug: string, sourceId = 'default'): Promise<Row[]> {
  return (await engine.executeRaw<Row>(`SELECT c.id, c.chunk_index, c.chunk_source, c.chunk_text, c.projected_byte_start, c.projected_byte_end
    FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.source_id = $1 AND p.slug = $2 ORDER BY c.chunk_index`, [sourceId, slug]))
    .map(r => ({ ...r, id: Number(r.id), chunk_index: Number(r.chunk_index), projected_byte_start: r.projected_byte_start == null ? null : Number(r.projected_byte_start),
      projected_byte_end: r.projected_byte_end == null ? null : Number(r.projected_byte_end) }));
}

async function pageState(engine: BrainEngine, slug: string, sourceId = 'default') {
  const [row] = await engine.executeRaw<{ chunker_version: number; sealed: boolean; revision: string }>(`SELECT chunker_version,
    (text_projection_revision = knowledge_revision) IS TRUE AS sealed, knowledge_revision::text AS revision FROM pages WHERE source_id = $1 AND slug = $2`, [sourceId, slug]);
  return { chunker_version: Number(row!.chunker_version), sealed: row!.sealed, revision: row!.revision };
}

/** The state master left: the same body chunked by the pre-bullet inline chunker, sealed at MARKDOWN_CHUNKER_VERSION. */
async function sealAtPreBulletChunker(engine: BrainEngine, slug: string, sourceId = 'default'): Promise<void> {
  const read = await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true });
  const prepared = { ...read!, timelineBullets: false };
  const projection = await preparePageProjection(prepared);
  expect(projection.chunkerVersion).toBe(MARKDOWN_CHUNKER_VERSION);
  await installPageProjection(engine, prepared, projection.chunks, { seal: true });
}

const timelineOf = (rowsIn: Row[]) => rowsIn.filter(r => r.chunk_source === 'timeline');

for (const backend of process.env.DATABASE_URL ? ['pglite', 'postgres'] : ['pglite']) {
  describe(`inline timeline bullet chunks [${backend}]`, () => {
    const engine = () => engines.get(backend)!;

    test('a new inline page chunks its bulleted timeline at bullet starts and is stamped with the inline timeline version', async () => {
      const content = pageMarkdown(11);
      expect((await importFromContent(engine(), 'companies/acme-new', content, { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const timeline = timelineOf(await rows(engine(), 'companies/acme-new'));
      expect(timeline.length).toBeGreaterThan(2);
      for (const chunk of timeline) expect(chunk.chunk_text).toMatch(/^- \*\*\d{4}-\d{2}-\d{2}\*\* \| source-a/);
      const parsed = parseMarkdown(content, 'companies/acme-new.md');
      expect(timeline.map(c => c.chunk_text)).toEqual(chunkTimelineBullets(credentialSafeProjection(sanitizeRemoteBody(parsed.timeline)))!.map(c => c.text));
      expect(await pageState(engine(), 'companies/acme-new')).toMatchObject({ chunker_version: INLINE_TIMELINE_CHUNKER_VERSION, sealed: true });
    }, 60_000);

    test('a page without a bulleted timeline chunks and stamps exactly as the pre-bullet chunker', async () => {
      const content = `---\ntitle: Plain\ntype: note\n---\n\n${TRUTH}\n\n<!-- timeline -->\n\n${'Met the team and reviewed the roadmap. '.repeat(120)}\n`;
      await importFromContent(engine(), 'notes/plain', content, { sourceId: 'default', noEmbed: true });
      const parsed = parseMarkdown(content, 'notes/plain.md');
      expect((await rows(engine(), 'notes/plain')).map(r => r.chunk_text)).toEqual((await prepareMarkdownChunks(parsed)).map(c => c.chunk_text));
      expect((await pageState(engine(), 'notes/plain')).chunker_version).toBe(MARKDOWN_CHUNKER_VERSION);
    }, 60_000);

    test('a page sealed at the pre-bullet chunker keeps its chunks on a frontmatter-only edit; a body edit re-chunks it at bullets', async () => {
      const slug = 'companies/acme-edit';
      await importFromContent(engine(), slug, pageMarkdown(12), { sourceId: 'default', noEmbed: true });
      await sealAtPreBulletChunker(engine(), slug);
      const before = await rows(engine(), slug);
      expect(timelineOf(before).some(c => !c.chunk_text.startsWith('- '))).toBe(true);

      expect((await importFromContent(engine(), slug, pageMarkdown(12, { title: 'Acme Example Inc' }), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      expect((await rows(engine(), slug)).map(r => r.chunk_text)).toEqual(before.map(r => r.chunk_text));
      expect((await pageState(engine(), slug)).chunker_version).toBe(MARKDOWN_CHUNKER_VERSION);

      await importFromContent(engine(), slug, pageMarkdown(12, { title: 'Acme Example Inc', top: true }), { sourceId: 'default', noEmbed: true });
      for (const chunk of timelineOf(await rows(engine(), slug))) expect(chunk.chunk_text.startsWith('- ')).toBe(true);
      expect((await pageState(engine(), slug)).chunker_version).toBe(INLINE_TIMELINE_CHUNKER_VERSION);
    }, 60_000);

    test('upgrade and sync leave pages sealed at the pre-bullet chunker untouched', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
      const root = mkdtempSync(join(home, `repo-${backend}-`));
      mkdirSync(join(root, 'companies'), { recursive: true });
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
      git('init', '-q');
      for (const [i, name] of ['acme-a', 'acme-b'].entries()) writeFileSync(join(root, 'companies', `${name}.md`), pageMarkdown(20 + i));
      git('add', '-A');
      git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'pages');
      const sourceId = `upgrade${backend}`;
      await engine().executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
      expect((await performSync(engine(), { repoPath: root, sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 })).status).toBe('first_sync');
      const slugs = ['companies/acme-a', 'companies/acme-b'];
      for (const slug of slugs) await sealAtPreBulletChunker(engine(), slug, sourceId);
      const snapshot = async () => Promise.all(slugs.map(async slug => ({ rows: await rows(engine(), slug, sourceId), page: await pageState(engine(), slug, sourceId) })));
      const before = await snapshot();
      for (const page of before) expect(page.page).toMatchObject({ chunker_version: MARKDOWN_CHUNKER_VERSION, sealed: true });

      await engine().initSchema();
      expect((await computeReembedEstimate(engine(), 'openai:text-embedding-3-large')).pendingCount).toBe(0);
      const prompt = await runPostUpgradeReembedPrompt(engine(), 'openai:text-embedding-3-large', { isTTY: true, confirm: async () => true, write: () => {}, env: {} });
      expect(prompt).toMatchObject({ proceeded: false, reason: 'no_pending' });
      expect(await runReindex(engine(), ['--markdown', '--no-embed'], { authorized: true })).toMatchObject({ reindexed: 0, pending: 0 });
      await rebuildPendingPageProjections(engine(), 100);
      expect((await performSync(engine(), { repoPath: root, sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 })).status).toBe('up_to_date');
      await performSync(engine(), { repoPath: root, sourceId, noPull: true, noEmbed: true, noExtract: true, full: true, concurrency: 1 });

      expect(await snapshot()).toEqual(before);
    }), 120_000);

    test('a preview reports a page that changes or is purged while it is read as moved, and writes nothing', async () => {
      const changes: Array<[string, (e: BrainEngine, slug: string) => Promise<unknown>]> = [
        ['companies/acme-preview-edit', (e, slug) => importFromContent(e, slug, pageMarkdown(41), { sourceId: 'default', noEmbed: true })],
        ['companies/acme-preview-purge', (e, slug) => e.executeRaw('DELETE FROM pages WHERE source_id=$1 AND slug=$2', ['default', slug])],
      ];
      for (const [slug, change] of changes) {
        await importFromContent(engine(), slug, pageMarkdown(40), { sourceId: 'default', noEmbed: true });
        await sealAtPreBulletChunker(engine(), slug);
        const real = engine();
        let fired = false;
        // The change lands between the preview's page read and its page_kind read (statements of no one snapshot).
        const racing = new Proxy(real, { get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key !== 'executeRaw') return typeof value === 'function' ? value.bind(target) : value;
          return async (sql: string, params?: unknown[]) => {
            if (!fired && sql === 'SELECT page_kind FROM pages WHERE id=$1') { fired = true; await change(real, slug); }
            return target.executeRaw(sql, params);
          };
        } }) as BrainEngine;
        const preview = await runTimelineRechunk(racing, { slug });
        expect(fired).toBe(true);
        expect(preview.pages).toEqual([{ source_id: 'default', slug, chunker_version: expect.any(Number), chunks: 0, chunks_after: 0, new_chunk_texts: 0, new_chunk_chars: 0, state: 'moved' }]);
        // The edit is the only write: it chunks the page at bullets as any new write does; the preview stamps nothing.
        if (slug.endsWith('edit')) expect((await pageState(engine(), slug)).chunker_version).toBe(INLINE_TIMELINE_CHUNKER_VERSION);
        else expect(await rows(engine(), slug)).toEqual([]);
      }
    }, 120_000);

    test('reindex --timeline-bullets previews without writing; its apply re-chunks to the inline timeline version', async () => {
      const slug = 'companies/acme-reindex';
      const content = pageMarkdown(30);
      await importFromContent(engine(), slug, content, { sourceId: 'default', noEmbed: true });
      const bulletRows = await rows(engine(), slug);
      await sealAtPreBulletChunker(engine(), slug);
      const before = await rows(engine(), slug);
      const state = await pageState(engine(), slug);
      expect(state.chunker_version).toBe(MARKDOWN_CHUNKER_VERSION);

      // In a read-only transaction: the preview takes no page guard, lock or write.
      const preview = await engine().transaction(async tx => { await tx.executeRaw('SET TRANSACTION READ ONLY'); return runTimelineRechunk(tx, { slug }); });
      expect(preview).toMatchObject({ dry_run: true, chunker_version: INLINE_TIMELINE_CHUNKER_VERSION, pending: 1,
        commands: { apply: ['gbrain', 'reindex', '--timeline-bullets', '--slug', slug, '--apply'], embed: null } });
      expect(preview.pages).toEqual([{ source_id: 'default', slug, chunker_version: MARKDOWN_CHUNKER_VERSION, chunks: before.length,
        chunks_after: bulletRows.length, new_chunk_texts: expect.any(Number), new_chunk_chars: expect.any(Number) }]);
      expect(preview.pages[0]!.new_chunk_texts).toBeGreaterThan(0);
      expect(await rows(engine(), slug)).toEqual(before);
      expect(await pageState(engine(), slug)).toEqual(state);
      expect((await runTimelineRechunk(engine(), { slug: 'notes/plain' })).pending).toBe(0);
      const doctor = async () => (await inlineTimelineChunksEntry.run({ engine: engine(), sourceIds: ['default'] } as unknown as DoctorContext) as Check[])[0]!;
      const pendingCheck = await doctor();
      expect(pendingCheck).toMatchObject({ name: 'inline_timeline_chunks', status: 'ok', details: { pages_pending: 1 } });
      expect(pendingCheck.fix?.argv).toEqual(['gbrain', 'reindex', '--timeline-bullets', '--source', 'default', '--json']);
      expect(await rows(engine(), slug)).toEqual(before);

      const applied = await runTimelineRechunk(engine(), { slug, apply: true });
      expect(applied.pages[0]!.state).toBe('rechunked');
      expect(applied.commands.apply).toBeNull();
      const after = await rows(engine(), slug);
      expect(after.map(r => [r.chunk_source, r.chunk_text, r.projected_byte_start, r.projected_byte_end]))
        .toEqual(bulletRows.map(r => [r.chunk_source, r.chunk_text, r.projected_byte_start, r.projected_byte_end]));
      const truth = (list: Row[]) => list.filter(r => r.chunk_source === 'compiled_truth').map(r => r.id);
      expect(truth(after)).toEqual(truth(before));
      expect(await pageState(engine(), slug)).toEqual({ ...state, chunker_version: INLINE_TIMELINE_CHUNKER_VERSION });
      expect((await runTimelineRechunk(engine(), { slug })).pending).toBe(0);
      expect(await doctor()).toMatchObject({ status: 'ok', details: { pages_pending: 0 } });
    }, 60_000);
  });
}
