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

const { parityTest } = parityArms(testBackends());

const SRC = ['default'];

async function put(engine: BrainEngine, slug: string, extra: Record<string, unknown> = {}): Promise<number> {
  const page = await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '', ...extra } as never);
  return page.id;
}

describe('doctor-derived reads', () => {
  parityTest(
    'readIgnoredPrivacyLabelCounts groups ignored access labels of live pages by key and value',
    { methods: ['putPage', 'readIgnoredPrivacyLabelCounts'] },
    async (engine) => {
      const empty = await engine.readIgnoredPrivacyLabelCounts({ timeoutMs: 5000 });
      await put(engine, 'notes/private-a', { frontmatter: { access: 'private' } });
      await put(engine, 'notes/private-b', { frontmatter: { access: 'private', confidentiality: 'secret' } });
      await put(engine, 'notes/typed', { frontmatter: { access: 'private', visibility: 'private' } });
      await put(engine, 'notes/plain');
      const all = await engine.readIgnoredPrivacyLabelCounts({ timeoutMs: 5000 });
      const scoped = await engine.readIgnoredPrivacyLabelCounts({ sourceIds: SRC, timeoutMs: 5000 });
      const other = await engine.readIgnoredPrivacyLabelCounts({ sourceIds: ['nowhere'], timeoutMs: 5000 });
      expect(empty).toEqual([]);
      expect(other).toEqual([]);
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
    { methods: ['putPage', 'countCredentialProjectionPending'] },
    async (engine) => {
      const empty = await engine.countCredentialProjectionPending();
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
      await put(engine, 'notes/key', { compiled_truth: pem });
      await put(engine, 'notes/plain');
      const all = await engine.countCredentialProjectionPending();
      const scoped = await engine.countCredentialProjectionPending(SRC);
      const other = await engine.countCredentialProjectionPending(['nowhere']);
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
    'listUntiledSegmentedPageRows finds no page while no page is segmented',
    { methods: ['putPage', 'listUntiledSegmentedPageRows'] },
    async (engine) => {
      const empty = await engine.listUntiledSegmentedPageRows(null, null, 10);
      await put(engine, 'notes/inline');
      const rows = await engine.listUntiledSegmentedPageRows(SRC, ['notes/inline'], 10);
      return { empty, rows };
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
      const none = await engine.listAtomFenceCandidates({ sourceIds: SRC, atomId: null, after: 0, limit: 10 });
      const fenced = await put(engine, 'notes/origin', { compiled_truth: 'before\n<!-- gbrain:facts:begin -->\nx\n<!-- gbrain:facts:end -->' });
      const plain = await put(engine, 'notes/origin-plain');
      await engine.putPage('atoms/one', { type: 'atom', title: 'one', compiled_truth: 'claim one', timeline: '', frontmatter: { visibility: 'world', source_slug: 'notes/origin', source_quote: 'q' } } as never);
      await engine.putPage('atoms/two', { type: 'atom', title: 'two', compiled_truth: 'claim two', timeline: '', frontmatter: { visibility: 'world', source_slug: 'notes/origin-plain' } } as never);
      await engine.putPage('atoms/three', { type: 'atom', title: 'three', compiled_truth: 'claim three', timeline: '', frontmatter: { visibility: 'private', source_slug: 'notes/origin' } } as never);
      const rows = await engine.listAtomFenceCandidates({ sourceIds: SRC, atomId: null, after: 0, limit: 10 });
      const one = await engine.listAtomFenceCandidates({ sourceIds: SRC, atomId: rows[0]?.id ?? 0, after: 0, limit: 10 });
      const past = await engine.listAtomFenceCandidates({ sourceIds: SRC, atomId: null, after: rows[0]?.id ?? 0, limit: 10 });
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
    'listUnpricedDerivationModels, listExtractionInputReceipts and readEmbeddingBacklogAge read an empty derivation brain',
    { methods: ['putPage', 'listUnpricedDerivationModels', 'listExtractionInputReceipts', 'readEmbeddingBacklogAge'] },
    async (engine) => {
      await put(engine, 'notes/a');
      const unpriced = await engine.listUnpricedDerivationModels();
      const receipts = await engine.listExtractionInputReceipts();
      const backlog = await engine.readEmbeddingBacklogAge('embedding');
      return { unpriced, receipts, backlog };
    },
  );

  parityTest(
    'the reads of tables the Rust store does not keep answer empty on a brain that holds pages',
    {
      methods: ['putPage', 'listRecordedTombstones', 'listAmbiguousExtractionInputs',
        'countLedgerCoveredAtomRetirements', 'listLiveGenerationRetirements', 'listHeldGenerations', 'listPendingGenerationMembers',
        'listOrphanGenerationCandidates', 'readExtractRollup7d', 'listRecordedHaltReasons7d'],
    },
    async (engine) => {
      await put(engine, 'notes/a');
      const tombstones = await engine.listRecordedTombstones('24', []);
      const ambiguous = await engine.listAmbiguousExtractionInputs();
      const covered = await engine.countLedgerCoveredAtomRetirements(SRC);
      const retirements = await engine.listLiveGenerationRetirements(SRC, 30);
      const held = await engine.listHeldGenerations(SRC);
      const pending = await engine.listPendingGenerationMembers(SRC, null);
      const orphans = await engine.listOrphanGenerationCandidates(SRC, 'atom');
      const rollup = await engine.readExtractRollup7d(true);
      const rollupLegacy = await engine.readExtractRollup7d(false);
      const halts = await engine.listRecordedHaltReasons7d();
      return { tombstones, ambiguous, covered, retirements, held, pending, orphans, rollup, rollupLegacy, halts };
    },
  );

  // The Rust store keeps no page embedding ledger (`page_embedding_budget`), so both reads refuse by name instead of
  // answering "nothing held". At the join with rust-engine/main they read its ledger (key B 'b') and this case writes one
  // held row and reads it back on every arm (TODOS.md, rust-page-embedding-budget-join).
  parityTest(
    'listBudgetLimitedRows and readBudgetHoldAge answer a brain with no budget row, and refuse by name on Rust',
    { methods: ['putPage', 'listBudgetLimitedRows', 'readBudgetHoldAge'] },
    async (engine, backend) => {
      await put(engine, 'notes/large-candidate');
      const signature = 'openai:text-embedding-3-large:1536';
      const reads = {
        limited: () => engine.listBudgetLimitedRows({ column: 'embedding', signature: null }),
        limitedSource: () => engine.listBudgetLimitedRows({ column: 'embedding', sourceId: 'default', signature }),
        hold: () => engine.readBudgetHoldAge(),
      };
      if (backend === 'rust') {
        let last: unknown = null;
        for (const [read, member] of [[reads.limited, 'listBudgetLimitedRows'], [reads.limitedSource, 'listBudgetLimitedRows'],
          [reads.hold, 'readBudgetHoldAge']] as const) {
          last = await (read as () => Promise<unknown>)().then(() => null, (e: unknown) => e);
          const refusal = last as { code?: string; detail?: string } | null;
          expect({ member, code: refusal?.code, named: refusal?.detail?.includes(`member=${member} `) })
            .toEqual({ member, code: 'engine_capability_missing', named: true });
        }
        throw last;
      }
      return { limited: await reads.limited(), limitedSource: await reads.limitedSource(), hold: await reads.hold() };
    },
  );

  parityTest(
    'countDerivedVisibility counts derived pages by visibility stamp',
    { methods: ['putPage', 'countDerivedVisibility'] },
    async (engine) => {
      await put(engine, 'notes/a');
      await engine.putPage('atoms/v1', { type: 'atom', title: 'v1', compiled_truth: 'v1', timeline: '', frontmatter: { visibility: 'world' } } as never);
      return engine.countDerivedVisibility(SRC, 5000);
    },
  );

  parityTest(
    'readAtomProvenanceCounts reads an empty facts brain',
    { methods: ['putPage', 'readAtomProvenanceCounts'] },
    async (engine) => {
      await put(engine, 'notes/a');
      return engine.readAtomProvenanceCounts();
    },
  );
});
