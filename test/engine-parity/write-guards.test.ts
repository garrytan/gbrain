/**
 * BrainEngine parity — the page write guards (engine-sql/write-guards.ts): the origin read, the origin claim read,
 * the origin bind, the ingest stamp, the import seal, the valid-time body read, the append path's tail-digest body
 * read, the page write gate's stored tier read and the segment storage probe.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readPageOrigin, listOriginClaims, bindPageOrigin, stampPageIngest, sealImportedPage, readLivePageBody,
 *    readInlinePageRegions, readStoredPageTier, readPageIndexingState and hasSegmentStorage return the same observable
 *    result, and leave the same page columns, on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust
 *    arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that answers one of these differently (a tombstone read as absent, a claim from a deleted
 *    page or from the page being written, a bind that overwrites an origin it was told to keep, a seal that moves the
 *    text projection of a stale revision) lets two pages claim one file or loses a page's provenance; the Rust engine
 *    has no SQL, so each statement has to exist as a typed member.
 *  - Why existing coverage misses it: these statements ran through `executeRaw` inside origin-guard.ts,
 *    page-prepare.ts, projections.ts, valid-time-advisory.ts, journal.ts, tail-digest.ts and trust/page-write.ts, which
 *    the parity cases cannot call (D18).
 *  - Seam: none in the cases. Typed members only (no executeRaw: D18). Page ids are compared as "the page putPage
 *    wrote", time stamps as presence.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Origin note', compiled_truth: 'An origin example.', timeline: '' };
const STALE_REVISION = 'f0000000-0000-4000-8000-0000000000f1';

/** The id of live page `slug` of the default source. */
async function idOf(engine: BrainEngine, slug: string): Promise<number> {
  const page = await engine.getPage(slug);
  expect(page).not.toBeNull();
  return Number(page!.id);
}

