/**
 * BrainEngine parity — batch 6c: `gbrain repair secret-spans` and the secret store behind it (secret-store/store.ts,
 * restore.ts, spool.ts, repair/secret-spans.ts; their statements are typed members in engine-sql/secret-store.ts,
 * engine-sql/secret-spans-rows.ts and the queue row (engine-sql/projection-rebuild.ts), served on the Rust store by
 * secret_store.rs and repair_secret_spans.rs).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1) the preview of a page whose
 *    stored copies hold credentials lists it by rule with its retained versions, counts a clean page, and writes nothing;
 *    the apply with the preview hash rewrites only the spans in the page, its frontmatter, timeline rows, facts, takes,
 *    link contexts and raw data, deletes the chunk rows that held a value, keeps the stored tier, seals each original in
 *    the store with one occurrence per changed field, and a second preview is empty. A page edited after the preview
 *    stops the apply (`preview_changed`) and writes nothing. `gbrain secrets restore` puts a false positive back and marks
 *    its entry allowed, and the redactors leave the value alone afterwards. The store members seal, list, count, back up,
 *    restore, and cascade the way the SQL engines do: a purged page takes its originals with it, a renamed page takes its
 *    occurrences, a deleted source takes its entries.
 *  - Regression: every one of these statements ran through `executeRaw`, which a Rust brain refuses; `repair secret-spans`
 *    stopped at plan entry ("repair secret-spans scan") on the Rust engine.
 *  - Why existing coverage misses it: test/repair-secret-spans.test.ts, test/secret-store*.test.ts run on PGLite (and
 *    Postgres) and seed through raw SQL.
 *  - Seam: none. The repair runs in the engine's own transactions; seeding uses typed members only. Row ids, revisions
 *    and sealed ids differ by engine and are normalized (`REV`, `#`, a rule marker without its id).
 */
