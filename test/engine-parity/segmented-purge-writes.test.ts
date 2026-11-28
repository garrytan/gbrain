/**
 * BrainEngine parity: the writes a fact purge makes to a segmented page and to saved versions, at the sites that ran
 * through `executeRaw`: the flip's staging lock and its stale chunk delete (persistence/segmented-apply.ts
 * applySegmentedBody), the delete of the derivation rows a rewritten segment may hold (page-body/segment-derive.ts
 * deleteRewrittenDerivations), the version the purge saves of each page it rewrites (createVersion with the purge's
 * preimage, inline and segmented) and the purge's read of inline saved-version bodies (facts/purge.ts rewriteVersionBodies).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each site gives the same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): the chunks a replace keeps, the page a create publishes and
 *    the refusal of a staging a purge aborted, the derivation rows left, the fields of the saved version, and the version
 *    rows the purge reads in id order.
 *  - Regression: an engine that answers one of these differently keeps a chunk a dead preparation staged, publishes a
 *    staging a purge aborted, keeps a derivation row that may hold the purged text, saves the wrong revision or body, or
 *    misses a version that carries the claim. The Rust engine has no SQL, so each site has to run through a typed member.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18); the Rust arm stopped on its raw_sql refusal, and createVersion refused the purge's preimage.
 *  - Seam: none. Real engines, typed members only (no executeRaw: D18), seeded through the page-body fixtures.
 *    Generated values (page, occurrence, version and chunk ids, revisions) are compared by relation or label, never by value.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PurgeVersionBodyRow } from '../../src/core/engine-sql/segmented-purge-writes.ts';
import type { PreparedSegmentedBody } from '../../src/core/page-body/ingest.ts';
import type { SegmentTextInput } from '../../src/core/page-body/types.ts';
import { applySegmentedBody } from '../../src/core/persistence/segmented-apply.ts';
import { deleteRewrittenDerivations } from '../../src/core/page-body/segment-derive.ts';
import { DEFAULT_FLIP_RETIRE_MAX_ROWS } from '../../src/core/page-body/limits.ts';
import { bodyColumns, chunk, flipInput, manifestRow, pageMeta, publishSegmentedPage, segmentText, sha256, stageGeneration,
  stagingInput } from '../helpers/page-body-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms } from './harness.ts';
import { claimNeedles } from '../../src/core/facts/purge-verify.ts';

const { parityTest } = parityArms(testBackends());

const ONE = segmentText('# Intro\nfirst segment about quillwort\n');
const TWO = segmentText('## Middle\nsecond segment about heron\n');
const THREE = segmentText('## End\nthird segment about ibex\n');
const ONE_B = segmentText('# Intro\nfirst segment rewritten about marmot\n');
const textOf = (t: SegmentTextInput) => new TextDecoder().decode(t.body);
const SRC = 'default';

function prepared(input: { stagingId: string; expected: number; texts: readonly SegmentTextInput[]; close?: number[]; staged?: number[];
  createRows?: PreparedSegmentedBody['createRows'] }): PreparedSegmentedBody {
  return {
    stagingId: input.stagingId, expectedGeneration: input.expected, newGeneration: input.expected + 1, createRows: input.createRows ?? null,
    createChunks: null, closeOccurrences: input.close ?? [], retireChunkOccurrences: input.close ?? [], unchunked: input.createRows ? input.texts.length : 0,
    priorStale: false, body: bodyColumns(input.texts), bodyUnchanged: false, textUnchanged: false,
    rows: { texts: input.texts.length, manifest: input.texts.length, chunks: input.staged?.length ?? 0 }, stagedChunkIndexes: input.staged ?? [],
  };
}

async function apply(engine: BrainEngine, slug: string, pageId: number | null, prep: PreparedSegmentedBody) {
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId: SRC, slug }]);
    return applySegmentedBody(tx, { slug, sourceId: SRC, pageId, prepared: prep, meta: pageMeta(), promotion: false,
      retireMaxRows: DEFAULT_FLIP_RETIRE_MAX_ROWS, requestId: null });
  });
}

const SETTINGS = ['gbrain.write_request', 'gbrain.write_principal_kind', 'gbrain.write_principal_id'];

/** Admits one queued request of `local_cli:principalId` (as test/engine-parity/write-attribution.test.ts does); its journal id. */
async function admit(engine: BrainEngine, requestId: string, principalId: string, slug: string): Promise<string> {
  const source = await engine.readSourceMembership(SRC);
  const keys = [`principal:local_cli:${principalId}`, 'brain'];
  await engine.lockPersistenceCounters(keys);
  const row = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId, requestId, operation: 'put_page', sourceId: SRC, sourceIncarnation: source!.incarnation,
    pageId: null, slug, worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64), intent: { kind: 'put_page', slug },
    authority: { scopes: ['write'], agentLabel: 'agent-put_page' }, intentBytes: 100, terminalReservation: 4096, targetKind: 'page',
    protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued',
    deferredRefreshId: null,
  });
  return row.id;
}