describe('engine parity: page write guards', () => {
  parityTest('readPageOrigin reads a page by id or slug, a tombstone included, and null otherwise', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'readPageOrigin'],
  }, async (engine) => {
    await engine.putPage('notes/origin-a', { ...NOTE, source_path: 'notes/origin-a.md' });
    await engine.putPage('notes/origin-b', NOTE);
    const id = await idOf(engine, 'notes/origin-a');
    const view = (row: Awaited<ReturnType<BrainEngine['readPageOrigin']>>) =>
      row && { sameId: Number(row.id) === id, slug: row.slug, source_path: row.source_path, deleted: row.deleted_at != null };
    const bySlug = view(await engine.readPageOrigin({ sourceId: 'default', slug: 'notes/origin-a' }));
    const byId = view(await engine.readPageOrigin({ sourceId: 'default', pageId: id }));
    const noOriginRow = await engine.readPageOrigin({ sourceId: 'default', slug: 'notes/origin-b' });
    const noOrigin = noOriginRow ? noOriginRow.source_path : 'absent';
    const otherSource = await engine.readPageOrigin({ sourceId: 'parity-missing', pageId: id });
    const missing = await engine.readPageOrigin({ sourceId: 'default', slug: 'notes/never-written' });
    const neither = await engine.readPageOrigin({ sourceId: 'default' });
    await engine.softDeletePage('notes/origin-a');
    const tombstone = view(await engine.readPageOrigin({ sourceId: 'default', slug: 'notes/origin-a' }));
    const answers = { bySlug, byId, noOrigin, otherSource, missing, neither, tombstone };
    expect(answers).toEqual({
      bySlug: { sameId: true, slug: 'notes/origin-a', source_path: 'notes/origin-a.md', deleted: false },
      byId: { sameId: true, slug: 'notes/origin-a', source_path: 'notes/origin-a.md', deleted: false },
      noOrigin: null, otherSource: null, missing: null, neither: null,
      tombstone: { sameId: true, slug: 'notes/origin-a', source_path: 'notes/origin-a.md', deleted: true },
    });
    return answers;
  });

  parityTest('listOriginClaims lists the live holders of any spelling, in slug order, without the excluded page', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'listOriginClaims'],
  }, async (engine) => {
    await engine.putPage('notes/claim-b', { ...NOTE, source_path: 'shared/claim.md' });
    await engine.putPage('notes/claim-a', { ...NOTE, source_path: 'legacy/shared/claim.md' });
    await engine.putPage('notes/claim-gone', { ...NOTE, source_path: 'gone/claim.md' });
    await engine.putPage('notes/claim-other', { ...NOTE, source_path: 'other/claim.md' });
    await engine.softDeletePage('notes/claim-gone');
    const spellings = ['shared/claim.md', 'legacy/shared/claim.md', 'gone/claim.md'];
    const lockKeys = ['legacy/shared/claim.md', 'shared/claim.md'];
    const all = await engine.listOriginClaims('default', spellings, { lockKeys });
    const withoutB = await engine.listOriginClaims('default', spellings, { lockKeys, excludePageId: await idOf(engine, 'notes/claim-b') });
    const none = await engine.listOriginClaims('default', ['nobody/claim.md'], { lockKeys: ['nobody/claim.md'] });
    const otherSource = await engine.listOriginClaims('parity-missing', spellings, { lockKeys: [] });
    const answers = { all, withoutB, none, otherSource };
    expect(answers).toEqual({
      all: [{ slug: 'notes/claim-a', source_path: 'legacy/shared/claim.md' }, { slug: 'notes/claim-b', source_path: 'shared/claim.md' }],
      withoutB: [{ slug: 'notes/claim-a', source_path: 'legacy/shared/claim.md' }],
      none: [], otherSource: [],
    });
    return answers;
  });

  parityTest('bindPageOrigin records an origin as told (only if unset, only if live) and counts the pages it changed', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'bindPageOrigin'],
  }, async (engine) => {
    await engine.putPage('notes/bind', NOTE);
    await engine.putPage('notes/bind-gone', NOTE);
    await engine.softDeletePage('notes/bind-gone');
    const id = await idOf(engine, 'notes/bind');
    const origin = async (slug: string) => (await engine.getPage(slug, { includeDeleted: true }))?.source_path ?? null;
    const unset = await engine.bindPageOrigin({ sourceId: 'default', slug: 'notes/bind', sourcePath: 'notes/bind.md', onlyIfUnset: true });
    const unsetAgain = await engine.bindPageOrigin({ sourceId: 'default', slug: 'notes/bind', sourcePath: 'moved/bind.md', onlyIfUnset: true });
    const afterUnset = await origin('notes/bind');
    const same = await engine.bindPageOrigin({ sourceId: 'default', pageId: id, sourcePath: 'notes/bind.md' });
    const moved = await engine.bindPageOrigin({ sourceId: 'default', pageId: id, sourcePath: 'moved/bind.md', liveOnly: true });
    const afterMove = await origin('notes/bind');
    const goneLive = await engine.bindPageOrigin({ sourceId: 'default', slug: 'notes/bind-gone', sourcePath: 'gone/bind.md', liveOnly: true });
    const gone = await engine.bindPageOrigin({ sourceId: 'default', slug: 'notes/bind-gone', sourcePath: 'gone/bind.md' });
    const afterGone = await origin('notes/bind-gone');
    const missing = await engine.bindPageOrigin({ sourceId: 'default', slug: 'notes/never-written', sourcePath: 'x.md' });
    const otherSource = await engine.bindPageOrigin({ sourceId: 'parity-missing', pageId: id, sourcePath: 'y.md' });
    const answers = { unset, unsetAgain, afterUnset, same, moved, afterMove, goneLive, gone, afterGone, missing, otherSource };
    expect(answers).toEqual({
      unset: 1, unsetAgain: 0, afterUnset: 'notes/bind.md', same: 0, moved: 1, afterMove: 'moved/bind.md',
      goneLive: 0, gone: 1, afterGone: 'gone/bind.md', missing: 0, otherSource: 0,
    });
    return answers;
  });

  parityTest('stampPageIngest stamps the source kind, the channel and the time on one page', {
    methods: ['putPage', 'getPage', 'stampPageIngest'],
  }, async (engine) => {
    await engine.putPage('notes/stamped', NOTE);
    await engine.putPage('notes/unstamped', NOTE);
    await engine.stampPageIngest('notes/stamped', { sourceId: 'default', sourceKind: 'import', ingestedVia: 'parity-import', ingestedAt: '2026-01-02T03:04:05.678Z' });
    await engine.stampPageIngest('notes/never-written', { sourceId: 'default', sourceKind: 'import', ingestedVia: 'parity-import', ingestedAt: '2026-01-02T03:04:05.678Z' });
    const view = async (slug: string) => {
      const page = await engine.getPage(slug);
      return { kind: page?.source_kind ?? null, via: page?.ingested_via ?? null, at: page?.ingested_at ? new Date(page.ingested_at).toISOString() : null };
    };
    const answers = { stamped: await view('notes/stamped'), unstamped: await view('notes/unstamped') };
    expect(answers.stamped).toEqual({ kind: 'import', via: 'parity-import', at: '2026-01-02T03:04:05.678Z' });
    return answers;
  });

  parityTest('sealImportedPage seals the text projection of the current revision only, and returns the page id', {
    methods: ['putPage', 'getPage', 'readPageSnapshot', 'sealImportedPage'],
  }, async (engine) => {
    await engine.putPage('notes/sealed', { ...NOTE, timeline: '- 2026-01-02: sealed' });
    await engine.putPage('notes/stale', NOTE);
    const id = await idOf(engine, 'notes/sealed');
    const snapshot = await engine.readPageSnapshot('notes/sealed', { sourceId: 'default' });
    const projection = async (slug: string) => (await engine.getPage(slug))?.text_projection_revision ?? null;
    const staleBefore = await projection('notes/stale');
    const sealed = await engine.sealImportedPage('notes/sealed', { sourceId: 'default', revision: snapshot!.revision, timelineText: '- 2026-01-02: sealed', chunkerVersion: 3 });
    const stale = await engine.sealImportedPage('notes/stale', { sourceId: 'default', revision: STALE_REVISION, timelineText: '', chunkerVersion: 3 });
    const noRevision = await engine.sealImportedPage('notes/stale', { sourceId: 'default', revision: null, timelineText: '', chunkerVersion: 3 });
    const missing = await engine.sealImportedPage('notes/never-written', { sourceId: 'default', revision: null, timelineText: '', chunkerVersion: 3 });
    const answers = {
      sealedId: sealed?.id === id, sealedProjection: (await projection('notes/sealed')) === snapshot!.revision,
      staleFound: stale != null, staleKept: (await projection('notes/stale')) === staleBefore, noRevisionFound: noRevision != null, missing,
    };
    expect(answers).toEqual({ sealedId: true, sealedProjection: true, staleFound: true, staleKept: true, noRevisionFound: true, missing: null });
    return answers;
  });

  parityTest('readLivePageBody reads a live page\'s frontmatter, body, storage and content hash, and null otherwise', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'readLivePageBody'],
  }, async (engine) => {
    await engine.putPage('notes/body', { ...NOTE, timeline: '- 2026-01-02: body', frontmatter: { valid_from: '2026-01-01' } });
    await engine.putPage('notes/body-gone', NOTE);
    await engine.softDeletePage('notes/body-gone');
    const row = await engine.readLivePageBody('notes/body', { sourceId: 'default' });
    const page = await engine.getPage('notes/body');
    const frontmatter = typeof row?.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row?.frontmatter;
    const answers = {
      body: row && { frontmatter, compiled_truth: row.compiled_truth, timeline: row.timeline, body_storage: row.body_storage, hashIsPages: row.content_hash === page?.content_hash && !!row.content_hash },
      gone: await engine.readLivePageBody('notes/body-gone', { sourceId: 'default' }),
      otherSource: await engine.readLivePageBody('notes/body', { sourceId: 'parity-missing' }),
    };
    expect(answers).toEqual({
      body: { frontmatter: { valid_from: '2026-01-01' }, compiled_truth: 'An origin example.', timeline: '- 2026-01-02: body', body_storage: 'inline', hashIsPages: true },
      gone: null, otherSource: null,
    });
    return answers;
  });

  parityTest('readPageIndexingState reads the chunker version, corpus generation and page kind of a page, tombstones included', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'readPageIndexingState'],
  }, async (engine) => {
    await engine.putPage('notes/index-cr', NOTE, { contextualRetrieval: { mode: 'title', corpusGeneration: 'gen-1' } });
    await engine.putPage('notes/index-plain', NOTE);
    await engine.putPage('notes/index-gone', NOTE);
    const goneId = await idOf(engine, 'notes/index-gone');
    await engine.softDeletePage('notes/index-gone');
    const answers = {
      cr: await engine.readPageIndexingState(await idOf(engine, 'notes/index-cr')),
      plain: await engine.readPageIndexingState(await idOf(engine, 'notes/index-plain')),
      gone: await engine.readPageIndexingState(goneId),
      missing: await engine.readPageIndexingState(987654321),
    };
    expect({
      crGeneration: answers.cr?.corpus_generation, crKind: answers.cr?.page_kind,
      plainGeneration: answers.plain?.corpus_generation, plainKind: answers.plain?.page_kind,
      goneKind: answers.gone?.page_kind, missing: answers.missing,
    }).toEqual({ crGeneration: 'gen-1', crKind: 'markdown', plainGeneration: null, plainKind: 'markdown', goneKind: 'markdown', missing: null });
    return answers;
  });

  parityTest('readInlinePageRegions reads a page\'s stored body columns by id, a tombstone included, and null otherwise', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'readInlinePageRegions'],
  }, async (engine) => {
    await engine.putPage('notes/regions', { ...NOTE, timeline: '- 2026-01-02: a region' });
    await engine.putPage('notes/regions-gone', { ...NOTE, compiled_truth: 'A deleted body.' });
    const id = await idOf(engine, 'notes/regions');
    const goneId = await idOf(engine, 'notes/regions-gone');
    await engine.softDeletePage('notes/regions-gone');
    const answers = {
      live: await engine.readInlinePageRegions(id),
      tombstone: await engine.readInlinePageRegions(goneId),
      missing: await engine.readInlinePageRegions(id + goneId + 1000),
    };
    expect(answers).toEqual({
      live: { compiled_truth: 'An origin example.', timeline: '- 2026-01-02: a region' },
      tombstone: { compiled_truth: 'A deleted body.', timeline: '' },
      missing: null,
    });
    return answers;
  });

  parityTest('readStoredPageTier reads the tier a page write stamped by source and slug, a tombstone included, and null otherwise', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'softDeletePage', 'readStoredPageTier'],
  }, async (engine) => {
    await engine.transaction(async (tx) => {
      await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], ['operator_curated', JSON.stringify({ channel: 'import' })]);
      await tx.putPage('notes/tier', NOTE);
    });
    await engine.putPage('notes/tier-plain', NOTE);
    await engine.transaction(async (tx) => {
      await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], ['agent_written', JSON.stringify({ channel: 'agent' })]);
      await tx.putPage('notes/tier-gone', NOTE);
    });
    await engine.softDeletePage('notes/tier-gone');
    const answers = {
      curated: await engine.readStoredPageTier('default', 'notes/tier'),
      plain: await engine.readStoredPageTier('default', 'notes/tier-plain'),
      tombstone: await engine.readStoredPageTier('default', 'notes/tier-gone'),
      missing: await engine.readStoredPageTier('default', 'notes/tier-missing'),
      otherSource: await engine.readStoredPageTier('parity-missing', 'notes/tier'),
    };
    expect(answers).toEqual({ curated: 'operator_curated', plain: 'unknown', tombstone: 'unknown', missing: null, otherSource: null });
    return answers;
  });

  parityTest('hasSegmentStorage is false on a brain that stores no segmented page', { methods: ['putPage', 'hasSegmentStorage'] }, async (engine) => {
    const empty = await engine.hasSegmentStorage();
    await engine.putPage('notes/inline', NOTE);
    const inline = await engine.hasSegmentStorage();
    expect({ empty, inline }).toEqual({ empty: false, inline: false });
    return { empty, inline };
  });
});