import { afterAll, describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { embedStalePages } from '../../src/core/embed-stale.ts';
import { resealAfterRestore } from '../../src/core/repair/secret-spans.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../../src/core/search/embedding-column.ts';
import { allowedMatcher, countsByRule, entryRow, insertBackupRows, isAllowed, keysInUse, listEntries, markerOf, occurrencesOf, recordOccurrence, seal, sealWithId,
  storeSnapshot, unreferencedEntryCount } from '../../src/core/secret-store/store.ts';
import { applyRestore, previewRestore } from '../../src/core/secret-store/restore.ts';
import { sealSegmentedPage, stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { buildSegmentedProjection } from '../../src/core/page-body/projection.ts';
import { parseEmbedding } from '../../src/core/utils.ts';

/** A key id is 16 hex characters (keyring.ts keyIdOf); a repeated pair keeps it from reading as a credential. */
const KEY_ID = 'ab'.repeat(8);
/** A secret store entry id (`ss_` and 12 hex); repeated pairs keep a marker next to a rule name from reading as a credential. */
const DIRECT_ID = `ss_${'ab'.repeat(6)}`;
const { parityTest } = parityArms(testBackends());

// The cases that embed configure the process-global gateway; put the preload's baseline back for the next file.
afterAll(() => resetGateway());

const logger = { info() {}, warn() {}, error() {} } as never;
// Obviously fake key shapes, assembled so no literal key sits in the source.
const OPENAI = ['sk', 'proj', 'EXAMPLExNOTxREALxEXAMPLExNOTxREAL'].join('-');
const AWS = 'AKIA' + 'EXAMPLENOTREAL00';
const GITHUB = 'ghp' + '_' + 'EXAMPLEnotREAL'.repeat(3);
const BEARER = 'EXAMPLEtokenNOTreal' + '1234567890abcdef';
const SECRETS = [OPENAI, AWS, GITHUB, BEARER];
const SRC = 'default';
const ALPHA = 'notes/alpha-example';
const SEGMENTED = 'notes/segmented-example';
const CLEAN = 'notes/clean-example';
const ALPHA_BODY = ['# Alpha Example', '', `The deploy notes keep the old key ${OPENAI} here.`, `Authorization: Bearer ${BEARER}`,
  `The token ${BEARER} appears again bare.`, 'Nothing else changes, not even this line.'].join('\n');
const ALPHA_TIMELINE = `- **2024-01-02** | import — Rotated ${AWS} out of the build`;

/** The text with row ids, revisions and sealed ids made comparable across engines. */
const norm = <T,>(value: T): T => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v)
  .replace(/\(revision [0-9a-f-]{36}\)/g, '(revision REV)')
  .replace(/<REDACTED:([a-z0-9_]+):ss_[0-9a-f]{12}>/g, '<REDACTED:$1>')
  .replace(/ss_[0-9a-f]{12}/g, 'ss_ID')
  .replace(/(timeline_entries|facts|takes|links|raw_data)\/\d+\//g, '$1/#/'));
const leaked = (value: unknown) => SECRETS.filter(secret => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v).includes(secret));

/** Runs `body` with a fresh secret store key home, so the seal needs no key of the host. */
async function inHome<T>(body: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-secret-spans-'));
  try { return await withEnv({ GBRAIN_HOME: home, GBRAIN_SECRET_STORE_KEY: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, body); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

/** A page whose every stored copy holds a credential, a page with one in a chunk only, and a clean page. */
async function seedPages(engine: BrainEngine) {
  const alpha = await engine.putPage(ALPHA, { type: 'note' as never, title: 'Alpha Example', compiled_truth: ALPHA_BODY, timeline: ALPHA_TIMELINE,
    frontmatter: { owner: 'alice-example', note_key: `copy of ${OPENAI}` } }, { sourceId: SRC });
  const clean = await engine.putPage(CLEAN, { type: 'note' as never, title: 'Clean Example', compiled_truth: 'No credentials on this page.', timeline: '' }, { sourceId: SRC });
  // A retained version of the page as it was written, credentials and all.
  await engine.createVersion(ALPHA, { sourceId: SRC });
  await engine.addTimelineEntry(ALPHA, { date: '2024-01-02', source: 'import', summary: `Rotated ${AWS} out of the build`, detail: '' }, { sourceId: SRC });
  await engine.addTimelineEntry(ALPHA, { date: '2024-03-04', source: 'import', summary: 'Unrelated entry', detail: '' }, { sourceId: SRC });
  await engine.insertFact({ fact: `The CI token is ${GITHUB}.`, entity_slug: ALPHA, visibility: 'world', context: `Seen next to ${AWS} in the notes`, source: 'test', embedding: null }, { source_id: SRC });
  await engine.addTakesBatch([{ page_id: Number(alpha.id), row_num: 1, claim: `Rotating ${OPENAI} was overdue`, kind: 'take', holder: 'alice-example', source: 'notes' }]);
  await engine.addLink(ALPHA, CLEAN, `see ${AWS} near the clean page`, 'mentions');
  await engine.putRawData(ALPHA, 'test', { request: { headers: { authorization: `Bearer ${BEARER}` }, ids: [1, 2] }, note: 'kept as is' }, { sourceId: SRC });
  await engine.upsertChunks(ALPHA, [{ chunk_index: 0, chunk_text: ALPHA_BODY, chunk_source: 'compiled_truth' }, { chunk_index: 1, chunk_text: 'A clean chunk.', chunk_source: 'compiled_truth' }], { sourceId: SRC });
  return { alpha: Number(alpha.id), clean: Number(clean.id) };
}

/** A segmented page whose stored body holds credentials, created through the staging members only (no raw SQL on any arm). */
async function seedSegmented(engine: BrainEngine) {
  const body = ['# Segmented Example', '', `The deploy notes keep the old key ${OPENAI} here.`, `Authorization: Bearer ${BEARER}`, 'Nothing else changes, not even this line.'].join('\n');
  const staged = await stageSegmentedImport(engine, { slug: SEGMENTED, sourceId: SRC, existing: null,
    page: { title: 'Segmented Example', type: 'note', compiled_truth: body, timeline: '', frontmatter: {}, tags: [] },
    policy: { segmented: true, maxBytes: 1e9, flipRetireMaxRows: 1000, versionsMaxPerPage: 10, versionsMaxPinnedBytes: 1e9 } as never,
    chunking: { quarantined: false, tier: 'none', corpusGeneration: null } as never, baseRevision: null });
  const created = await engine.transaction(async tx => {
    const applied = await staged.apply(tx, { title: 'Segmented Example', type: 'note' as never, frontmatter: {}, page_kind: 'markdown' as never } as never, { mode: 'none', corpusGeneration: null });
    if (applied.complete) await sealSegmentedPage(tx, applied.pageId);
    return applied;
  });
  /** The page's stored body, segment by segment, as the manifest orders it. */
  const storedBody = async () => {
    const rows = await engine.readManifest(created.pageId);
    const texts = await engine.readSegmentTexts(SRC, rows.map(row => row.sha256));
    return rows.map(row => Buffer.from(texts.get(Buffer.from(row.sha256).toString('hex')) ?? new Uint8Array()).toString('utf8')).join('');
  };
  return { created, storedBody };
}

const runKind = async (engine: BrainEngine, opts: { apply: boolean; slugs: string[]; expect?: string; embed?: boolean }) =>
  (await repairRunner(engine, { apply: opts.apply, noEmbed: !opts.embed, logger })).run('secret-spans', await resolveRepairScope(engine, SRC),
    { explicit: true, remote: false, sourceFlag: SRC, slugs: opts.slugs, ...(opts.expect ? { expect: opts.expect } : {}) } as never);

/** Every stored copy of the alpha page and what the store holds, as the repair leaves them. */
async function readState(engine: BrainEngine) {
  const chunkRows = await engine.getChunks(ALPHA, { sourceId: SRC, includeUnsealed: true } as never);
  const chunks = chunkRows.map(c => c.chunk_text);
  const page = await engine.getPage(ALPHA, { sourceId: SRC });
  const snapshot = await engine.readPageSnapshot(ALPHA, { sourceId: SRC });
  return norm({
    page: { title: page!.title, compiled_truth: page!.compiled_truth, timeline: page!.timeline, frontmatter: page!.frontmatter },
    timeline: (await engine.getTimeline(ALPHA, { sourceId: SRC } as never)).map(e => [e.date, e.summary]).sort(),
    facts: (await engine.listFactsByEntity(SRC, ALPHA, { activeOnly: false } as never)).map(f => [f.fact, f.context]),
    takes: (await engine.listTakes({ page_slug: ALPHA } as never)).map(t => [t.claim, t.source]),
    links: (await engine.getLinks(ALPHA, { sourceId: SRC } as never)).map(l => l.context),
    raw: (await engine.getRawData(ALPHA, 'test', { sourceId: SRC })).map(r => r.data),
    revision: snapshot!.revision,
    chunksHoldingACredential: leaked(chunks).length,
    chunkRows: chunkRows.map(c => [c.chunk_index, c.chunk_source, c.chunk_text]),
    sealed: snapshot!.page.text_projection_revision === snapshot!.revision,
  });
}

/** A deterministic stub vector per input text: the embed runs without a provider request. */
const DIMS = 1536;
const vectorFor = (text: string) => Array.from({ length: DIMS }, (_, i) => Math.sin((text.length + 1) * (i + 1)));
const SIGNATURE = `openai:text-embedding-3-large:${DIMS}`;

/** Configures the gateway so an embed returns the stub vectors, and says what each chunk row holds. */
function stubEmbeddings() {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
}
const embeddedRows = async (engine: BrainEngine, slug: string) =>
  (await engine.getChunksWithEmbeddings(slug, { sourceId: SRC, includeUnsealed: true })).map(c => [c.chunk_index, c.chunk_text, c.embedding ? c.embedding.length : null, c.model]);

/** A code page whose constant holds a credential, and the call it makes: its chunks carry one call edge once resealed. */
const CODE = 'src/example-code';
const CODE_BODY = [`const KEY = '${OPENAI}';`, '', 'export function alpha() {', '  return beta(KEY);', '}', '', 'export function beta(value: string) {', '  return value.length;', '}'].join('\n');
const seedCode = (engine: BrainEngine, body = CODE_BODY) => engine.putPage(CODE, { type: 'code' as never, page_kind: 'code' as never, title: 'example-code.ts (typescript)',
  compiled_truth: body, timeline: '', frontmatter: { file: 'src/example-code.ts', language: 'typescript' } }, { sourceId: SRC });

describe('engine parity: repair secret-spans', () => {
  parityTest('the preview lists a page with credentials by rule, counts a clean page and writes nothing', {
    methods: ['putPage', 'createVersion', 'addTimelineEntry', 'insertFact', 'addTakesBatch', 'addLink', 'putRawData', 'upsertChunks', 'getPage',
      'readPageRedactionRow', 'readPageRedactionRows', 'listTimelineDedupRows', 'countPageVersionRows', 'listAllowedSecretMacs'],
    timeout: 120_000,
  }, async engine => {
    await seedPages(engine);
    return inHome(async () => {
      const before = await readState(engine);
      const preview = await runKind(engine, { apply: false, slugs: [ALPHA, CLEAN, 'notes/missing-example'] });
      expect(preview.affected).toBe(1);
      expect(preview.residuals).toMatchObject({ pages_to_redact: 1, clean: 1, refused: 1 });
      expect(leaked(preview)).toEqual([]);
      expect(await readState(engine)).toEqual(before);
      return norm({ affected: preview.affected, residuals: preview.residuals, listing: preview.listing, rules: (preview.details as { rules: string[] }).rules,
        fields: ((preview.details as { pages: Array<{ fields: Array<{ key: string; spans: number }>; rules: unknown; versions: number }> }).pages)
          .map(page => ({ rules: page.rules, versions: page.versions, fields: page.fields.map(f => [f.key, f.spans]) })) });
    });
  });

  parityTest('the apply with the preview hash rewrites only the spans, seals each original and leaves a second preview empty', {
    methods: ['putPage', 'createVersion', 'getVersions', 'addTimelineEntry', 'insertFact', 'addTakesBatch', 'addLink', 'putRawData', 'upsertChunks', 'getPage', 'readPageSnapshot', 'getTimeline',
      'listFactsByEntity', 'listTakes', 'getLinks', 'getRawData', 'getChunks', 'readPageRedactionRow', 'readPageRedactionRows', 'listTimelineDedupRows',
      'listVersionBodiesForRedaction', 'setRetainedVersionBody', 'listChunkTextsForRedaction', 'deleteChunksByIds', 'setRedactedPageFields', 'readRawDataValue', 'setRawDataValue', 'setRedactedRowText',
      'queuePageProjectionJob', 'findSecretEntryByMac', 'insertSecretEntry', 'insertSecretOccurrence', 'listSecretEntrySummaries', 'countSecretsByRule',
      'listSecretOccurrences', 'readSecretEntry', 'readOpCheckpointRecord', 'writeOpCheckpointRecord', 'readPageRevisions'],
    timeout: 180_000,
  }, async engine => {
    await seedPages(engine);
    return inHome(async () => {
      const slugs = [ALPHA, CLEAN];
      const before = await readState(engine);
      const preview = await runKind(engine, { apply: false, slugs });
      const result = await runKind(engine, { apply: true, slugs, expect: preview.preview_hash });
      expect(result.applied).toBe(1);
      expect(result.outcomes).toEqual({ redacted: 1 });
      // The reseal right after the commit is typed members (readChunkKeepState and the rest): every engine seals the page at once.
      expect((result.outcome_items ?? []).map(item => item.detail?.projection)).toEqual(['sealed']);
      expect(leaked(result)).toEqual([]);
      const after = await readState(engine);
      expect(after.revision).not.toBe(before.revision);
      expect(leaked(after)).toEqual([]);
      const entries = await engine.listSecretEntrySummaries({ sourceId: SRC, slug: null, limit: 100 });
      const occurrences = [];
      for (const entry of entries) occurrences.push(await engine.listSecretOccurrences(entry.id));
      const read = await engine.readSecretEntry(entries.find(e => e.rule === 'openai')!.id);
      const again = await runKind(engine, { apply: false, slugs });
      return norm({ result: { applied: result.applied, outcomes: result.outcomes, verification: result.verification,
        items: (result.outcome_items ?? []).map(item => ({ item: item.item, outcome: item.outcome, detail: item.detail })) },
      state: { ...after, revision: undefined }, entries: entries.map(e => ({ rule: e.rule, status: e.status, occurrences: e.occurrences, slugs: e.slugs }))
        .sort((a, b) => a.rule.localeCompare(b.rule)),
      entry: { rule: read!.rule, status: read!.status, source_id: read!.source_id, readable: /^[0-9a-f]{16}$/.test(read!.key_id) },
      versions: (await engine.getVersions(ALPHA, { sourceId: SRC, includeBody: true } as never)).map(v => v.compiled_truth),
      places: occurrences.map(list => list.map(o => [o.slug, o.field, o.origin]).sort()).sort(),
      byRule: await engine.countSecretsByRule(SRC), second: { affected: again.affected, residuals: again.residuals } });
    });
  });

  parityTest('the apply with embedding on re-embeds the rebuilt chunks, stamps the page and leaves no chunk without a vector', {
    methods: ['putPage', 'upsertChunks', 'getChunksWithEmbeddings', 'getPage', 'readPageSnapshot', 'readLivePageIdBySlug', 'listUnembeddedChunkIndexes', 'queuePageProjectionJob', 'readPageRedactionRow'],
    timeout: 180_000,
  }, async engine => {
    stubEmbeddings();
    await seedPages(engine);
    return inHome(async () => {
      const slugs = [ALPHA, CLEAN];
      const preview = await runKind(engine, { apply: false, slugs, embed: true });
      const result = await runKind(engine, { apply: true, slugs, expect: preview.preview_hash, embed: true });
      expect(result.applied).toBe(1);
      const [item] = result.outcome_items ?? [];
      expect(item?.detail?.projection).toBe('sealed');
      expect(item?.detail?.embedded as number).toBeGreaterThan(0);
      const after = await readState(engine);
      expect(leaked(after)).toEqual([]);
      const rows = await embeddedRows(engine, ALPHA);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => row[2] === DIMS)).toBe(true);
      // A second embed finds nothing stale: the first one embedded every rebuilt chunk.
      const again = await embedStalePages(engine, [ALPHA], SRC);
      return norm({ detail: item?.detail, state: { ...after, revision: undefined }, rows, again: { embedded: again.embedded, pagesProcessed: again.pagesProcessed } });
    });
  });

  parityTest('embedStalePages embeds a page\'s stale chunks, keeps the others and stamps the signature once every chunk is current', {
    methods: ['putPage', 'sealChunks', 'upsertChunks', 'getChunksWithEmbeddings', 'readLivePageIdBySlug', 'listVectorlessChunkIndexes', 'readPageProvenanceComplete', 'setPageEmbeddingSignature'],
    timeout: 180_000,
  }, async engine => {
    stubEmbeddings();
    const page = await engine.putPage('notes/embed-example', { type: 'note' as never, title: 'Embed Example', compiled_truth: 'One paragraph of text.\n\nAnother paragraph of text.', timeline: '' }, { sourceId: SRC });
    await engine.sealChunks('notes/embed-example', [{ chunk_index: 0, chunk_text: 'One paragraph of text.', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'Another paragraph of text.', chunk_source: 'compiled_truth' }], { sourceId: SRC });
    const column = (await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name;
    const found = await engine.readLivePageIdBySlug('notes/embed-example', SRC);
    const before = { found: found === Number(page.id), missing: await engine.readLivePageIdBySlug('notes/no-such-page', SRC),
      vectorless: await engine.listVectorlessChunkIndexes(Number(page.id), column), none: await engine.listVectorlessChunkIndexes(999_999, column),
      complete: await engine.readPageProvenanceComplete('notes/embed-example', SRC, 'openai:text-embedding-3-large', DIMS, column) };
    expect(before.found).toBe(true);
    expect(before.vectorless).toEqual([0, 1]);
    expect(before.complete).toBe(false);
    const embedded = await embedStalePages(engine, ['notes/embed-example', 'notes/no-such-page'], SRC, { embeddingSignature: SIGNATURE });
    const after = { vectorless: await engine.listVectorlessChunkIndexes(Number(page.id), column),
      complete: await engine.readPageProvenanceComplete('notes/embed-example', SRC, 'openai:text-embedding-3-large', DIMS, column),
      otherModel: await engine.readPageProvenanceComplete('notes/embed-example', SRC, 'openai:another-model', DIMS, column),
      otherWidth: await engine.readPageProvenanceComplete('notes/embed-example', SRC, 'openai:text-embedding-3-large', 768, column),
      otherSource: await engine.readPageProvenanceComplete('notes/embed-example', 'nowhere', 'openai:text-embedding-3-large', DIMS, column) };
    expect(embedded.embedded).toBe(2);
    expect(after.vectorless).toEqual([]);
    expect(after.complete).toBe(true);
    // A chunk write leaves the text projection unsealed: the page is not complete until it is sealed and embedded again.
    await engine.upsertChunks('notes/embed-example', [{ chunk_index: 0, chunk_text: 'One paragraph of edited text.', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'Another paragraph of text.', chunk_source: 'compiled_truth' }], { sourceId: SRC });
    const edited = { vectorless: await engine.listVectorlessChunkIndexes(Number(page.id), column),
      complete: await engine.readPageProvenanceComplete('notes/embed-example', SRC, 'openai:text-embedding-3-large', DIMS, column) };
    return norm({ before, embedded: { embedded: embedded.embedded, pagesProcessed: embedded.pagesProcessed }, after, edited, rows: await embeddedRows(engine, 'notes/embed-example') });
  });

  parityTest('a code page: the reseal after a restore installs its call edges through typed members, and the apply names a code page as unsupported', {
    methods: ['putPage', 'getChunks', 'getEdgesByChunk', 'getCallersOf', 'addCodeEdges', 'clearCodeEdgesLeavingChunks', 'readPageSnapshot', 'readPageRedactionRow', 'readChunkKeepState',
      'countPendingTextChunks'],
    timeout: 180_000,
  }, async engine => {
    await seedCode(engine);
    return inHome(async () => {
      // secret-spans rewrites markdown pages only: a code page is refused by name on every arm, never reaching a reseal through the apply.
      const preview = await runKind(engine, { apply: false, slugs: [CODE] });
      expect(preview.residuals).toMatchObject({ pages_to_redact: 0, refused: 1 });
      // The reseal `gbrain secrets restore` runs after a restore (resealAfterRestore -> resealSafeChunks) is what installs a code page's edges.
      const view = async () => {
        const chunks = await engine.getChunks(CODE, { sourceId: SRC, includeUnsealed: true } as never);
        const edges = (await Promise.all(chunks.map(async c => (await engine.getEdgesByChunk(c.id, { direction: 'out' })).map(e => [c.chunk_index, e.from_symbol_qualified, e.to_symbol_qualified, e.edge_type]))))
          .flat().sort();
        const snapshot = await engine.readPageSnapshot(CODE, { sourceId: SRC });
        return { chunks: chunks.map(c => [c.chunk_index, c.chunk_text, c.symbol_name_qualified]), edges, sealed: snapshot!.page.text_projection_revision === snapshot!.revision };
      };
      const before = await view();
      await resealAfterRestore(engine, SRC, CODE, 'inline', false);
      const first = await view();
      expect(first.sealed).toBe(true);
      expect(first.edges.length).toBeGreaterThan(0);
      // An edge a chunk no longer holds, then an edit that leaves the other function alone: the next reseal installs exactly the page's own edges.
      const alpha = (await engine.getChunks(CODE, { sourceId: SRC, includeUnsealed: true } as never)).find(c => c.symbol_name_qualified?.includes('alpha'))!;
      await engine.addCodeEdges([{ from_chunk_id: alpha.id, to_chunk_id: null, from_symbol_qualified: alpha.symbol_name_qualified!, to_symbol_qualified: 'stale.callee', edge_type: 'calls', source_id: SRC }]);
      await seedCode(engine, `${CODE_BODY}\n\nexport function gamma() {\n  return alpha();\n}`);
      await resealAfterRestore(engine, SRC, CODE, 'inline', false);
      const second = await view();
      expect(second.sealed).toBe(true);
      expect(JSON.stringify(second.edges)).not.toContain('stale.callee');
      const callers = (await engine.getCallersOf('beta', { sourceId: SRC })).map(e => [e.from_symbol_qualified, e.to_symbol_qualified, e.edge_type]);
      return norm({ refused: preview.listing, before, first, second, callers });
    });
  });

  parityTest('clearCodeEdgesLeavingChunks drops the edges leaving the named chunks from both tables and keeps the edges that point at them', {
    methods: ['putPage', 'upsertChunks', 'getChunks', 'addCodeEdges', 'getEdgesByChunk', 'clearCodeEdgesLeavingChunks'],
    timeout: 120_000,
  }, async engine => {
    await engine.putPage('src/edges-a', { type: 'code' as never, page_kind: 'code' as never, title: 'a', compiled_truth: 'a', timeline: '', frontmatter: { file: 'src/edges-a.ts' } }, { sourceId: SRC });
    await engine.upsertChunks('src/edges-a', [{ chunk_index: 0, chunk_text: 'function a() { b(); }', chunk_source: 'compiled_truth', symbol_name_qualified: 'a' } as never,
      { chunk_index: 1, chunk_text: 'function b() {}', chunk_source: 'compiled_truth', symbol_name_qualified: 'b' } as never,
      { chunk_index: 2, chunk_text: 'function c() { b(); }', chunk_source: 'compiled_truth', symbol_name_qualified: 'c' } as never], { sourceId: SRC });
    const [a, b, c] = (await engine.getChunks('src/edges-a', { sourceId: SRC, includeUnsealed: true } as never)).map(chunk => chunk.id);
    const edge = (from: number, to: number | null, fromName: string, toName: string) => ({ from_chunk_id: from, to_chunk_id: to, from_symbol_qualified: fromName, to_symbol_qualified: toName, edge_type: 'calls', source_id: SRC });
    await engine.addCodeEdges([edge(a!, b!, 'a', 'b'), edge(c!, b!, 'c', 'b'), edge(b!, c!, 'b', 'c'), edge(a!, null, 'a', 'elsewhere'), edge(c!, null, 'c', 'elsewhere')]);
    const view = async () => Promise.all([a!, b!, c!].map(async id => (await engine.getEdgesByChunk(id, { direction: 'both' })).map(e => [e.from_symbol_qualified, e.to_symbol_qualified, e.resolved]).sort()));
    const before = await view();
    await engine.clearCodeEdgesLeavingChunks([]);
    const empty = await view();
    await engine.clearCodeEdgesLeavingChunks([a!, 999_999]);
    const afterA = await view();
    expect(afterA).not.toEqual(before);
    await engine.clearCodeEdgesLeavingChunks([b!, c!]);
    return norm({ before, empty, afterA, afterAll: await view() });
  });

  parityTest('a segmented page is created through the staging, manifest and flip members and stores the same body, sealed, on every arm', {
    methods: ['openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'createSegmentedPageShell', 'flipBodyGeneration', 'setBodyStagingState', 'lockBodyStagingState', 'deleteUnstagedSegmentChunks',
      'readManifest', 'readSegmentTexts', 'sealSegmentedPage', 'readPageSnapshot'],
    timeout: 180_000,
  }, async engine => {
    const { created, storedBody } = await seedSegmented(engine);
    expect(created.complete).toBe(true);
    const snapshot = await engine.readPageSnapshot(SEGMENTED, { sourceId: SRC });
    const rows = await engine.readManifest(created.pageId);
    expect(await storedBody()).toContain(OPENAI);
    // The two members the apply sends: a staging no write opened reads null; a generation no chunk was staged for deletes nothing.
    const unknownStaging = await engine.lockBodyStagingState('99999999-9999-4999-8999-999999999999');
    await engine.deleteUnstagedSegmentChunks(created.pageId, 99, []);
    expect(unknownStaging).toBeNull();
    return { unknownStaging, body: await storedBody(), manifestRows: rows.length, sealed: snapshot!.page.text_projection_revision === snapshot!.revision };
  });

  parityTest('a segmented page: the apply rewrites its stored body through the staging and flip members, seals it and leaves a second preview empty', {
    methods: ['openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'createSegmentedPageShell', 'flipBodyGeneration', 'setBodyStagingState', 'lockBodyStagingState', 'deleteUnstagedSegmentChunks',
      'readManifest', 'readSegmentTexts', 'sealSegmentedPage', 'readPageSnapshot', 'listChunkedOccurrences', 'hasStaleSegmentChunks', 'getChunks', 'listVectorlessChunkIndexes'],
    timeout: 180_000,
  }, async engine => {
    const { storedBody } = await seedSegmented(engine);
    return inHome(async () => {
      const preview = await runKind(engine, { apply: false, slugs: [SEGMENTED] });
      expect(preview.affected).toBe(1);
      const result = await runKind(engine, { apply: true, slugs: [SEGMENTED], expect: preview.preview_hash });
      expect(result.applied).toBe(1);
      expect(result.outcomes).toEqual({ redacted: 1 });
      const after = await storedBody();
      expect(leaked(after)).toEqual([]);
      const snapshot = await engine.readPageSnapshot(SEGMENTED, { sourceId: SRC });
      const again = await runKind(engine, { apply: false, slugs: [SEGMENTED] });
      // The page's search chunks after the replace: the rows the sealed projection shows, none holding a credential.
      const chunks = (await engine.getChunks(SEGMENTED, { sourceId: SRC } as never)).map(c => [c.chunk_source, c.chunk_text]);
      expect(leaked(chunks)).toEqual([]);
      expect(chunks.length).toBeGreaterThan(0);
      const entries = await listEntries(engine, { sourceId: SRC });
      // Every chunk row of the replaced page is live and holds no vector yet: the vectorless list is the same set of rows on every arm.
      const column = (await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name;
      const vectorless = (await engine.listVectorlessChunkIndexes(Number(snapshot!.page.id), column)).length;
      return norm({ outcomes: result.outcomes, items: (result.outcome_items ?? []).map(item => ({ item: item.item, outcome: item.outcome, detail: item.detail })),
        body: after, chunks, vectorless: vectorless === chunks.length, sealed: snapshot!.page.text_projection_revision === snapshot!.revision,
        entries: entries.map(e => ({ rule: e.rule, status: e.status, occurrences: e.occurrences, slugs: e.slugs })).sort((a, b) => a.rule.localeCompare(b.rule)),
        second: { affected: again.affected, residuals: again.residuals } });
    });
  });

  parityTest('the chunk probes of a segmented replace answer the same: chunked occurrences, stale rows and their retirement', {
    methods: ['openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'createSegmentedPageShell', 'flipBodyGeneration', 'setBodyStagingState', 'lockBodyStagingState',
      'readManifest', 'sealSegmentedPage', 'readPageSnapshot', 'listChunkedOccurrences', 'hasStaleSegmentChunks', 'retireStaleSegmentChunks', 'readSegmentedProjectionPage'],
    timeout: 180_000,
  }, async engine => {
    const { created } = await seedSegmented(engine);
    const manifest = await engine.readManifest(created.pageId);
    const ids = manifest.map(row => Number(row.occurrenceId));
    // An id the page never had, a repeat and the order the caller sent: the answer keeps the caller's order and repeats.
    const probe = [999_999, ...ids.slice().reverse(), ...ids.slice(0, 1)];
    const chunked = await engine.listChunkedOccurrences(created.pageId, probe, 1);
    const none = await engine.listChunkedOccurrences(created.pageId, [], 1);
    const other = await engine.listChunkedOccurrences(999_999, ids, 1);
    const page = await engine.readSegmentedProjectionPage(SRC, SEGMENTED);
    const missing = await engine.readSegmentedProjectionPage(SRC, 'notes/no-such-segmented-page');
    const inline = await engine.putPage(CLEAN, { type: 'note' as never, title: 'Clean Example', compiled_truth: 'No credentials on this page.', timeline: '' }, { sourceId: SRC });
    const inlinePage = await engine.readSegmentedProjectionPage(SRC, CLEAN);
    // Every chunk row belongs to a live occurrence at generation 1: none is stale. Naming no live occurrence makes them all stale.
    const fresh = await engine.hasStaleSegmentChunks(created.pageId, 1, ids);
    const allStale = await engine.hasStaleSegmentChunks(created.pageId, 1, []);
    const noPage = await engine.hasStaleSegmentChunks(999_999, 1, []);
    const retiredNone = await engine.retireStaleSegmentChunks(created.pageId, 1, ids, 10);
    const retiredOne = await engine.retireStaleSegmentChunks(created.pageId, 1, [], 1);
    const retiredRest = await engine.retireStaleSegmentChunks(created.pageId, 1, [], 1000);
    const afterRetire = await engine.hasStaleSegmentChunks(created.pageId, 1, []);
    const left = await engine.listChunkedOccurrences(created.pageId, ids, 1);
    expect(inline.id).toBeDefined();
    return norm({ order: chunked.map(id => probe.indexOf(id) >= 0), count: chunked.length, none, other, ids: ids.length,
      page: page && { generation: Number(page.body_generation), bytes: Number(page.body_bytes), title: page.title, frontmatter: page.frontmatter, flags: page.body_flags,
        sealed: page.text_projection_revision === page.knowledge_revision, leadSet: page.timeline_lead !== undefined },
      missing, inlinePage, fresh, allStale, noPage, retiredNone, retired: [retiredOne, retiredRest > 0], afterRetire, left });
  });

  parityTest('a segmented page whose projection was never built is chunked and sealed by the projection build, and a second build has nothing left to do', {
    methods: ['openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'createSegmentedPageShell', 'flipBodyGeneration', 'setBodyStagingState', 'lockBodyStagingState',
      'readManifest', 'readPageSnapshot', 'readSegmentedProjectionPage', 'listChunkedOccurrences', 'hasStaleSegmentChunks', 'retireStaleSegmentChunks', 'sealSegmentedPage',
      'claimSegmentedProjection', 'getChunks'],
    timeout: 180_000,
  }, async engine => {
    const body = ['# Unsealed Example', '', 'A paragraph that waits for its projection.', '', 'Another paragraph of the same page.'].join('\n');
    const staged = await stageSegmentedImport(engine, { slug: 'notes/unsealed-example', sourceId: SRC, existing: null,
      page: { title: 'Unsealed Example', type: 'note', compiled_truth: body, timeline: '', frontmatter: {}, tags: [] },
      policy: { segmented: true, maxBytes: 1e9, flipRetireMaxRows: 1000, versionsMaxPerPage: 10, versionsMaxPinnedBytes: 1e9 } as never,
      chunking: { quarantined: false, tier: 'none', corpusGeneration: null } as never, baseRevision: null });
    // The create stages no chunks and does not seal: the projection build does both.
    const created = await engine.transaction(async tx => staged.apply(tx, { title: 'Unsealed Example', type: 'note' as never, frontmatter: {}, page_kind: 'markdown' as never } as never, { mode: 'none', corpusGeneration: null }));
    const before = await engine.readSegmentedProjectionPage(SRC, 'notes/unsealed-example');
    const ids = (await engine.readManifest(created.pageId)).map(row => Number(row.occurrenceId));
    const chunkedBefore = await engine.listChunkedOccurrences(created.pageId, ids, 1);
    const built = await buildSegmentedProjection(engine, { sourceId: SRC, slug: 'notes/unsealed-example' });
    const after = await engine.readSegmentedProjectionPage(SRC, 'notes/unsealed-example');
    const chunks = (await engine.getChunks('notes/unsealed-example', { sourceId: SRC } as never)).map(c => [c.chunk_source, c.chunk_text]);
    const again = await buildSegmentedProjection(engine, { sourceId: SRC, slug: 'notes/unsealed-example' });
    return { sealedBefore: before!.text_projection_revision === before!.knowledge_revision, chunkedBefore: chunkedBefore.length > 0, built: { chunks: built.chunks > 0, retired: built.retired, sealed: built.sealed },
      sealedAfter: after!.text_projection_revision === after!.knowledge_revision, chunks, again: { chunks: again.chunks, retired: again.retired, sealed: again.sealed },
      complete: created.complete };
  });

  parityTest('the vectors of the rows a replace retires are read back for reuse: text, vector, model, recorded input and the page fields reuse checks', {
    methods: ['openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'createSegmentedPageShell', 'flipBodyGeneration', 'setBodyStagingState', 'lockBodyStagingState',
      'readManifest', 'sealSegmentedPage', 'readPageSnapshot', 'stageSegmentChunks', 'readRetiredChunkVectors'],
    timeout: 180_000,
  }, async engine => {
    const { created } = await seedSegmented(engine);
    const ids = (await engine.readManifest(created.pageId)).map(row => Number(row.occurrenceId));
    const first = ids[0]!;
    const column = (await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name;
    const before = await engine.readRetiredChunkVectors(created.pageId, ids, column);
    // A chunk that carries a vector (a reused one) is stored with it, its model and its recorded input.
    await engine.stageSegmentChunks(created.pageId, 1, [{ chunk_index: 0, chunk_text: 'A chunk with a vector.', chunk_source: 'compiled_truth', model: 'stub-model',
      embedding: new Float32Array(vectorFor('A chunk with a vector.')), embedding_input_hash: 'input-hash', occurrence_id: first, local_ordinal: 9, raw_byte_start: 0, raw_byte_end: 22 } as never]);
    const rows = await engine.readRetiredChunkVectors(created.pageId, [first], column);
    const none = await engine.readRetiredChunkVectors(created.pageId, [], column);
    const elsewhere = await engine.readRetiredChunkVectors(created.pageId, [999_999], column);
    return norm({ before: before.length, rows: rows.map(r => ({ text: r.chunk_text, source: r.chunk_source, model: r.model, hash: r.embedding_input_hash, mode: r.contextual_retrieval_mode,
      slug: r.slug, source_id: r.source_id, corpus: r.corpus_generation,
      vector: Array.from(parseEmbedding(r.embedding as never) as ArrayLike<number>).slice(0, 8).map(v => Math.round(v * 1e4) / 1e4), width: (parseEmbedding(r.embedding as never) as ArrayLike<number>).length })),
    none, elsewhere });
  });

  parityTest('a segmented page with a withdrawn fact: the replace chunks the body under the withdrawal ledger and the apply keeps the struck row out of its chunks on every engine', {
    methods: ['openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'createSegmentedPageShell', 'flipBodyGeneration', 'setBodyStagingState', 'lockBodyStagingState',
      'readManifest', 'sealSegmentedPage', 'readPageSnapshot', 'insertFactWithdrawal', 'listChunkedOccurrences', 'getChunks', 'listVectorlessChunkIndexes'],
    timeout: 180_000,
  }, async (engine, backend) => {
    const slug = 'notes/withdrawn-segmented-example';
    const fact = (rowNum: number, claim: string) => ({ rowNum, claim, kind: 'fact' as const, confidence: 1, visibility: 'world' as const, notability: 'medium' as const,
      validFrom: '2024-01-01', source: 'user', active: true });
    const body = [`# Withdrawn Example`, '', `The deploy notes keep the old key ${OPENAI} here.`, '', '## Facts', '', renderFactsTable([fact(1, 'Ana lives in Lima'), fact(2, 'Ana keeps bees')]), ''].join('\n');
    // The ledger names row 1's claim before the body is stored, so every chunking of the body sees it.
    await engine.insertFactWithdrawal(SRC, 'world', 'Ana lives in Lima', slug, '2026-01-03T00:00:00.000Z');
    const staged = await stageSegmentedImport(engine, { slug, sourceId: SRC, existing: null,
      page: { title: 'Withdrawn Example', type: 'note', compiled_truth: body, timeline: '', frontmatter: {}, tags: [] },
      policy: { segmented: true, maxBytes: 1e9, flipRetireMaxRows: 1000, versionsMaxPerPage: 10, versionsMaxPinnedBytes: 1e9 } as never,
      chunking: { quarantined: false, tier: 'none', corpusGeneration: null } as never, baseRevision: null });
    const created = await engine.transaction(async tx => {
      const applied = await staged.apply(tx, { title: 'Withdrawn Example', type: 'note' as never, frontmatter: {}, page_kind: 'markdown' as never } as never, { mode: 'none', corpusGeneration: null });
      if (applied.complete) await sealSegmentedPage(tx, applied.pageId);
      return applied;
    });
    const chunksOf = async () => (await engine.getChunks(slug, { sourceId: SRC } as never)).map(c => c.chunk_text);
    const before = await chunksOf();
    const column = (await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name;
    return inHome(async () => {
      const preview = await (await repairRunner(engine, { apply: false, noEmbed: true, logger })).run('secret-spans', await resolveRepairScope(engine, SRC),
        { explicit: true, remote: false, sourceFlag: SRC, slugs: [slug] } as never);
      const result = await (await repairRunner(engine, { apply: true, noEmbed: true, logger })).run('secret-spans', await resolveRepairScope(engine, SRC),
        { explicit: true, remote: false, sourceFlag: SRC, slugs: [slug], expect: preview.preview_hash } as never);
      const after = await chunksOf();
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: SRC });
      const vectorless = (await engine.listVectorlessChunkIndexes(created.pageId, column)).length;
      // The page snapshot lists the page's withdrawals on every engine (the Rust store's snapshot_withdrawals), so the
      // chunker of the replaced body drops the struck row everywhere.
      expect(after.join('\n')).not.toContain('lives in Lima');
      return norm({ created: created.complete, outcomes: result.outcomes, before: before.map(t => t.includes('Lima')), chunks: after.length,
        leaked: leaked(after), sealed: snapshot!.page.text_projection_revision === snapshot!.revision, vectorless: vectorless === after.length });
    });
  });

  parityTest('a page edited after the preview stops the apply and nothing is written', {
    methods: ['putPage', 'readPageSnapshot', 'getPage', 'getTimeline', 'listFactsByEntity', 'listTakes', 'getLinks', 'getRawData', 'getChunks', 'listSecretEntrySummaries'],
    timeout: 120_000,
  }, async engine => {
    await seedPages(engine);
    return inHome(async () => {
      const slugs = [ALPHA, CLEAN];
      const preview = await runKind(engine, { apply: false, slugs });
      await engine.putPage(ALPHA, { type: 'note' as never, title: 'Alpha Example', compiled_truth: `${ALPHA_BODY}\nA later edit.`, timeline: ALPHA_TIMELINE,
        frontmatter: { owner: 'alice-example', note_key: `copy of ${OPENAI}` } }, { sourceId: SRC });
      const before = await readState(engine);
      let code: unknown = null;
      try { await runKind(engine, { apply: true, slugs, expect: preview.preview_hash }); } catch (error) { code = (error as { code?: string }).code; }
      expect(code).toBe('preview_changed');
      expect(await readState(engine)).toEqual(before);
      return { code, entries: (await engine.listSecretEntrySummaries({ sourceId: SRC, slug: null, limit: 100 })).length };
    });
  });

  parityTest('gbrain secrets restore puts a false positive back, marks its entry allowed and the redactor leaves it alone', {
    methods: ['putPage', 'insertFact', 'addTimelineEntry', 'addTakesBatch', 'addLink', 'putRawData', 'upsertChunks', 'getPage', 'readPageSnapshot', 'createVersion',
      'listSecretEntrySummaries', 'readSecretEntry', 'listSecretOccurrences', 'readRestorePageHit', 'markSecretEntryAllowed', 'listAllowedSecretMacs', 'getTimeline',
      'listFactsByEntity', 'listTakes', 'getLinks', 'getRawData', 'getChunks'],
    timeout: 120_000,
  }, async engine => {
    await seedPages(engine);
    return inHome(async () => {
      const slugs = [ALPHA, CLEAN];
      const preview = await runKind(engine, { apply: false, slugs });
      await runKind(engine, { apply: true, slugs, expect: preview.preview_hash });
      const entry = (await engine.listSecretEntrySummaries({ sourceId: SRC, slug: null, limit: 100 })).find(e => e.rule === 'openai')!;
      const restore = await previewRestore(engine, entry.id);
      expect(restore.pages.map(p => p.slug)).toEqual([ALPHA]);
      const done = await applyRestore(engine, entry.id, restore.hash, 'parity-test');
      const after = await readState(engine);
      expect(JSON.stringify(after)).toContain(OPENAI);
      const second = await runKind(engine, { apply: false, slugs });
      return norm({ fields: restore.pages.map(p => p.fields), restored: done.restored, status: done.status, entry: (await engine.readSecretEntry(entry.id))!.status,
        allowed: (await allowedMatcher(engine, SRC))(OPENAI), other: (await allowedMatcher(engine, SRC))(AWS), isAllowed: await isAllowed(engine, SRC, OPENAI),
        // The chunk rows are rebuilt from the restored body right away on every engine.
        state: { ...after, revision: undefined }, second: { affected: second.affected, residuals: second.residuals } });
    });
  });

  parityTest('the store seals one entry per value, lists it with its places, counts by rule and keeps restored values apart', {
    methods: ['putPage', 'findSecretEntryByMac', 'secretEntryExists', 'insertSecretEntry', 'insertSecretOccurrence', 'readSecretEntry', 'listSecretOccurrences', 'listSecretEntrySummaries',
      'countSecretsByRule', 'listAllowedSecretMacs', 'listSecretKeysInUse', 'countUnreferencedSecretEntries', 'markSecretEntryAllowed', 'deleteUnreferencedSecretEntry'],
    timeout: 120_000,
  }, async engine => {
    const page = await engine.putPage('notes/store-a', { type: 'note' as never, title: 'Store A', compiled_truth: 'Body.', timeline: '' }, { sourceId: SRC });
    return inHome(async () => {
      const first = await seal(engine, { sourceId: SRC, rule: 'github_token', value: GITHUB });
      const again = await seal(engine, { sourceId: SRC, rule: 'github_token', value: GITHUB });
      expect(again).toMatchObject({ id: first.id, created: false });
      const other = await seal(engine, { sourceId: SRC, rule: 'aws_access_key', value: AWS });
      await recordOccurrence(engine, { entryId: first.id, sourceId: SRC, pageId: Number(page.id), slug: 'notes/store-a', field: 'compiled_truth', origin: 'repair', createdBy: 'test' });
      await recordOccurrence(engine, { entryId: first.id, sourceId: SRC, slug: 'notes/store-b', field: 'title', origin: 'transcript' });
      await recordOccurrence(engine, { entryId: other.id, sourceId: SRC, field: 'compiled_truth', origin: 'publish_rebuild', commit: 'abc123', path: 'notes/c.md', line: 7 });
      const spool = await sealWithId(engine, { id: DIRECT_ID, sourceId: SRC, rule: 'openai', value: OPENAI });
      const spoolAgain = await sealWithId(engine, { id: DIRECT_ID, sourceId: SRC, rule: 'openai', value: OPENAI });
      const spoolDuplicate = await sealWithId(engine, { id: 'ss_ba9876543210', sourceId: SRC, rule: 'openai', value: OPENAI });
      expect(spool).toEqual({ kind: 'inserted' });
      expect(spoolAgain).toEqual({ kind: 'exists' });
      expect(spoolDuplicate).toEqual({ kind: 'duplicate', existing: DIRECT_ID });
      // A row the CHECKs or the foreign keys refuse is refused on every engine, and nothing is written.
      const refused = async (run: () => Promise<unknown>) => run().then(() => false, () => true);
      const refusals = {
        badRule: await refused(() => engine.insertSecretEntry({ id: 'ss_aaaaaaaaaaaa', sourceId: SRC, rule: 'Bad Rule', ciphertext: 'c', nonce: 'n', tag: 't', keyId: KEY_ID, keyHost: '', valueMac: 'a'.repeat(64) }, 'value')),
        unknownSource: await refused(() => engine.insertSecretEntry({ id: 'ss_bbbbbbbbbbbb', sourceId: 'nowhere', rule: 'r', ciphertext: 'c', nonce: 'n', tag: 't', keyId: KEY_ID, keyHost: '', valueMac: 'b'.repeat(64) }, 'value')),
        idClash: await refused(() => engine.insertSecretEntry({ id: first.id, sourceId: SRC, rule: 'r', ciphertext: 'c', nonce: 'n', tag: 't', keyId: KEY_ID, keyHost: '', valueMac: 'c'.repeat(64) }, 'value')),
        unknownEntry: await refused(() => recordOccurrence(engine, { entryId: 'ss_cccccccccccc', sourceId: SRC, field: 'title', origin: 'repair' })),
        badOrigin: await refused(() => recordOccurrence(engine, { entryId: first.id, sourceId: SRC, field: 'title', origin: 'nowhere' as never })),
        invalidId: await refused(() => entryRow(engine, 'not-an-id')),
        missing: await refused(() => entryRow(engine, 'ss_dddddddddddd')),
      };
      expect(Object.values(refusals)).toEqual(Array(7).fill(true));
      await engine.markSecretEntryAllowed(spool.kind === 'inserted' ? DIRECT_ID : first.id);
      const summaries = await listEntries(engine, { sourceId: SRC });
      const atSlug = await listEntries(engine, { slug: 'notes/store-b' });
      expect(await engine.deleteUnreferencedSecretEntry(first.id)).toBe(false);
      const unreferenced = await seal(engine, { sourceId: SRC, rule: 'bearer', value: BEARER });
      const before = await unreferencedEntryCount(engine);
      expect(await engine.deleteUnreferencedSecretEntry(unreferenced.id)).toBe(true);
      return norm({
        created: [first.created, other.created, again.created], found: await engine.findSecretEntryByMac(SRC, 'f'.repeat(64)),
        summaries: summaries.map(e => ({ rule: e.rule, status: e.status, occurrences: e.occurrences, slugs: e.slugs, readable: e.readable })).sort((a, b) => a.rule.localeCompare(b.rule)),
        atSlug: atSlug.map(e => e.rule), counts: await countsByRule(engine), sourceCounts: await countsByRule(engine, 'nowhere'),
        keys: (await keysInUse(engine)).map(k => k.entries), allowed: (await engine.listAllowedSecretMacs(SRC)).length, allowedEverywhere: (await engine.listAllowedSecretMacs(null)).length,
        places: (await occurrencesOf(engine, first.id)).map(o => [o.slug, o.field, o.origin, o.page_id === null ? null : 'page']),
        commitPlace: (await occurrencesOf(engine, other.id)).map(o => [o.commit_sha, o.path, o.line]), exists: await engine.secretEntryExists(first.id),
        entry: { rule: (await entryRow(engine, first.id)).rule, status: (await entryRow(engine, first.id)).status }, unreferenced: [before, await unreferencedEntryCount(engine)],
        marker: markerOf('github_token', first.id).replace(first.id, 'ID'), refusals,
      });
    });
  });

  parityTest('a purge takes the originals only that page held, a rename moves its places, a source delete takes its entries, and a backup restores by page', {
    methods: ['putPage', 'updateSlug', 'deletePages', 'softDeletePages', 'purgeDeletedPages', 'deleteSourceRecord', 'readSecretStoreSnapshot', 'insertBackupSecretEntry',
      'readBackupEntryHold', 'insertBackupSecretOccurrence', 'deleteUnreferencedSecretEntry', 'listSecretHoldingPages', 'listSecretOccurrences', 'readSecretEntry',
      'countUnreferencedSecretEntries', 'listSecretEntrySummaries', 'countSecretsByRule'],
    timeout: 120_000,
  }, async (engine, backend) => {
    const note = (slug: string, text = 'Body.') => ({ type: 'note' as never, title: slug, compiled_truth: text, timeline: '' });
    const pageA = await engine.putPage('notes/purge-a', note('notes/purge-a'), { sourceId: SRC });
    const pageB = await engine.putPage('notes/purge-b', note('notes/purge-b'), { sourceId: SRC });
    await createSource(engine, backend, 'doomed', {});
    const pageD = await engine.putPage('notes/doomed-a', note('notes/doomed-a'), { sourceId: 'doomed' });
    return inHome(async () => {
      const e1 = await seal(engine, { sourceId: SRC, rule: 'github_token', value: GITHUB });
      const e2 = await seal(engine, { sourceId: SRC, rule: 'aws_access_key', value: AWS });
      const e3 = await seal(engine, { sourceId: SRC, rule: 'openai', value: OPENAI });
      const e4 = await seal(engine, { sourceId: 'doomed', rule: 'bearer', value: BEARER });
      const on = (entry: { id: string }, page: { id: number | string; slug: string }, sourceId = SRC) =>
        recordOccurrence(engine, { entryId: entry.id, sourceId, pageId: Number(page.id), slug: page.slug, field: 'compiled_truth', origin: 'repair' });
      await on(e1, pageA); await on(e2, pageA); await on(e2, pageB); await on(e4, pageD, 'doomed');
      await recordOccurrence(engine, { entryId: e3.id, sourceId: SRC, field: 'compiled_truth', origin: 'publish_rebuild', commit: 'abc123', path: 'notes/c.md', line: 3 });
      const snapshot = await storeSnapshot(engine);
      const places = async (entry: { id: string }) => (await occurrencesOf(engine, entry.id)).map(o => [o.slug, o.page_id === null ? null : 'page', o.commit_sha]);
      const steps: Record<string, unknown> = { snapshot: snapshot.entries.length * 10 + snapshot.occurrences.length };
      // A rename takes the page's places with it; a commit place stays.
      await engine.updateSlug('notes/purge-b', 'notes/purge-c', { sourceId: SRC });
      steps.renamed = await places(e2);
      // A hard delete takes the originals only that page held; e2 keeps its other place.
      await engine.deletePages(['notes/purge-a'], { sourceId: SRC });
      steps.afterDelete = { e1: await engine.readSecretEntry(e1.id) === null, e2: await places(e2), e3: await places(e3) };
      // A tombstone purge takes the rest of e2.
      await engine.softDeletePages(['notes/purge-c'], { sourceId: SRC });
      await engine.purgeDeletedPages(0, {});
      steps.afterPurge = { e2: await engine.readSecretEntry(e2.id) === null, e3: await engine.readSecretEntry(e3.id) !== null, unreferenced: await unreferencedEntryCount(engine) };
      // A source delete takes its entries with their places.
      await engine.deleteSourceRecord('doomed');
      steps.afterSourceDelete = { e4: await engine.readSecretEntry(e4.id) === null, others: (await listEntries(engine, {})).map(e => e.rule).sort() };

      // The backup restores an entry only while a page of its source holds the marker; a commit place needs no page.
      const holder = await engine.putPage('notes/purge-a', note('notes/purge-a', `kept ${markerOf('github_token', e1.id)} and ${markerOf('aws_access_key', e2.id)} here`), { sourceId: SRC });
      const entries = snapshot.entries.filter(e => e.source_id === SRC);
      const mine = new Set(entries.map(e => e.id));
      const occurrences = snapshot.occurrences.filter(o => mine.has(o.entry_id));
      steps.holders = (await engine.listSecretHoldingPages(SRC, ['notes/purge-a', 'notes/purge-c', 'notes/never'], e2.id)).map(p => [p.slug, p.holds, p.segmented]);
      steps.restored = await insertBackupRows(engine, entries, occurrences);
      steps.restoredPlaces = { e1: await places(e1), e2: await places(e2), e3: await places(e3) };
      steps.again = await insertBackupRows(engine, entries, occurrences);
      // With the page gone again, an entry recorded only on pages is not brought back.
      await engine.deletePages(['notes/purge-a'], { sourceId: SRC });
      expect(holder.slug).toBe('notes/purge-a');
      steps.counts = await countsByRule(engine, SRC);
      steps.skipped = await insertBackupRows(engine, entries.filter(e => e.id === e1.id), occurrences.filter(o => o.entry_id === e1.id));
      return norm(steps);
    });
  });

  parityTest('the page-store members answer the same when called directly: reads, rewrites, versions, chunks and the queue', {
    methods: ['putPage', 'createVersion', 'addTimelineEntry', 'insertFact', 'addTakesBatch', 'addLink', 'putRawData', 'upsertChunks', 'getPage',
      'readPageRedactionRow', 'readPageRedactionRows', 'listTimelineDedupRows', 'listVersionBodiesForRedaction', 'countPageVersionRows', 'setRetainedVersionBody',
      'listChunkTextsForRedaction', 'deleteChunksByIds', 'setRedactedPageFields', 'readRawDataValue', 'setRawDataValue', 'setRedactedRowText', 'queuePageProjectionJob',
      'readPageSnapshot'],
    timeout: 120_000,
  }, async engine => {
    const { alpha } = await seedPages(engine);
    await engine.putPage(ALPHA, { type: 'note' as never, title: 'Alpha Example', compiled_truth: `${ALPHA_BODY} (edited)`, timeline: ALPHA_TIMELINE,
      frontmatter: { owner: 'alice-example', note_key: `copy of ${OPENAI}` } }, { sourceId: SRC });
    await engine.createVersion(ALPHA, { sourceId: SRC });
    const row = await engine.readPageRedactionRow(SRC, ALPHA);
    expect(row).toMatchObject({ id: alpha, title: 'Alpha Example', body_storage: 'inline', generation: '0', tags: [] });
    expect(await engine.readPageRedactionRow(SRC, 'notes/missing')).toBeNull();
    const rows = await engine.readPageRedactionRows(alpha, SRC, ALPHA);
    const timelineBefore = (await engine.listTimelineDedupRows(alpha)).map(r => [r.date, r.summary, r.source]);
    const versions = await engine.listVersionBodiesForRedaction(alpha);
    expect(await engine.countPageVersionRows(alpha)).toBe(versions.length);
    // Rewrites: the page, a timeline row, a fact, a take, a link, a raw data row, a retained version and a chunk row.
    await engine.setRedactedPageFields(alpha, { title: 'Alpha Example', frontmatter: { owner: 'alice-example', note_key: 'copy of [x]' }, compiledTruth: 'redacted body', timeline: ALPHA_TIMELINE, contentHash: 'hash-1' });
    await engine.setRedactedRowText(alpha, 'timeline_entries', rows.timeline[0]!.id, 'summary', 'Rotated [x] out of the build');
    await engine.setRedactedRowText(alpha, 'facts', rows.facts[0]!.id, 'fact', 'The CI token is [x].');
    await engine.setRedactedRowText(alpha, 'takes', rows.takes[0]!.id, 'claim', 'Rotating [x] was overdue');
    await engine.setRedactedRowText(alpha, 'links', rows.links[0]!.id, 'context', 'see [x] near the clean page');
    const rawId = rows.rawData[0]!.id;
    expect(await engine.readRawDataValue(alpha, rawId)).toEqual(rows.rawData[0]!.data);
    await engine.setRawDataValue(alpha, rawId, { request: { headers: { authorization: 'Bearer [x]' }, ids: [1, 2] }, note: 'kept as is' });
    await engine.setRetainedVersionBody(alpha, versions[0]!.id, 'retained [x]', { owner: 'alice-example' });
    const chunks = await engine.listChunkTextsForRedaction(alpha, 'rewrite');
    const doomed = chunks.filter(c => c.chunk_text.includes(OPENAI)).map(c => Number(c.id));
    await engine.deleteChunksByIds(alpha, doomed);
    await engine.queuePageProjectionJob(SRC, ALPHA, 'secret_spans');
    await engine.queuePageProjectionJob(SRC, 'notes/missing', 'secret_spans');
    const after = await engine.readPageRedactionRows(alpha, SRC, ALPHA);
    const snapshot = await engine.readPageSnapshot(ALPHA, { sourceId: SRC });
    expect(await engine.listChunkTextsForRedaction(alpha, 'scan')).toHaveLength(chunks.length - doomed.length);
    return norm({
      row: { ...row, id: undefined, revision: undefined }, timelineBefore, versions: versions.map(v => [v.compiled_truth, v.body_storage]),
      doomed: doomed.length, chunksLeft: (await engine.listChunkTextsForRedaction(alpha, 'scan')).map(c => c.chunk_text),
      after: { timeline: after.timeline.map(t => t.summary), facts: after.facts.map(f => f.fact), takes: after.takes.map(t => t.claim), links: after.links.map(l => l.context),
        raw: after.rawData.map(r => r.data) },
      retained: (await engine.listVersionBodiesForRedaction(alpha)).map(v => [v.compiled_truth, v.frontmatter]),
      page: { hash: (await engine.getPage(ALPHA, { sourceId: SRC }))!.compiled_truth, revisionMoved: snapshot!.revision !== row!.revision },
    });
  });

  parityTest('the store members read what they wrote: occurrences, keys, a backup row, a restore hit and the unreferenced count', {
    methods: ['putPage', 'insertSecretEntry', 'insertSecretOccurrence', 'listSecretKeysInUse', 'insertBackupSecretEntry', 'readBackupEntryHold', 'insertBackupSecretOccurrence',
      'countUnreferencedSecretEntries', 'readRestorePageHit', 'readSecretEntry', 'listSecretOccurrences', 'readPageSnapshot', 'deletePages'],
    timeout: 120_000,
  }, async engine => {
    const page = await engine.putPage('notes/direct', { type: 'note' as never, title: 'Direct', compiled_truth: `holds ${markerOf('github_token', DIRECT_ID)}`, timeline: '' }, { sourceId: SRC });
    const base = { ciphertext: 'Y2lwaGVy', nonce: 'bm9uY2U=', tag: 'dGFn', keyId: KEY_ID, keyHost: 'host-a' };
    const first = await engine.insertSecretEntry({ id: DIRECT_ID, sourceId: SRC, rule: 'github_token', valueMac: 'a'.repeat(64), ...base }, 'value');
    const clash = await engine.insertSecretEntry({ id: 'ss_ba9876543210', sourceId: SRC, rule: 'github_token', valueMac: 'a'.repeat(64), ...base }, 'any');
    await engine.insertSecretOccurrence({ entryId: DIRECT_ID, sourceId: SRC, pageId: Number(page.id), slug: 'notes/direct', field: 'compiled_truth', origin: 'repair',
      commit: null, path: null, line: null, preFieldSha256: null, createdBy: 'test' });
    const entry = (await engine.readSecretEntry(DIRECT_ID))!;
    const backup = { ...entry, updated_at: '2026-11-21T11:00:00.456Z', id: 'ss_aaaaaaaaaaaa', value_mac: 'b'.repeat(64), status: 'allowed' as const, created_at: '2026-11-21T10:00:00.123Z' };
    const written = [await engine.insertBackupSecretEntry(backup), await engine.insertBackupSecretEntry(backup)];
    const place = { entry_id: backup.id, source_id: SRC, page_id: null, slug: 'notes/direct', field: 'compiled_truth', origin: 'repair' as const, commit_sha: null, path: null, line: null,
      pre_field_sha256: null, created_by: 't', created_at: '2026-11-21T10:00:00.789Z' };
    const placed = [await engine.insertBackupSecretOccurrence(place, null), await engine.insertBackupSecretOccurrence(place, Number(page.id)), await engine.insertBackupSecretOccurrence(place, Number(page.id))];
    const hold = [await engine.readBackupEntryHold(backup.id, SRC, 'b'.repeat(64)), await engine.readBackupEntryHold(backup.id, SRC, 'c'.repeat(64)), await engine.readBackupEntryHold('ss_cccccccccccc', SRC, 'b'.repeat(64))];
    const hit = await engine.readRestorePageHit(SRC, 'notes/direct', markerOf('github_token', DIRECT_ID));
    const miss = await engine.readRestorePageHit(SRC, 'notes/direct', markerOf('github_token', 'ss_bbbbbbbbbbbb'));
    const snapshot = await engine.readPageSnapshot('notes/direct', { sourceId: SRC });
    expect(hit!.revision).toBe(snapshot!.revision);
    const unreferenced = [await engine.countUnreferencedSecretEntries()];
    await engine.deletePages(['notes/direct'], { sourceId: SRC });
    unreferenced.push(await engine.countUnreferencedSecretEntries());
    return norm({ first, clash, keys: (await engine.listSecretKeysInUse()).map(k => [k.key_host, k.entries]), written, placed, hold, hit: hit!.hit, miss: miss!.hit, noPage: await engine.readRestorePageHit(SRC, 'notes/gone', 'x'),
      places: (await engine.listSecretOccurrences(backup.id)).map(o => [o.slug, o.page_id === null ? null : 'page']), unreferenced });
  });
});
