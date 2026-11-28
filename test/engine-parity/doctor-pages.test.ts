/**
 * BrainEngine parity: the doctor page reads of engine-sql/doctor-pages.ts, which doctor checks used to run through
 * `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts), so a doctor check reads the same finding on each.
 *  - Regression: an engine whose read drifts (or does not serve it) gives a different doctor status, message or health
 *    score per backend; a Rust brain refused every one of these reads with `raw_sql`, so the checks warned or skipped.
 *  - Why existing coverage misses it: the doctor check tests run these reads on PGLite only and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw) and the harness fixtures for sources. Page ids, timestamps and
 *    the order of an unordered read are never compared (rows are sorted, or reduced to what the check uses).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { bodyColumns, flipInput, segmentText, stageGeneration } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const page = (title: string, extra: Partial<PageInput> = {}): PageInput => ({ type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra });
const put = (engine: BrainEngine, slug: string, extra: Partial<PageInput> = {}, sourceId = 'default') =>
  engine.putPage(slug, page(slug, extra), { sourceId });
/** Writes land at distinct instants, so "newest update first" has one answer. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const bySlug = <T extends { slug: string; source_id?: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => `${a.source_id ?? ''}\0${a.slug}`.localeCompare(`${b.source_id ?? ''}\0${b.slug}`));

/** A page stored in segments (its body columns are NULL), published at generation 1. */
async function segmentedPage(engine: BrainEngine, slug: string, text: string, meta: { type: string; title: string; frontmatter?: Record<string, unknown> }): Promise<number> {
  const texts = [segmentText(text)];
  const { id: pageId } = await engine.createSegmentedPageShell(slug, meta as never, { sourceId: 'default' });
  const staged = await stageGeneration(engine, { pageId, slug, genFrom: 1, texts });
  await engine.transaction(async (tx) => {
    await tx.flipBodyGeneration(flipInput(pageId, 0, staged.stagingId, texts, { meta: meta as never, body: bodyColumns(texts) }));
    await tx.setBodyStagingState(staged.stagingId, 'committed');
  });
  return pageId;
}

