/**
 * BrainEngine parity: the doctor-derived reads of engine-sql/doctor-derived.ts, which doctor checks, the repair scans and
 * the purge used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts), so a doctor check reads the same finding on each. A member Rust does
 *    not serve ends on the typed refusal (counted as refused by the harness, never as a pass of the read itself).
 *  - Regression: an engine whose read drifts (or silently answers empty where the SQL engines answer rows) gives a
 *    different doctor status, message or health score per backend.
 *  - Why existing coverage misses it: the doctor check tests run these reads on PGLite only and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw); rows are seeded through typed writers.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { pageMeta, sha256 } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const SRC = ['default'];

async function put(engine: BrainEngine, slug: string, extra: Record<string, unknown> = {}): Promise<number> {
  const page = await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '', ...extra } as never);
  return page.id;
}

describe('doctor-derived reads', () => {
  parityTest(
    'readIgnoredPrivacyLabelCounts groups ignored access labels of live pages by key and value',
    { methods: ['putPage', 'deletePage', 'readIgnoredPrivacyLabelCounts'] },
    async (engine) => {
      const empty = await engine.readIgnoredPrivacyLabelCounts({ timeoutMs: 5000 });
      // `private`, `restricted` and `confidential` are recognized labels, so the filter honors them: not ignored.
      await put(engine, 'notes/secret-a', { frontmatter: { access: 'secret' } });
      await put(engine, 'notes/secret-b', { frontmatter: { access: 'secret', confidentiality: 'internal' } });
      await put(engine, 'notes/internal', { frontmatter: { access: 'Internal Use', confidentiality: 'confidential' } });
      await put(engine, 'notes/recognized', { frontmatter: { access: 'private' } });
      await put(engine, 'notes/typed', { frontmatter: { access: 'secret', visibility: 'private' } });
      await put(engine, 'notes/blank', { frontmatter: { access: '  ' } });
      await put(engine, 'notes/number', { frontmatter: { access: 7 } });
      await put(engine, 'notes/gone', { frontmatter: { access: 'secret' } });
      await engine.deletePage('notes/gone');
      await engine.putPage('atoms/skipped', { type: 'atom', title: 'a', compiled_truth: 'a', timeline: '', frontmatter: { access: 'secret' } } as never);
      await put(engine, 'notes/plain');
      const all = await engine.readIgnoredPrivacyLabelCounts({ timeoutMs: 5000 });
      const scoped = await engine.readIgnoredPrivacyLabelCounts({ sourceIds: SRC, timeoutMs: 5000 });
      const other = await engine.readIgnoredPrivacyLabelCounts({ sourceIds: ['nowhere'], timeoutMs: 5000 });
      expect(empty).toEqual([]);
      expect(other).toEqual([]);
      expect(all.length).toBeGreaterThan(0);
      expect(scoped).toEqual(all);
      return { empty, all, scoped, other };
    },
  );

  parityTest(
    'countSafeIndexPending counts live pages chunked below the fence in unarchived sources',
    { methods: ['putPage', 'deletePage', 'countSafeIndexPending'] },
    async (engine) => {
      const empty = await engine.countSafeIndexPending();
      await put(engine, 'notes/old-a', { chunker_version: 1 });
      await put(engine, 'notes/old-b', { chunker_version: 3 });
      await put(engine, 'notes/new', { chunker_version: 4 });
      await put(engine, 'notes/gone', { chunker_version: 1 });
      await engine.deletePage('notes/gone');
      const all = await engine.countSafeIndexPending();
      const scoped = await engine.countSafeIndexPending(SRC);
      const other = await engine.countSafeIndexPending(['nowhere']);
      return { empty, all, scoped, other };
    },
  );

  parityTest(
    'countCredentialProjectionPending counts pages whose body holds a private key block and whose projection is behind',
    { methods: ['putPage', 'deletePage', 'countCredentialProjectionPending'] },
    async (engine) => {
      const empty = await engine.countCredentialProjectionPending();
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
      await put(engine, 'notes/key', { compiled_truth: pem });
      await put(engine, 'notes/timeline-key', { timeline: `- **2026-01-02** | ${pem}` });
      await put(engine, 'notes/public-key', { compiled_truth: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----' });
      await put(engine, 'notes/gone', { compiled_truth: pem });
      await engine.deletePage('notes/gone');
      await put(engine, 'notes/plain');
      const all = await engine.countCredentialProjectionPending();
      const scoped = await engine.countCredentialProjectionPending(SRC);
      const other = await engine.countCredentialProjectionPending(['nowhere']);
      expect(Number(all.rebuildable) + Number(all.kept)).toBeGreaterThan(0);
      return { empty, all, scoped, other };
    },
  );

  parityTest(
    'countPagesByTypeAndOwner splits live pages by source, type and writer ownership',
    { methods: ['putPage', 'deletePage', 'countPagesByTypeAndOwner'] },
    async (engine) => {
      const empty = await engine.countPagesByTypeAndOwner();
      await put(engine, 'notes/a');
      await put(engine, 'notes/b');
      await engine.putPage('people/c', { type: 'person', title: 'c', compiled_truth: 'c', timeline: '' } as never);
      await engine.putPage('extracts/r1', { type: 'extract_receipt', title: 'r', compiled_truth: 'r', timeline: '', frontmatter: { dream_generated: 'true' } } as never);
      await engine.putPage('extracts/r2', { type: 'extract_receipt', title: 'r', compiled_truth: 'r', timeline: '' } as never);
      await put(engine, 'notes/gone');
      await engine.deletePage('notes/gone');
      // The statement orders by source only, so the order inside a source is the engine's: compare the rows as a set.
      const ordered = async (ids?: string[]) => (await engine.countPagesByTypeAndOwner(ids)).sort((a, b) => `${a.src}|${a.type}|${a.own}`.localeCompare(`${b.src}|${b.type}|${b.own}`));
      const all = await ordered();
      const scoped = await ordered(SRC);
      const other = await ordered(['nowhere']);
      return { empty, all, scoped, other };
    },
  );

  parityTest(
    'listImageAssetFiles lists image file rows in id order with their source root and page source path',
    { methods: ['putPage', 'upsertFile', 'listImageAssetFiles'] },
    async (engine) => {
      const empty = await engine.listImageAssetFiles();
      const id = await put(engine, 'notes/photo', { source_path: 'notes/photo.md' });
      await engine.upsertFile({ page_slug: 'notes/photo', page_id: id, filename: 'a.png', storage_path: 'assets/a.png', content_hash: 'h-a', mime_type: 'image/png', size_bytes: 3, metadata: { alt: 'a' } });
      await engine.upsertFile({ page_slug: 'notes/photo', page_id: id, filename: 'b.txt', storage_path: 'assets/b.txt', content_hash: 'h-b', mime_type: 'text/plain', size_bytes: 3 });
      await engine.upsertFile({ page_slug: 'notes/photo', page_id: id, filename: 'c.jpg', storage_path: 'assets/c.jpg', content_hash: 'h-c', mime_type: 'image/jpeg', size_bytes: 4 });
      const rows = await engine.listImageAssetFiles();
      return { empty, paths: rows.map((r) => r.storage_path), pageSource: rows.map((r) => r.page_source_path), meta: rows.map((r) => r.metadata) };
    },
  );

  parityTest(
    'listUntiledSegmentedPageRows finds no page while no page is segmented or every segmented body tiles',
    { methods: ['putPage', 'createSegmentedPageShell', 'listUntiledSegmentedPageRows'] },
    async (engine) => {
      const empty = await engine.listUntiledSegmentedPageRows(null, null, 10);
      await put(engine, 'notes/inline');
      // A shell publishes generation 1 with no rows and no bytes, which tiles.
      await engine.createSegmentedPageShell('notes/shell', pageMeta('Shell'), { sourceId: 'default' });
      const rows = await engine.listUntiledSegmentedPageRows(SRC, ['notes/inline', 'notes/shell'], 10);
      const all = await engine.listUntiledSegmentedPageRows(null, null, 10);
      return { empty, rows, all };
    },
  );

  parityTest(
    'listTimelineHistoryBatch pages inline pages that carry a timeline row no event page owns',
    { methods: ['putPage', 'addTimelineEntry', 'listTimelineHistoryBatch'] },
    async (engine) => {
      const empty = await engine.listTimelineHistoryBatch(SRC, 0);
      await put(engine, 'notes/t1', { timeline: '- **2026-01-02** | met' });
      await put(engine, 'notes/t2');
      await put(engine, 'notes/none');
      await engine.addTimelineEntry('notes/t1', { date: '2026-01-02', summary: 'met' });
      await engine.addTimelineEntry('notes/t2', { date: '2026-02-03', summary: 'called' });
      const first = await engine.listTimelineHistoryBatch(SRC, 0);
      const after = await engine.listTimelineHistoryBatch(SRC, first[0]?.id ?? 0);
      const other = await engine.listTimelineHistoryBatch(['nowhere'], 0);
      // Page ids depend on how many pages the arm's database has numbered before; the slug names the row.
      const bySlug = (rows: typeof first) => rows.map(({ id: _id, ...row }) => row);
      return { empty, first: bySlug(first), after: bySlug(after), other, ascending: first.every((r, i) => i === 0 || r.id > first[i - 1]!.id) };
    },
  );

  parityTest(
    'listAtomFenceCandidates and readPageCompiledTruths find world atoms whose source page names a fence',
    { methods: ['putPage', 'listAtomFenceCandidates', 'readPageCompiledTruths'] },
    async (engine) => {
      const none = await engine.listAtomFenceCandidates(SRC, { atomId: null, afterId: 0, limit: 10 });
      const fenced = await put(engine, 'notes/origin', { compiled_truth: 'before\n<!-- gbrain:facts:begin -->\nx\n<!-- gbrain:facts:end -->' });
      const plain = await put(engine, 'notes/origin-plain');
      await engine.putPage('atoms/one', { type: 'atom', title: 'one', compiled_truth: 'claim one', timeline: '', frontmatter: { visibility: 'world', source_slug: 'notes/origin', source_quote: 'q' } } as never);
      await engine.putPage('atoms/two', { type: 'atom', title: 'two', compiled_truth: 'claim two', timeline: '', frontmatter: { visibility: 'world', source_slug: 'notes/origin-plain' } } as never);
      await engine.putPage('atoms/three', { type: 'atom', title: 'three', compiled_truth: 'claim three', timeline: '', frontmatter: { visibility: 'private', source_slug: 'notes/origin' } } as never);
      const rows = await engine.listAtomFenceCandidates(SRC, { atomId: null, afterId: 0, limit: 10 });
      const one = await engine.listAtomFenceCandidates(SRC, { atomId: rows[0]?.id ?? 0, afterId: 0, limit: 10 });
      const past = await engine.listAtomFenceCandidates(SRC, { atomId: null, afterId: rows[0]?.id ?? 0, limit: 10 });
      const truths = await engine.readPageCompiledTruths([fenced, plain, 9999]);
      // Page ids and revisions are per-arm; slugs name the rows.
      const named = (list: typeof rows) => list.map(({ id: _i, origin_id: _o, revision, ...row }) => ({ ...row, hasRevision: typeof revision === 'string' && revision.length > 0 }));
      const names = new Map([[fenced, 'notes/origin'], [plain, 'notes/origin-plain']]);
      return { none, rows: named(rows), one: named(one), past: named(past), truths: truths.map((t) => ({ slug: names.get(t.id), body: t.body })).sort((a, b) => String(a.slug).localeCompare(String(b.slug))) };
    },
  );

  parityTest(
    'listRestorableAtomRetirements groups restorable re-extraction retirements per source',
    { methods: ['putPage', 'deletePage', 'listRestorableAtomRetirements'] },
    async (engine) => {
      const empty = await engine.listRestorableAtomRetirements(SRC);
      await put(engine, 'notes/origin');
      const retired = { retired_by: 'managed-reextract', source_slug: 'notes/origin', source_hash: 'h1', retired_at: '2026-01-01T00:00:00.000Z' };
      await engine.putPage('atoms/a1', { type: 'atom', title: 'a1', compiled_truth: 'a1', timeline: '', frontmatter: retired } as never);
      await engine.putPage('atoms/a2', { type: 'atom', title: 'a2', compiled_truth: 'a2', timeline: '', frontmatter: { ...retired, source_hash: 'pending:h1' } } as never);
      await engine.putPage('atoms/a3', { type: 'atom', title: 'a3', compiled_truth: 'a3', timeline: '', frontmatter: { ...retired, source_slug: 'notes/missing' } } as never);
      for (const slug of ['atoms/a1', 'atoms/a2', 'atoms/a3']) await engine.deletePage(slug);
      const rows = await engine.listRestorableAtomRetirements(SRC);
      const other = await engine.listRestorableAtomRetirements(['nowhere']);
      return { empty, rows, other };
    },
  );

  parityTest(
    'listUnpricedDerivationModels and listExtractionInputReceipts read the receipts of live pages',
    { methods: ['deletePage', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'upsertSegmentDerivations',
      'listUnpricedDerivationModels', 'listExtractionInputReceipts'] },
    async (engine) => {
      const none = { unpriced: await engine.listUnpricedDerivationModels(), receipts: await engine.listExtractionInputReceipts() };
      const a = await engine.createSegmentedPageShell('notes/a', pageMeta('A'), { sourceId: 'default' });
      const b = await engine.createSegmentedPageShell('notes/b', pageMeta('B'), { sourceId: 'default' });
      const gone = await engine.createSegmentedPageShell('notes/gone', pageMeta('Gone'), { sourceId: 'default' });
      const occ = await engine.allocateBodyOccurrenceIds(6);
      const row = (pageId: number, kind: 'links' | 'mentions' | 'synopsis', i: number, receipt: unknown) => ({
        pageId, kind, occurrenceId: occ[i]!, version: 1, segmentSha256: sha256(`seg:${i}`), contextHash: sha256(`ctx:${kind}`),
        state: 'partial' as const, output: {}, receipt,
      });
      await engine.upsertSegmentDerivations([
        row(a.id, 'links', 0, { kind: 'failed_windows', windows: [{ ordinal: 4 }] }),
        row(b.id, 'links', 1, { kind: 'failed_windows', windows: [{ ordinal: 2 }] }),
        row(a.id, 'mentions', 2, { kind: 'unpriced_model', model: 'model-x' }),
        row(b.id, 'mentions', 3, { reason: 'unpriced_model', model: 'model-x' }),
        row(b.id, 'synopsis', 4, { kind: 'unpriced_model', model: 'model-y' }),
        row(a.id, 'synopsis', 4, { reason: 'purge_sweep_pending' }),
        row(gone.id, 'links', 5, { kind: 'failed_windows' }),
        row(gone.id, 'mentions', 5, { kind: 'unpriced_model', model: 'model-z' }),
        row(a.id, 'synopsis', 5, { n: 1 }),
      ]);
      await engine.deletePage('notes/gone');
      const unpriced = await engine.listUnpricedDerivationModels();
      const receipts = await engine.listExtractionInputReceipts();
      // The samples of a group come newest first, and two receipts written in one statement may tie on time:
      // compare each group's samples as a set.
      const settled = receipts.map((r) => ({ ...r, samples: [...r.samples].sort() }));
      expect(unpriced.length).toBe(2);
      expect(receipts.length).toBe(2);
      return { none, unpriced, receipts: settled };
    },
  );

  parityTest(
    'readEmbeddingBacklogAge reads the oldest chunk of a live page that has no vector',
    { methods: ['putPage', 'upsertChunks', 'readEmbeddingBacklogAge'] },
    async (engine) => {
      const empty = await engine.readEmbeddingBacklogAge('embedding');
      await put(engine, 'notes/a');
      await put(engine, 'notes/skipped', { frontmatter: { embed_skip: true } });
      await engine.upsertChunks('notes/a', [{ chunk_index: 0, chunk_text: 'alpha', chunk_source: 'compiled_truth' }]);
      await engine.upsertChunks('notes/skipped', [{ chunk_index: 0, chunk_text: 'beta', chunk_source: 'compiled_truth' }]);
      const row = await engine.readEmbeddingBacklogAge('embedding');
      // The age is wall-clock time since the write: a fresh chunk is seconds old, never negative.
      const aged = row && row.age_s !== null ? { fresh: Number(row.age_s) >= 0 && Number(row.age_s) < 3600 } : null;
      return { empty, aged, unaged: row ? Number(row.unaged) : null };
    },
  );

  parityTest(
    'the reads of tables the Rust store does not keep answer empty on a brain that holds pages',
    {
      methods: ['putPage', 'listRecordedTombstones', 'listBudgetLimitedRows', 'readBudgetHoldAge', 'listAmbiguousExtractionInputs',
        'countLedgerCoveredAtomRetirements', 'listLiveGenerationRetirements', 'listHeldGenerations',
        'listOrphanGenerationCandidates', 'readExtractRollup7d', 'listRecordedHaltReasons7d'],
    },
    async (engine) => {
      await put(engine, 'notes/a');
      const tombstones = await engine.listRecordedTombstones('24', []);
      const limited = await engine.listBudgetLimitedRows({ column: 'embedding', signature: null });
      const limitedSource = await engine.listBudgetLimitedRows({ column: 'embedding', sourceId: 'default', signature: 'sig' });
      const hold = await engine.readBudgetHoldAge();
      const ambiguous = await engine.listAmbiguousExtractionInputs();
      const covered = await engine.countLedgerCoveredAtomRetirements(SRC);
      const retirements = await engine.listLiveGenerationRetirements(SRC, 30);
      const held = await engine.listHeldGenerations(SRC);
      const orphans = await engine.listOrphanGenerationCandidates(SRC, 'atom');
      const rollup = await engine.readExtractRollup7d(true);
      const rollupLegacy = await engine.readExtractRollup7d(false);
      const halts = await engine.listRecordedHaltReasons7d();
      return { tombstones, limited, limitedSource, hold, ambiguous, covered, retirements, held, orphans, rollup, rollupLegacy, halts };
    },
  );

  parityTest(
    'countDerivedVisibility counts derived pages by visibility stamp and looser-than-origin world pages',
    { methods: ['putPage', 'addLink', 'countDerivedVisibility'] },
    async (engine) => {
      const empty = await engine.countDerivedVisibility(SRC, 5000);
      await put(engine, 'notes/open', { frontmatter: { visibility: 'world' } });
      await put(engine, 'notes/closed', { frontmatter: { visibility: 'private' } });
      await put(engine, 'notes/label', { frontmatter: { access: 'private' } });
      const derived = (slug: string, type: string, frontmatter: Record<string, unknown>) =>
        engine.putPage(slug, { type, title: slug, compiled_truth: slug, timeline: '', frontmatter } as never);
      await derived('atoms/unstamped', 'atom', {});
      await derived('atoms/fine', 'atom', { visibility: 'world', source_slug: 'notes/open' });
      await derived('atoms/orphan', 'atom', { visibility: 'world', source_slug: 'notes/missing' });
      await derived('atoms/hidden', 'atom', { visibility: 'world', source_slug: 'notes/closed' });
      await derived('concepts/unstamped', 'concept', { synthesized_by: 'dream' });
      await derived('concepts/world', 'concept', { synthesized_by: 'dream', visibility: 'world' });
      await derived('concepts/plain', 'concept', {});
      await derived('events/chronicle', 'event', { captured_via: 'life-chronicle:x', event: { depth: 'notes/closed' } });
      await engine.addLink('concepts/world', 'atoms/hidden', 'input', 'synthesized_from', 'concept-provenance');
      const counts = await engine.countDerivedVisibility(SRC, 5000);
      const other = await engine.countDerivedVisibility(['nowhere'], 5000);
      expect(Number(counts.unstamped_atoms)).toBeGreaterThan(0);
      return { empty, counts, other };
    },
  );

  parityTest(
    'readAtomProvenanceCounts counts atoms whose source page moved or went away',
    { methods: ['putPage', 'deletePage', 'readAtomProvenanceCounts'] },
    async (engine) => {
      const empty = await engine.readAtomProvenanceCounts();
      await put(engine, 'notes/origin', { content_hash: 'abcdef0123456789ffff' });
      await put(engine, 'notes/going');
      const atom = (slug: string, frontmatter: Record<string, unknown>) =>
        engine.putPage(slug, { type: 'atom', title: slug, compiled_truth: slug, timeline: '', frontmatter } as never);
      await atom('atoms/ok', { source_slug: 'notes/origin', source_hash: 'abcdef0123456789' });
      await atom('atoms/changed', { source_slug: 'notes/origin', source_hash: '0000000000000000', extracted_at: '2026-03-04T00:00:00Z' });
      await atom('atoms/gone', { source_slug: 'notes/missing', source_hash: '1111111111111111', extracted_at: '2026-01-02T00:00:00Z' });
      await atom('atoms/unbound', { source_hash: '2222222222222222' });
      await atom('atoms/pending', { source_slug: 'notes/origin', source_hash: 'pending:3333333333333333' });
      await atom('atoms/managed', { source_slug: 'notes/origin', source_hash: 'pending:abcdef0123456789', managed_extraction: 'true' });
      await atom('atoms/nohash', { source_slug: 'notes/origin' });
      await atom('atoms/retired', { source_slug: 'notes/origin', source_hash: '4444444444444444' });
      await engine.deletePage('atoms/retired');
      const counts = await engine.readAtomProvenanceCounts();
      expect(Number(counts?.drifted)).toBeGreaterThan(0);
      return { empty, counts };
    },
  );

  parityTest(
    'listOntologyFactCandidates lists ontology facts with their withdrawn, consolidated and duplicate verdicts',
    { methods: ['putPage', 'insertFacts', 'insertFactWithdrawal', 'listOntologyFactCandidates'] },
    async (engine) => {
      const empty = await engine.listOntologyFactCandidates(SRC);
      await put(engine, 'notes/page');
      const fact = (name: string, source: string, row: number, slug: string) => ({
        fact: name, kind: 'fact' as const, entity_slug: 'people/a', visibility: 'world' as const, source,
        dimension: 'role', value: name, value_hash: `h-${name}`, source_markdown_slug: slug, row_num: row,
        valid_from: new Date('2026-01-01T00:00:00Z'),
      });
      await engine.insertFacts([
        // Row 2 is stamped with the page row 1 names as its source, so row 1 is its stint's duplicate.
        fact('one', 'notes/page', 1, 'notes/other'),
        fact('one', 'ontology:run1', 2, 'notes/page'),
        fact('two', 'ontology:run1', 3, 'notes/page'),
        fact('three', 'cli:extract-conversation-facts', 4, 'notes/page'),
      ] as never, { source_id: 'default' });
      await engine.insertFactWithdrawal('default', 'world', 'two', 'people/a', null);
      const rows = await engine.listOntologyFactCandidates(SRC);
      const other = await engine.listOntologyFactCandidates(['nowhere']);
      expect(rows.length).toBeGreaterThan(0);
      // Fact ids come from a sequence the arm does not rewind: the row number names the row.
      return { empty, rows: rows.map(({ id: _id, ...r }) => r), other };
    },
  );
});
