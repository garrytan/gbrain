/**
 * Wave B segmented writes under crashes, expiry and concurrent writers, on PGLite.
 *
 * 1. Protects: a flip whose staging expired (and was swept) refuses with
 *    `body_staging_expired` and leaves the published body as it was; a replace
 *    of a page whose post-create projection never ran chunks every live
 *    occurrence before it seals; a preparation that died before its flip does
 *    not block the next write of the page or duplicate its chunk reads; a
 *    finished preparation restarts its staging's idle deadline; a projection that prepared at a
 *    generation a flip has since moved past stages no chunk rows.
 * 2. Fails when: the flip publishes without its staged manifest rows, the flip
 *    deletes chunk rows its own preparation staged, staged manifest rows of an
 *    abandoned staging collide with the retry's, or a stale projection inserts
 *    rows of an occurrence the newer generation retired.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { stageOccurrenceChunks } from '../../src/core/page-body/ingest.ts';
import { stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { reconstructedPage, segmentedPageRow } from '../helpers/segmented-page-checks.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
  await engine.setConfig('pages.segmented_storage', 'on');
});

/** ~1.4 MB of sections, each its own segment. */
function sections(tag: string, n = 60): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`## Section ${tag}${i}\n\n` + `Paragraph ${i} of ${tag} about widgets and gadgets number ${i}. `.repeat(400) + '\n\n');
  return parts.join('');
}
const page = (body: string) => `---\ntitle: Races\ntype: note\n---\n\n${body}`;

async function stageReplace(slug: string, content: string) {
  const existing = await engine.getPage(slug, { sourceId: 'default' });
  const parsed = parseMarkdown(content, `${slug}.md`);
  const staged = await stageSegmentedImport(engine, { slug, sourceId: 'default', existing,
    page: { title: parsed.title, type: parsed.type, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter, tags: parsed.tags },
    policy: await readPageBodyPolicy(engine), chunking: { quarantined: false, corpusGeneration: null, tier: 'none' }, baseRevision: null });
  return { staged, parsed };
}

/** Live manifest occurrences of the page that have no chunk row the page's generation can see. */
async function liveOccurrencesWithoutChunks(pageId: number): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_body_manifest m JOIN pages p ON p.id=m.page_id
    WHERE m.page_id=$1 AND m.staging_id IS NULL AND m.gen_from<=p.body_generation AND (m.gen_to IS NULL OR m.gen_to>p.body_generation)
      AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=m.page_id AND c.occurrence_id=m.occurrence_id AND c.body_generation<=p.body_generation)`, [pageId]);
  return Number(row!.n);
}

describe('segmented writes: crash, expiry, concurrency', () => {
  test('a flip whose staging expired and was swept refuses, and the published body is unchanged', async () => {
    const slug = 'notes/expired-staging';
    await importFromContent(engine, slug, page(sections('a')), { sourceId: 'default', noEmbed: true });
    const before = await reconstructedPage(engine, slug);
    const { staged, parsed } = await stageReplace(slug, page('## Intro\n\nA new first paragraph.\n\n' + sections('a')));
    await engine.sweepSegments({ expireStagings: true, now: new Date(Date.now() + 2 * 3_600_000) });
    const err = await engine.transaction(tx => staged.apply(tx, { type: parsed.type, title: parsed.title, frontmatter: parsed.frontmatter, page_kind: 'markdown' },
      { mode: 'none', corpusGeneration: null })).then(() => null, (e: unknown) => e);
    expect((err as { code?: string } | null)?.code).toBe('body_staging_expired');
    const after = await reconstructedPage(engine, slug);
    expect(after.page.body_generation).toBe(before.page.body_generation);
    expect(after.body).toEqual(before.body);
    expect(after.page.content_hash).toBe(after.hash);
  }, 120_000);

  test('a replace of a page whose post-create projection never ran chunks every live occurrence before it seals', async () => {
    const slug = 'notes/unprojected-create';
    await importFromContent(engine, slug, page(sections('a')), { sourceId: 'default', noEmbed: true });
    const { id } = await segmentedPageRow(engine, slug);
    await engine.executeRaw('DELETE FROM content_chunks WHERE page_id=$1', [id]);
    await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [id]);
    const result = await importFromContent(engine, slug, page(sections('a') + '## Tail\n\nAppended tail paragraph.\n'), { sourceId: 'default', noEmbed: true });
    expect(result.status).toBe('imported');
    const row = await segmentedPageRow(engine, slug);
    expect(row.body_generation).toBe(2);
    expect(await liveOccurrencesWithoutChunks(id)).toBe(0);
  }, 120_000);

  test('a preparation that died before its flip does not block the next write of the page', async () => {
    const slug = 'notes/abandoned-staging';
    await importFromContent(engine, slug, page(sections('a')), { sourceId: 'default', noEmbed: true });
    const next = page('## Intro\n\nA new first paragraph.\n\n' + sections('a'));
    await stageReplace(slug, next);
    const result = await importFromContent(engine, slug, next, { sourceId: 'default', noEmbed: true });
    expect(result.status).toBe('imported');
    const after = await reconstructedPage(engine, slug);
    expect(after.page.body_generation).toBe(2);
    expect(after.body.compiled_truth).toBe(parseMarkdown(next, `${slug}.md`).compiled_truth);
    const chunks = await engine.getChunks(slug, { sourceId: 'default' });
    expect(chunks.length).toBeGreaterThan(0);
    expect(new Set(chunks.map(chunk => chunk.id)).size).toBe(chunks.length);
  }, 120_000);

  test('a finished preparation marks its staging prepared and restarts its idle deadline', async () => {
    const slug = 'notes/prepared-staging';
    await importFromContent(engine, slug, page(sections('a')), { sourceId: 'default', noEmbed: true });
    const { staged } = await stageReplace(slug, page('## Intro\n\nA new first paragraph.\n\n' + sections('a')));
    await engine.executeRaw(`UPDATE page_body_stagings SET idle_expires_at = now() - interval '1 minute' WHERE id=$1`, [staged.prepared.stagingId]);
    await engine.setBodyStagingState(staged.prepared.stagingId, 'prepared');
    const [row] = await engine.executeRaw<{ state: string; fresh: boolean }>(`SELECT state, idle_expires_at > now() + interval '50 minutes' AS fresh
      FROM page_body_stagings WHERE id=$1`, [staged.prepared.stagingId]);
    expect(row).toEqual({ state: 'prepared', fresh: true });
  }, 120_000);

  test('a projection that prepared at a generation a flip moved past stages no rows', async () => {
    const slug = 'notes/stale-projection';
    await importFromContent(engine, slug, page(sections('a')), { sourceId: 'default', noEmbed: true });
    const { id } = await segmentedPageRow(engine, slug);
    const genOne = await engine.readManifest(id);
    await importFromContent(engine, slug, page(sections('b')), { sourceId: 'default', noEmbed: true });
    expect((await segmentedPageRow(engine, slug)).body_generation).toBe(2);
    const staged = await stageOccurrenceChunks(engine, { pageId: id, sourceId: 'default', slug, generation: 1, occurrences: genOne.slice(0, 3),
      title: 'Races', frontmatter: {}, flags: {}, chunking: { quarantined: false, corpusGeneration: null, tier: 'none' }, retiredOccurrences: [], guarded: true });
    expect(staged.rows).toBe(0);
    const [stale] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[])',
      [id, genOne.slice(0, 3).map(row => row.occurrenceId)]);
    expect(Number(stale!.n)).toBe(0);
  }, 120_000);
});