describe('doctor page reads', () => {
  parityTest(
    'listOversizedPages lists live, unmarked pages over the block by byte size, counting bytes of multibyte text',
    { methods: ['putPage', 'softDeletePage', 'createSegmentedPageShell', 'listOversizedPages'] },
    async (engine) => {
      const empty = await engine.listOversizedPages(10);
      await put(engine, 'notes/small', { compiled_truth: 'tiny' });
      await put(engine, 'notes/big-ascii', { compiled_truth: 'a'.repeat(60), timeline: 't'.repeat(11) }); // 71 bytes
      await put(engine, 'notes/big-multibyte', { compiled_truth: 'é'.repeat(40) }); // 40 characters, 80 bytes
      await put(engine, 'notes/biggest', { compiled_truth: '😀'.repeat(25), timeline: '日本' }); // 100 + 6 bytes
      await put(engine, 'notes/skipped', { compiled_truth: 'x'.repeat(500), frontmatter: { embed_skip: null } });
      await put(engine, 'notes/deleted', { compiled_truth: 'x'.repeat(300) });
      await engine.softDeletePage('notes/deleted');
      await segmentedPage(engine, 'notes/segmented-big', 'z'.repeat(400), { type: 'note', title: 'Segmented' });
      const rows = await engine.listOversizedPages(60);
      expect(rows.map((r) => `${r.slug}:${r.bytes}`)).toEqual(['notes/biggest:106', 'notes/big-multibyte:80', 'notes/big-ascii:71']);
      expect(empty).toEqual([]);
      return { empty, rows };
    },
  );

  parityTest(
    'listScraperJunkCandidates reads the heads of live pages by characters, newest update first, and all pages when unlimited',
    { methods: ['putPage', 'softDeletePage', 'createSegmentedPageShell', 'listScraperJunkCandidates'] },
    async (engine) => {
      await put(engine, 'notes/one', { title: 'Première', compiled_truth: '😀'.repeat(2100), timeline: 'é'.repeat(1100), frontmatter: { zz: 1, a: { b: [1, 2] }, mid: 'x' } });
      await tick();
      await put(engine, 'notes/two', { compiled_truth: 'short body' });
      await tick();
      await put(engine, 'notes/gone', { compiled_truth: 'gone' });
      await engine.softDeletePage('notes/gone');
      await segmentedPage(engine, 'notes/segmented', 'segment text', { type: 'note', title: 'Segmented' });
      await tick();
      await put(engine, 'notes/three', { compiled_truth: 'third body', timeline: '- 2026-01-01 event' });
      const limited = await engine.listScraperJunkCandidates(3);
      const all = await engine.listScraperJunkCandidates(null);
      expect(limited.map((r) => r.slug)).toEqual(['notes/three', 'notes/segmented', 'notes/two']);
      const one = all.find((r) => r.slug === 'notes/one')!;
      expect([...(one.body_head ?? '')].length).toBe(2048);
      expect([...one.tl_head].length).toBe(1024);
      expect(all.find((r) => r.slug === 'notes/segmented')!.body_head).toBeNull();
      expect(all.find((r) => r.slug === 'notes/segmented')!.tl_head).toBe('');
      expect(all.map((r) => `${r.slug}:${r.segmented}`).sort()).toEqual(['notes/one:false', 'notes/segmented:true', 'notes/three:false', 'notes/two:false']);
      expect(all.length).toBe(4);
      return { limited, all: bySlug(all) };
    },
  );

  parityTest(
    'countMarkedPages counts live pages whose frontmatter has the key, even with a null value',
    { methods: ['putPage', 'softDeletePage', 'countMarkedPages'] },
    async (engine) => {
      const before = [await engine.countMarkedPages('quarantine'), await engine.countMarkedPages('content_flag')];
      await put(engine, 'notes/q1', { frontmatter: { quarantine: { reason: 'junk' } } });
      await put(engine, 'notes/q2', { frontmatter: { quarantine: null, content_flag: 'markup' } });
      await put(engine, 'notes/q3', { frontmatter: { quarantine: 'x' } });
      await engine.softDeletePage('notes/q3');
      await put(engine, 'notes/f1', { frontmatter: { content_flag: 'oversize' } });
      await put(engine, 'notes/plain', { frontmatter: { other: 1 } });
      const after = [await engine.countMarkedPages('quarantine'), await engine.countMarkedPages('content_flag')];
      expect({ before, after }).toEqual({ before: [0, 0], after: [2, 2] });
      return { before, after };
    },
  );

  parityTest(
    'countOversizedCorePages counts live always_load pages stored in segments over the byte limit',
    { methods: ['putPage', 'createSegmentedPageShell', 'countOversizedCorePages'] },
    async (engine) => {
      const empty = await engine.countOversizedCorePages(10);
      await segmentedPage(engine, 'core/big', 'c'.repeat(200), { type: 'note', title: 'Big core', frontmatter: { always_load: true } });
      await segmentedPage(engine, 'core/small', 'c'.repeat(5), { type: 'note', title: 'Small core', frontmatter: { always_load: true } });
      await segmentedPage(engine, 'core/not-core', 'c'.repeat(200), { type: 'note', title: 'Not core', frontmatter: { always_load: 'true' } });
      await put(engine, 'core/inline', { compiled_truth: 'i'.repeat(200), frontmatter: { always_load: true } });
      const counts = { limit10: await engine.countOversizedCorePages(10), limit100: await engine.countOversizedCorePages(100), limit500: await engine.countOversizedCorePages(500) };
      expect({ empty, ...counts }).toEqual({ empty: 0, limit10: 1, limit100: 1, limit500: 0 });
      return { empty, counts };
    },
  );

  parityTest(
    'readRawProvenanceGaps counts synthesized pages with no trace, raw data, evidence or exemption, and samples five slugs by slug',
    { methods: ['putPage', 'putRawData', 'addTakesBatch', 'addSynthesisEvidence', 'softDeletePage', 'readRawProvenanceGaps'] },
    async (engine) => {
      const empty = await engine.readRawProvenanceGaps();
      await put(engine, 'syn/gap-dream', { frontmatter: { dream_generated: true } });
      await put(engine, 'syn/gap-text', { frontmatter: { dream_generated: 'true' } });
      await put(engine, 'syn/gap-type', { type: 'synthesis' as never });
      await put(engine, 'syn/gap-atom-other', { type: 'atom' as never, frontmatter: { dream_generated: true, extracted_by: 'someone', source_slug: 'x' } });
      await put(engine, 'syn/gap-zz-1', { type: 'synthesis' as never });
      await put(engine, 'syn/gap-zz-2', { type: 'synthesis' as never });
      await put(engine, 'syn/ok-source', { frontmatter: { dream_generated: true, raw_source: 'notes.md' } });
      await put(engine, 'syn/ok-uri', { frontmatter: { dream_generated: true, source_uri: null } });
      await put(engine, 'syn/ok-exempt', { frontmatter: { dream_generated: true, raw_trace_exempt: true } });
      await put(engine, 'syn/ok-atom', { type: 'atom' as never, frontmatter: { dream_generated: true, extracted_by: 'extract_atoms_v2', source_path: 'a.md' } });
      await put(engine, 'syn/not-synth', { frontmatter: { dream_generated: false } });
      await put(engine, 'syn/ok-raw-data', { type: 'synthesis' as never });
      await engine.putRawData('syn/ok-raw-data', 'trace', { text: 'raw' });
      const evidence = await put(engine, 'syn/ok-evidence', { type: 'synthesis' as never });
      const taken = await put(engine, 'syn/take-holder');
      await engine.addTakesBatch([{ page_id: taken.id, row_num: 1, claim: 'a claim', kind: 'fact' as const, holder: 'self' }]);
      await engine.addSynthesisEvidence([{ synthesis_page_id: evidence.id, take_page_id: taken.id, take_row_num: 1, citation_index: 1 }]);
      await put(engine, 'syn/deleted-gap', { type: 'synthesis' as never });
      await engine.softDeletePage('syn/deleted-gap');
      const gaps = await engine.readRawProvenanceGaps();
      expect(gaps.count).toBe(6);
      expect(gaps.slugs).toEqual(['syn/gap-atom-other', 'syn/gap-dream', 'syn/gap-text', 'syn/gap-type', 'syn/gap-zz-1']);
      return { empty, gaps };
    },
  );

  parityTest(
    'countUnverifiedExtractions counts live unverified auto-extracted pages older than the window, within a source when given',
    { methods: ['putPage', 'softDeletePage', 'countUnverifiedExtractions'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other-src');
      const stub = { provenance: 'auto-extracted', status: 'unverified' };
      await put(engine, 'people/stub-a', { frontmatter: stub });
      await put(engine, 'people/stub-b', { frontmatter: stub }, 'other-src');
      await put(engine, 'people/verified', { frontmatter: { provenance: 'auto-extracted', status: 'verified' } });
      await put(engine, 'people/manual', { frontmatter: { provenance: 'manual', status: 'unverified' } });
      await put(engine, 'people/stub-gone', { frontmatter: stub });
      await engine.softDeletePage('people/stub-gone');
      const counts = {
        recent: await engine.countUnverifiedExtractions(7, null),
        everything: await engine.countUnverifiedExtractions(-1, null),
        inDefault: await engine.countUnverifiedExtractions(-1, 'default'),
        inOther: await engine.countUnverifiedExtractions(-1, 'other-src'),
        inNone: await engine.countUnverifiedExtractions(-1, 'no-such-source'),
      };
      expect(counts).toEqual({ recent: 0, everything: 2, inDefault: 1, inOther: 1, inNone: 0 });
      return counts;
    },
  );
  parityTest(
    'listContentHashDuplicates groups live pages by source and hash, slugs shortest first, and skips blank hashes',
    { methods: ['putPage', 'softDeletePage', 'listContentHashDuplicates'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other-src');
      const empty = await engine.listContentHashDuplicates();
      await put(engine, 'dup/zz', { content_hash: 'hash-a' });
      await put(engine, 'dup/a-long-name', { content_hash: 'hash-a' });
      await put(engine, 'dup/b', { content_hash: 'hash-a' });
      await put(engine, 'dup/other', { content_hash: 'hash-a' }, 'other-src');
      await put(engine, 'dup/other-two', { content_hash: 'hash-a' }, 'other-src');
      await put(engine, 'dup/solo', { content_hash: 'hash-solo' });
      await put(engine, 'dup/g1', { content_hash: 'hash-g' });
      await put(engine, 'dup/g2', { content_hash: 'hash-g' });
      await engine.softDeletePage('dup/g2');
      const rows = [...(await engine.listContentHashDuplicates())].sort((a, b) => a.source_id.localeCompare(b.source_id));
      expect(rows.map((r) => `${r.source_id}:${r.content_hash}:${r.slugs}`)).toEqual(['default:hash-a:dup/b|dup/zz|dup/a-long-name', 'other-src:hash-a:dup/other|dup/other-two']);
      return { empty, rows };
    },
  );

  parityTest(
    'countTranscriptImportPages counts live conversation pages marked transcript_import',
    { methods: ['putPage', 'softDeletePage', 'countTranscriptImportPages'] },
    async (engine) => {
      const empty = await engine.countTranscriptImportPages();
      await put(engine, 'conv/a', { type: 'conversation' as never, frontmatter: { transcript_import: true } });
      await put(engine, 'conv/b', { type: 'conversation' as never, frontmatter: { transcript_import: null } });
      await put(engine, 'conv/c', { type: 'conversation' as never });
      await put(engine, 'conv/d', { type: 'note' as never, frontmatter: { transcript_import: true } });
      await put(engine, 'conv/e', { type: 'conversation' as never, frontmatter: { transcript_import: true } });
      await engine.softDeletePage('conv/e');
      const n = await engine.countTranscriptImportPages();
      expect({ empty, n }).toEqual({ empty: 0, n: 2 });
      return { empty, n };
    },
  );

  parityTest(
    'countPageRows counts soft-deleted pages, countLivePages does not, and countPagesBySlugPrefix reads the prefix literally',
    { methods: ['putPage', 'softDeletePage', 'countPageRows', 'countLivePages', 'countPagesBySlugPrefix'] },
    async (engine) => {
      const empty = [await engine.countPageRows(), await engine.countLivePages(), await engine.countPagesBySlugPrefix('skills/')];
      await put(engine, 'skills/a');
      await put(engine, 'skills/b');
      await put(engine, 'skills_x/c');
      await put(engine, 'skillsXY/d');
      await put(engine, '100%/e');
      await put(engine, '100abc/f');
      await put(engine, 'notes/gone');
      await engine.softDeletePage('notes/gone');
      await engine.softDeletePage('skills/b');
      const counts = {
        rows: await engine.countPageRows(),
        live: await engine.countLivePages(),
        skills: await engine.countPagesBySlugPrefix('skills/'),
        underscore: await engine.countPagesBySlugPrefix('skills_'),
        percent: await engine.countPagesBySlugPrefix('100%'),
        backslash: await engine.countPagesBySlugPrefix('back\\'),
        none: await engine.countPagesBySlugPrefix('zzz'),
      };
      expect(counts).toEqual({ rows: 7, live: 5, skills: 2, underscore: 1, percent: 1, backslash: 0, none: 0 });
      return { empty, counts };
    },
  );

  parityTest(
    'readOldestPageCreatedAt is null on an empty brain and the earliest creation time, soft-deleted pages included',
    { methods: ['putPage', 'readOldestPageCreatedAt'] },
    async (engine) => {
      const empty = await engine.readOldestPageCreatedAt();
      await put(engine, 'notes/first');
      await tick();
      await put(engine, 'notes/second');
      const oldest = await engine.readOldestPageCreatedAt();
      expect(empty).toBeNull();
      expect(Number.isFinite(new Date(oldest as never).getTime())).toBe(true);
      expect(Math.abs(new Date(oldest as never).getTime() - Date.now())).toBeLessThan(120_000);
      return { empty, oldestIsTime: true };
    },
  );

  parityTest(
    'countPageTrustTiers counts pages per stored tier, soft-deleted pages included',
    { methods: ['putPage', 'softDeletePage', 'countPageTrustTiers'] },
    async (engine) => {
      const empty = await engine.countPageTrustTiers();
      // putPage does not take the tier from its input; every page starts at the column default.
      await put(engine, 'tier/a');
      await put(engine, 'tier/b');
      await put(engine, 'tier/c');
      await engine.softDeletePage('tier/b');
      const rows = [...(await engine.countPageTrustTiers())].sort((a, b) => String(a.tier).localeCompare(String(b.tier)));
      expect(rows.map((r) => `${r.tier}:${Number(r.n)}`)).toEqual(['unknown:3']);
      return { empty, rows: rows.map((r) => ({ tier: r.tier, n: Number(r.n) })) };
    },
  );

  parityTest(
    'countPagesWithMentionLinks counts live pages with at least one outgoing mentions link, once each',
    { methods: ['putPage', 'addLink', 'softDeletePage', 'countPagesWithMentionLinks'] },
    async (engine) => {
      const empty = await engine.countPagesWithMentionLinks();
      for (const slug of ['m/a', 'm/b', 'm/c', 'm/d', 'm/target-1', 'm/target-2']) await put(engine, slug);
      await engine.addLink('m/a', 'm/target-1', 'ctx', 'mentions', 'mentions');
      await engine.addLink('m/a', 'm/target-2', 'ctx', 'mentions', 'mentions');
      await engine.addLink('m/b', 'm/target-1', 'ctx', 'mentions', 'mentions');
      await engine.addLink('m/c', 'm/target-1', 'ctx', 'references', 'markdown');
      await engine.addLink('m/d', 'm/target-1', 'ctx', 'mentions', 'mentions');
      await engine.softDeletePage('m/d');
      const n = await engine.countPagesWithMentionLinks();
      expect({ empty, n }).toEqual({ empty: 0, n: 2 });
      return { empty, n };
    },
  );

  parityTest(
    'readImagePageCoverage counts live image pages and those with no source path; countImageModalityMismatches finds none',
    { methods: ['putPage', 'softDeletePage', 'readImagePageCoverage', 'countImageModalityMismatches'] },
    async (engine) => {
      const empty = await engine.readImagePageCoverage();
      await put(engine, 'img/a', { page_kind: 'image', source_path: 'a.png' });
      await put(engine, 'img/b', { page_kind: 'image' });
      await put(engine, 'img/c', { page_kind: 'image', source_path: 'c.png' });
      await engine.softDeletePage('img/c');
      await put(engine, 'img/text', { page_kind: 'markdown', source_path: 't.md' });
      const coverage = await engine.readImagePageCoverage();
      const mismatches = await engine.countImageModalityMismatches();
      expect({ empty, coverage, mismatches }).toEqual({
        empty: { image_pages: 0, without_image_vector: 0, null_source_path: 0 },
        coverage: { image_pages: 2, without_image_vector: 2, null_source_path: 1 },
        mismatches: 0,
      });
      return { empty, coverage, mismatches };
    },
  );

  parityTest(
    'listFactsPageBodies lists live facts pages by source and slug, with the body cut at 65536 characters',
    { methods: ['putPage', 'softDeletePage', 'createSegmentedPageShell', 'listFactsPageBodies'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other-src');
      const empty = await engine.listFactsPageBodies();
      await put(engine, 'facts/b', { type: 'facts' as never, compiled_truth: '- [preference] Tea\n' });
      await put(engine, 'facts/a', { type: 'facts' as never, compiled_truth: 'é'.repeat(65_540) });
      await put(engine, 'facts/z', { type: 'facts' as never, compiled_truth: 'other source' }, 'other-src');
      await put(engine, 'facts/gone', { type: 'facts' as never });
      await engine.softDeletePage('facts/gone');
      await put(engine, 'notes/not-facts');
      await segmentedPage(engine, 'facts/segmented', '- [preference] Coffee\n', { type: 'facts', title: 'Segmented facts' });
      const rows = await engine.listFactsPageBodies();
      expect(rows.map((r) => `${r.source_id}:${r.slug}:${r.segmented}`)).toEqual(['default:facts/a:false', 'default:facts/b:false', 'default:facts/segmented:true', 'other-src:facts/z:false']);
      expect([...(rows[0]!.body ?? '')].length).toBe(65_536);
      return { empty, rows };
    },
  );

  parityTest(
    'listBracketPathPages lists live pages whose source path holds a bracket or a control character',
    { methods: ['putPage', 'softDeletePage', 'listBracketPathPages'] },
    async (engine) => {
      const empty = await engine.listBracketPathPages();
      const paths: Record<string, string> = {
        'p/open': 'dir/[draft].md', 'p/close': 'dir/a].md', 'p/tab': 'dir/a\tb.md', 'p/newline': 'dir/a\nb.md', 'p/nul-ish': 'dir/a\u0001b.md',
        'p/del': 'dir/a\u007fb.md', 'p/c1': 'dir/a\u0085b.md', 'p/c1-end': 'dir/a\u009fb.md', 'p/ls': 'dir/a\u2028b.md', 'p/ps': 'dir/a\u2029b.md',
        'p/nbsp': 'dir/a\u00a0b.md', 'p/fffa': 'dir/a\ufffab.md', 'p/zwsp': 'dir/a\u200bb.md', 'p/space': 'dir/a b.md',
        'p/plain': 'dir/plain.md', 'p/unicode': 'dir/café-日本.md', 'p/gone': 'dir/[gone].md',
      };
      for (const [slug, source_path] of Object.entries(paths)) await put(engine, slug, { source_path });
      await put(engine, 'p/no-path');
      await engine.softDeletePage('p/gone');
      const rows = bySlug(await engine.listBracketPathPages());
      return { empty, rows };
    },
  );

  parityTest(
    'listSlugPathCandidates lists live pages with a source path and an unusual slug, in write order, skipping archived sources',
    { methods: ['putPage', 'softDeletePage', 'listSlugPathCandidates'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other-src');
      await createSource(engine, backend, 'attic-src');
      const empty = await engine.listSlugPathCandidates(null);
      const slugs = ['ok/clean-slug', 'bad/plus+sign', 'bad/under_score', 'bad/dbl--dash', 'bad/-lead', 'bad/trail-', 'bad/a-/b', 'bad//slash', 'bad/space here', 'bad/é', 'ok/dots.and-dash_x'];
      for (const slug of slugs) await put(engine, slug, { source_path: `${slug}.md` });
      await put(engine, 'bad/no-path');
      await put(engine, 'bad/blank-path', { source_path: '   ' });
      await put(engine, 'bad/other+x', { source_path: 'o.md' }, 'other-src');
      await put(engine, 'bad/attic+x', { source_path: 'a.md' }, 'attic-src');
      await put(engine, 'bad/gone+x', { source_path: 'g.md' });
      await engine.softDeletePage('bad/gone+x');
      await archiveSource(engine, backend, 'attic-src');
      const all = await engine.listSlugPathCandidates(null);
      const scoped = await engine.listSlugPathCandidates(['other-src']);
      const scopedTwo = await engine.listSlugPathCandidates(['default', 'attic-src']);
      const none = await engine.listSlugPathCandidates([]);
      expect(all.map((r) => r.slug)).toEqual(['bad/plus+sign', 'bad/dbl--dash', 'bad/-lead', 'bad/trail-', 'bad/a-/b', 'bad//slash', 'bad/space here', 'bad/é', 'bad/other+x']);
      expect(scoped.map((r) => r.slug)).toEqual(['bad/other+x']);
      expect(scopedTwo.length).toBe(8);
      expect(none).toEqual([]);
      return { empty, all, scoped, scopedTwo, none };
    },
  );

  parityTest(
    'probeSlugSources answers each candidate with the live holders among default and the probed source, a null row when neither holds it',
    { methods: ['putPage', 'softDeletePage', 'probeSlugSources'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other-src');
      await createSource(engine, backend, 'third-src');
      await put(engine, 'notes/at-default');
      await put(engine, 'notes/at-other', {}, 'other-src');
      await put(engine, 'notes/at-both');
      await put(engine, 'notes/at-both', {}, 'other-src');
      await put(engine, 'notes/gone');
      await engine.softDeletePage('notes/gone');
      await put(engine, 'notes/at-third', {}, 'third-src');
      const candidates = ['notes/at-other', 'notes/at-default', 'notes/missing', 'notes/at-both', 'notes/gone', 'notes/at-third', 'notes/at-default'];
      const other = await engine.probeSlugSources(candidates, 'other-src');
      const atDefault = await engine.probeSlugSources(candidates, 'default');
      const unknown = await engine.probeSlugSources(['notes/at-other', 'notes/at-default'], 'no-such-src');
      const empty = await engine.probeSlugSources([], 'other-src');
      expect(other).toEqual([
        { slug: 'notes/at-both', source_id: 'default' }, { slug: 'notes/at-both', source_id: 'other-src' },
        { slug: 'notes/at-default', source_id: 'default' }, { slug: 'notes/at-default', source_id: 'default' },
        { slug: 'notes/at-other', source_id: 'other-src' }, { slug: 'notes/at-third', source_id: null },
        { slug: 'notes/gone', source_id: null }, { slug: 'notes/missing', source_id: null },
      ]);
      expect(unknown).toEqual([{ slug: 'notes/at-default', source_id: 'default' }, { slug: 'notes/at-other', source_id: null }]);
      expect(empty).toEqual([]);
      return { other, atDefault, unknown, empty };
    },
  );
});