/** Runs `fn` in a transaction whose write settings name `request` and the principal `local_cli:id`. */
function as<T>(engine: BrainEngine, request: string, id: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async tx => {
    await tx.applyTransactionSettings(SETTINGS, [request, 'local_cli', id]);
    return fn(tx);
  });
}

const chunkTexts = async (engine: BrainEngine, slug: string) => (await engine.getChunks(slug, { sourceId: SRC, includeUnsealed: true })).map(c => c.chunk_text).sort();

describe('engine parity: segmented purge writes', () => {
  parityTest('applySegmentedBody publishes a replace and drops the chunk rows staged under the new generation that its preparation did not stage', {
    methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows',
      'stageSegmentChunks', 'flipBodyGeneration', 'setBodyStagingState', 'transaction', 'lockPageKeys', 'getChunks', 'deleteUnstagedSegmentChunks'],
  }, async (engine) => {
    const slug = 'notes/seg-apply';
    const first = await publishSegmentedPage(engine, slug, [ONE, TWO], { chunkTexts: true });
    const second = await stageGeneration(engine, { pageId: first.pageId, slug, genFrom: 2, texts: [ONE_B, TWO] });
    const kept = await engine.stageSegmentChunks(first.pageId, 2, [chunk(second.occurrences[0]!, 0, textOf(ONE_B)), chunk(second.occurrences[1]!, 0, textOf(TWO))]);
    // A chunk a dead preparation staged under the same generation: the flip must drop it.
    await engine.stageSegmentChunks(first.pageId, 2, [chunk(second.occurrences[0]!, 1, 'stale chunk of a dead preparation')]);
    const applied = await apply(engine, slug, first.pageId, prepared({ stagingId: second.stagingId, expected: 1, texts: [ONE_B, TWO],
      close: first.occurrences, staged: kept }));
    // Run again on the published generation, the delete keeps the staged rows and finds nothing else.
    await engine.transaction(tx => tx.deleteUnstagedSegmentChunks(first.pageId, 2, kept));
    return { samePage: applied.pageId === first.pageId, complete: applied.complete, retireDeferred: applied.retireDeferred,
      chunks: await chunkTexts(engine, slug) };
  });

  parityTest('applySegmentedBody creates a page from a live staging and refuses a staging a purge aborted', {
    methods: ['allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'setBodyStagingState', 'transaction', 'lockPageKeys',
      'createSegmentedPageShell', 'stageManifestRows', 'flipBodyGeneration', 'getPage', 'lockBodyStagingState'],
  }, async (engine) => {
    const create = async (slug: string, abort: boolean) => {
      const staging = stagingInput({ slug, sourceId: SRC, mode: 'create' });
      const occurrences = await engine.allocateBodyOccurrenceIds(2);
      await engine.transaction(async tx => {
        await tx.openBodyStaging(staging);
        await tx.stageSegmentTexts(SRC, [ONE, THREE]);
      });
      if (abort) await engine.setBodyStagingState(staging.id, 'aborted');
      let byteStart = 0;
      const createRows = [ONE, THREE].map((text, seq) => {
        const row = manifestRow({ pageId: 0, occurrenceId: occurrences[seq]!, genFrom: 1, seq, text, byteStart, stagingId: null });
        byteStart += text.body.byteLength;
        return row;
      });
      try {
        const applied = await apply(engine, slug, null, prepared({ stagingId: staging.id, expected: 0, texts: [ONE, THREE], createRows }));
        const page = await engine.getPage(slug, { sourceId: SRC });
        return { complete: applied.complete, pageMatches: page?.id === applied.pageId, title: page?.title ?? null };
      } catch (error) {
        return { refused: (error as { code?: string }).code ?? String(error) };
      }
    };
    const missing = await engine.transaction(tx => tx.lockBodyStagingState('00000000-0000-4000-8000-000000000000'));
    return { live: await create('notes/seg-create', false), aborted: await create('notes/seg-aborted', true), missing };
  });

  parityTest('deleteRewrittenDerivations deletes the rows of the touched runs, the links rows in reach and the rows no live occurrence backs', {
    methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows',
      'flipBodyGeneration', 'setBodyStagingState', 'transaction', 'upsertSegmentDerivations', 'readSegmentDerivations',
      'deleteRewrittenSegmentDerivations'],
  }, async (engine) => {
    const texts = [ONE, TWO, THREE, ONE_B];
    const page = await publishSegmentedPage(engine, 'notes/seg-derive', texts);
    const [orphan] = await engine.allocateBodyOccurrenceIds(1);
    const row = (kind: 'links' | 'timeline' | 'synopsis', occurrenceId: number) =>
      ({ pageId: page.pageId, kind, occurrenceId, version: 1, segmentSha256: sha256(`seg:${occurrenceId}`), contextHash: sha256(`ctx:${kind}`),
        state: 'done' as const, output: {}, receipt: {} });
    const occ = page.occurrences;
    await engine.upsertSegmentDerivations([
      ...occ.flatMap(o => [row('links', o), row('timeline', o)]),
      row('synopsis', occ[3]!),
      // No live occurrence backs these: a pipeline row is deleted, a row of a kind outside the pipelines is kept.
      row('timeline', orphan!), row('synopsis', orphan!),
    ]);
    const rows = texts.map((text, i) => ({ occurrenceId: occ[i]!, region: 'truth' as const, cutKind: 'heading' as const, byteLen: text.body.byteLength }));
    const deleted = await engine.transaction(tx => deleteRewrittenDerivations(tx, page.pageId, rows, [{ from: 1, to: 1 }]));
    const label = (o: number) => o === orphan ? 'orphan' : `occ${occ.indexOf(o)}`;
    const left = (await engine.readSegmentDerivations(page.pageId)).map(r => `${r.kind}:${label(r.occurrenceId)}`).sort();
    // The same delete again finds nothing left to delete.
    const again = await engine.transaction(tx => tx.deleteRewrittenSegmentDerivations({ pageId: page.pageId, touchedOccurrenceIds: [occ[1]!],
      linkReachOccurrenceIds: [occ[0]!, occ[2]!, occ[3]!], pipelines: ['links', 'mentions', 'timeline', 'fences'], liveOccurrenceIds: occ }));
    return { deleted, left, again };
  });

  parityTest('createVersion with the purge preimage of an inline page saves the page as read, not as it stands', {
    methods: ['putPage', 'transaction', 'readPageSnapshot', 'createVersion', 'getVersions'],
  }, async (engine) => {
    const slug = 'notes/purge-inline';
    await engine.putPage(slug, { type: 'note', title: 'Inline page', compiled_truth: 'Body as read.', timeline: '- 2026-01-01: began',
      frontmatter: { stage: 'read' } }, { sourceId: SRC });
    const revisions = await engine.transaction(async tx => {
      const preimage = await tx.readPageSnapshot(slug, { sourceId: SRC, includeDeleted: true });
      await tx.putPage(slug, { type: 'note', title: 'Inline page moved', compiled_truth: 'Body moved on.', timeline: '',
        frontmatter: { stage: 'moved' } }, { sourceId: SRC });
      const saved = await tx.createVersion(slug, { sourceId: SRC, preimage: preimage! });
      return { preimage: preimage!.revision, saved: saved.knowledge_revision ?? null };
    });
    const [v] = await engine.getVersions(slug, { sourceId: SRC, limit: 1 });
    return { revisionIsPreimage: revisions.saved === revisions.preimage, compiled_truth: v?.compiled_truth, timeline: v?.timeline ?? null,
      title: v?.title, frontmatter: v?.frontmatter, body_storage: v?.body_storage ?? null };
  });

  parityTest('createVersion with the purge preimage of a segmented page references the new generation with the preimage revision', {
    methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows',
      'flipBodyGeneration', 'setBodyStagingState', 'transaction', 'readPageSnapshot', 'createVersion', 'getVersions'],
  }, async (engine) => {
    const slug = 'notes/purge-segmented';
    const first = await publishSegmentedPage(engine, slug, [ONE, TWO]);
    const second = await stageGeneration(engine, { pageId: first.pageId, slug, genFrom: 2, texts: [ONE_B, TWO] });
    const revisions = await engine.transaction(async tx => {
      await tx.lockPageKeys([{ sourceId: SRC, slug }]);
      const preimage = await tx.readPageSnapshot(slug, { sourceId: SRC, includeDeleted: true });
      await tx.flipBodyGeneration(flipInput(first.pageId, 1, second.stagingId, [ONE_B, TWO], { closeOccurrences: first.occurrences, meta: pageMeta('Retitled by the flip') }));
      await tx.setBodyStagingState(second.stagingId, 'committed');
      const saved = await tx.createVersion(slug, { sourceId: SRC, preimage: preimage! });
      return { preimage: preimage!.revision, saved: saved.knowledge_revision ?? null };
    });
    const [v] = await engine.getVersions(slug, { sourceId: SRC, limit: 1 });
    return { revisionIsPreimage: revisions.saved === revisions.preimage, body_storage: v?.body_storage ?? null,
      body_generation: v?.body_generation ?? null, body_bytes: v?.body_bytes ?? null, compiled_truth: v?.compiled_truth ?? null,
      title: v?.title, frontmatter: v?.frontmatter };
  });

  parityTest('createVersion with a preimage of an older revision names no writer for it; with the current one, its writer', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transaction', 'applyTransactionSettings', 'putPage',
      'readPageSnapshot', 'createVersion', 'readVersionAttributions'],
  }, async (engine) => {
    const slug = 'notes/purge-attributed';
    const reqA = await admit(engine, 'a0000000-0000-4000-8000-0000000000a1', 'writer-a', slug);
    const reqB = await admit(engine, 'a0000000-0000-4000-8000-0000000000b2', 'writer-b', slug);
    const role = (req: string | null) => req === reqA ? 'reqA' : req === reqB ? 'reqB' : req;
    await as(engine, reqA, 'writer-a', tx => tx.putPage(slug, { type: 'note', title: 'Attributed', compiled_truth: 'v1', timeline: '' }, { sourceId: SRC }));
    const saved = await as(engine, reqB, 'writer-b', async tx => {
      const stale = await tx.readPageSnapshot(slug, { sourceId: SRC, includeDeleted: true });
      await tx.putPage(slug, { type: 'note', title: 'Attributed', compiled_truth: 'v2', timeline: '' }, { sourceId: SRC });
      const fresh = await tx.readPageSnapshot(slug, { sourceId: SRC, includeDeleted: true });
      return [await tx.createVersion(slug, { sourceId: SRC, preimage: stale! }), await tx.createVersion(slug, { sourceId: SRC, preimage: fresh! })];
    });
    const rows = await engine.readVersionAttributions(saved.map(v => ({ id: Number(v.id), page_id: Number(v.page_id) })));
    const byId = new Map(rows.map(r => [Number(r.id), r]));
    return saved.map(v => {
      const r = byId.get(Number(v.id));
      return { body: v.compiled_truth, written: role(r?.w_req ?? null), writer: r?.w_id ?? null, archived: role(r?.a_req ?? null), archiver: r?.a_id ?? null };
    });
  });

  parityTest('listPurgeVersionBodies reads the inline versions of the source that the purge redacts, in id order after the keyset', {
    methods: ['putPage', 'createVersion', 'getPage', 'listPurgeVersionBodies'],
  }, async (engine) => {
    const put = (slug: string, title: string, body: string, frontmatter: Record<string, unknown> = {}, timeline = '') =>
      engine.putPage(slug, { type: 'note', title, compiled_truth: body, timeline, frontmatter }, { sourceId: SRC });
    await put('notes/rewritten', 'Rewritten page', 'nothing to see');
    await put('notes/in-body', 'Body carrier', 'Today Alice Said "Tea" at noon');
    await put('notes/in-timeline', 'Timeline carrier', 'plain', {}, '- 2026-01-02: alice said "tea"');
    await put('notes/in-title', 'Why ALICE SAID "TEA"', 'plain');
    await put('notes/in-frontmatter', 'Frontmatter carrier', 'plain', { quote: 'Alice said "tea" today' });
    await put('notes/elsewhere', 'Unrelated', 'alice said tea, unquoted');
    for (const slug of ['notes/rewritten', 'notes/in-body', 'notes/in-timeline', 'notes/in-title', 'notes/in-frontmatter', 'notes/elsewhere']) {
      await engine.createVersion(slug, { sourceId: SRC });
    }
    const rewritten = await engine.getPage('notes/rewritten', { sourceId: SRC });
    const [needle, escaped] = claimNeedles('Alice said "tea"');
    const read = (after: number) => engine.listPurgeVersionBodies({ sourceId: SRC, pageIds: [Number(rewritten!.id)], after, needle, escaped });
    const all = await read(0);
    const view = (rows: PurgeVersionBodyRow[]) => rows.map(r => ({ slug: r.slug, compiled_truth: r.compiled_truth, timeline: r.timeline,
      metadata: r.metadata }));
    const ids = all.map(r => Number(r.id));
    return { all: view(all), ascending: ids.every((id, i) => i === 0 || id > ids[i - 1]!), afterFirst: view(await read(ids[0]!)),
      afterLast: view(await read(ids[ids.length - 1]!)) };
  });
});
