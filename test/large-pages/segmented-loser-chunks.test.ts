/**
 * Two preparations of one segmented page that both target generation G+1 (Wave B PR 2, lane A).
 *
 * 1. Protects: when preparation A flips to G+1 while preparation B is still staging, B's next chunk batch (whose
 *    occurrences only B's unpublished staging owns) refuses with revision_changed instead of landing at the page's
 *    live generation, so B's unpublished text never becomes searchable on the sealed page; and segment GC deletes
 *    chunk rows of occurrences that only a dead staging owned when an older binary left them at the live
 *    generation.
 * 2. Fails when: stageSegmentChunks accepts a batch at the live generation without checking that its occurrences
 *    are in the published manifest of that generation, or the sweep deletes only chunk rows above the live
 *    generation.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. The race is forced with the
 *    segmented:manifest_staged fault point: B pauses after staging its manifest rows, A imports and seals,
 *    then B resumes and stages its chunks. Search plans are untouched (chunkVisibleFilter keeps its row
 *    predicate; test/e2e/vector-chunk-statistics-postgres.test.ts holds the vector plan).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { abortSegmentedStaging, stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { manifestRow, segmentText, stagingInput } from '../helpers/page-body-fixtures.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';

function sections(tag: string, n = 60): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`## Section ${tag}${i}\n\n` + `Paragraph ${i} of ${tag} about widgets and gadgets number ${i}. `.repeat(400) + '\n\n');
  return parts.join('');
}
const page = (body: string) => `---\ntitle: Two preparers\ntype: note\n---\n\n${body}`;
const LOSER = '## Loser\n\n' + 'UNPUBLISHED quixotic staged text that only the losing preparation wrote. '.repeat(200) + '\n\n';
const WINNER = '## Winner\n\n' + 'Published zebracrossing section that the winning preparation wrote. '.repeat(200) + '\n\n';

for (const kind of testBackends()) {
  describe(`two preparations of one generation (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => { await engine.setConfig('pages.segmented_storage', 'on'); });
    afterEach(() => { installFaultHook(undefined); });

    const quixoticRows = async (pageId: number) => Number((await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1 AND strpos(chunk_text, 'quixotic') > 0", [pageId]))[0]!.n);
    const found = async (word: string, slug: string) => (await engine.searchKeyword(word, { limit: 20 })).filter(r => r.slug === slug).length;

    test('the losing preparation cannot stage chunks at the generation the winner published', async () => {
      const slug = `notes/two-preparers-${randomUUID().slice(0, 8)}`;
      await importFromContent(engine, slug, page(sections('a')), { sourceId: 'default', noEmbed: true });
      const { id } = await segmentedPageRow(engine, slug);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let paused!: () => void;
      const pausedAt = new Promise<void>(resolve => { paused = resolve; });
      let armed = true;
      installFaultHook(async point => {
        if (!armed || point !== 'segmented:manifest_staged') return;
        armed = false;
        paused();
        await gate;
      });
      const loserContent = page(LOSER + sections('a'));
      const parsed = parseMarkdown(loserContent, `${slug}.md`);
      const loser = stageSegmentedImport(engine, { slug, sourceId: 'default', existing: await engine.getPage(slug, { sourceId: 'default' }),
        page: { title: parsed.title, type: parsed.type, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter, tags: parsed.tags },
        policy: await readPageBodyPolicy(engine), chunking: { quarantined: false, corpusGeneration: null, tier: 'none' }, baseRevision: null })
        .then(staged => ({ staged, error: null }), (error: unknown) => ({ staged: null, error: error as { canonical?: string } }));
      await pausedAt;
      expect(await importFromContent(engine, slug, page(WINNER + sections('a')), { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
      expect((await segmentedPageRow(engine, slug)).body_generation).toBe(2);
      release();
      const outcome = await loser;
      if (outcome.staged) {
        const applied = await engine.transaction(tx => outcome.staged!.apply(tx, { type: parsed.type, title: parsed.title, frontmatter: parsed.frontmatter, page_kind: 'markdown' },
          { mode: 'none', corpusGeneration: null })).then(() => null, (error: unknown) => error as { canonical?: string });
        expect(applied?.canonical).toBe('revision_changed');
        await abortSegmentedStaging(engine, outcome.staged.prepared);
      }
      await engine.sweepSegments({ pageId: id });
      await engine.sweepSegments({ sourceId: 'default', expireStagings: true });
      const row = await segmentedPageRow(engine, slug);
      expect(row.text_projection_revision).toBe(row.knowledge_revision);
      expect(await found('zebracrossing', slug)).toBeGreaterThan(0);
      expect(await found('quixotic', slug)).toBe(0);
      expect(await quixoticRows(id)).toBe(0);
      expect(outcome.error?.canonical).toBe('revision_changed');
    }, 240_000);

    test('segment GC deletes live-generation chunk rows of an occurrence only a dead staging owned', async () => {
      const slug = `notes/orphaned-chunks-${randomUUID().slice(0, 8)}`;
      await importFromContent(engine, slug, page(sections('b')), { sourceId: 'default', noEmbed: true });
      const { id, body_generation: generation } = await segmentedPageRow(engine, slug);
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
      const staging = stagingInput({ slug, pageId: id, mode: 'replace', kind: 'import', sourceIncarnation: source!.incarnation, baseGeneration: generation });
      const text = segmentText('UNPUBLISHED quixotic orphan text a pre-fix preparation left behind.\n');
      const [occurrence] = await engine.allocateBodyOccurrenceIds(1);
      await engine.openBodyStaging(staging);
      await engine.stageSegmentTexts('default', [text]);
      await engine.stageManifestRows([manifestRow({ pageId: id, occurrenceId: occurrence!, genFrom: generation + 1, seq: 0, text, byteStart: 0, stagingId: staging.id })]);
      // What a losing preparation's late batch left on an older binary: a row at the live generation, owned only by its staging.
      await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, occurrence_id, local_ordinal,
          raw_byte_start, raw_byte_end, body_generation)
        SELECT $1, COALESCE(MAX(chunk_index), -1) + 1, $2, 'compiled_truth', 'unconfigured', $3, 0, 0, 10, $4 FROM content_chunks WHERE page_id = $1`,
      [id, new TextDecoder().decode(text.body), occurrence, generation]);
      await engine.setBodyStagingState(staging.id, 'aborted');
      expect(await found('quixotic', slug)).toBe(1);
      const rows = async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1', [id]))[0]!.n);
      const before = await rows();
      await engine.sweepSegments({ sourceId: 'default' });
      expect(await quixoticRows(id)).toBe(0);
      expect(await found('quixotic', slug)).toBe(0);
      expect(await rows()).toBe(before - 1);
    }, 120_000);
  });
}
