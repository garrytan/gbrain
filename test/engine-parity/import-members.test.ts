/**
 * BrainEngine parity — the import members: the page and chunk statements a page import runs around its chunk write
 * (engine-sql/pages.ts, engine-sql/chunks.ts, engine-sql/sources.ts): the safe-fence read, the origin refresh, the
 * derived alias replace, the chunker stamp, the source chunker read, the text projection seal, the in-place chunk
 * moves and the vector-reuse read.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: getPageSealState, refreshPageOrigin, replaceDerivedAliases, setChunkerVersion, readSourceChunkerVersion,
 *    writeTextProjectionSeal, moveChunkIndexes and getChunkReuseRows return the same observable result, and leave the
 *    same page, chunk and alias state, on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    through test/engine-parity/harness.ts).
 *  - Regression: an engine that answers one of these differently re-chunks a page it should keep, loses a page's
 *    file origin, drops a chunk's vector or span when it moves, seals a stale revision, or reuses a vector for changed
 *    text. The Rust engine has no SQL, so each statement has to exist as a typed member; until it does, an import on a
 *    Rust brain stops on the first of them.
 *  - Why existing coverage misses it: these members run inside import-file.ts, import-chunk-reuse.ts, mentions/pass.ts
 *    and page-state/*.ts, which no other parity case calls one by one.
 *  - Seam: none. Typed members only (no executeRaw: D18). Page and chunk ids are compared as "the row the case wrote";
 *    a refusal is compared by the Postgres message text it carries, not by its code. Not covered, as the arms differ by
 *    design (rust/docs/store/import-members.md): a call that ends with a chunk at a negative index, the state an alias
 *    refusal leaves outside a transaction, and the chunker version a body change writes after a seal.
 */
import { describe, expect } from 'bun:test';
import { basisEmbedding, parityArms } from './harness.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Import note', compiled_truth: 'An import example.', timeline: '' };
const STALE_REVISION = 'f0000000-0000-4000-8000-0000000000f1';

/** The id of live page `slug` of the default source. */
async function idOf(engine: BrainEngine, slug: string): Promise<number> {
  const page = await engine.getPage(slug);
  expect(page).not.toBeNull();
  return Number(page!.id);
}

/** 'ok' when `run` resolves, the first match of `pattern` in its message when it throws, else the message. */
async function outcome(run: () => Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return pattern.exec(message)?.[0] ?? message;
  }
}

describe('engine parity: import members', () => {
  parityTest('getPageSealState reads the chunker version of a live page, 0 before any, and null otherwise', {
    methods: ['putPage', 'getPage', 'setChunkerVersion', 'sealChunks', 'softDeletePage', 'getPageSealState'],
  }, async (engine) => {
    await engine.putPage('notes/seal-a', NOTE);
    const id = await idOf(engine, 'notes/seal-a');
    const fresh = await engine.getPageSealState(id);
    await engine.setChunkerVersion('notes/seal-a', 4);
    const stamped = await engine.getPageSealState(id);
    await installChunks(engine, 'notes/seal-a', [chunk(0, 'An import example.')]);
    const sealed = await engine.getPageSealState(id);
    const missing = await engine.getPageSealState(id + 100000);
    await engine.softDeletePage('notes/seal-a');
    const deleted = await engine.getPageSealState(id);
    const answers = { fresh, stamped, sealed, missing, deleted };
    expect(answers).toEqual({
      fresh: { chunker_version: 0 }, stamped: { chunker_version: 4 }, sealed: { chunker_version: 4 }, missing: null, deleted: null,
    });
    return answers;
  });

  parityTest('refreshPageOrigin sets a live page\'s path, keeps its uri when none is given, and skips a missing page', {
    methods: ['putPage', 'getPage', 'softDeletePage', 'refreshPageOrigin'],
  }, async (engine) => {
    await engine.putPage('notes/origin-a', NOTE);
    await engine.putPage('notes/origin-gone', { ...NOTE, source_path: 'gone.md' });
    await engine.softDeletePage('notes/origin-gone');
    const origin = async (slug: string) => {
      const page = await engine.getPage(slug, { includeDeleted: true });
      return page && [page.source_path ?? null, page.source_uri ?? null];
    };
    await engine.refreshPageOrigin('notes/origin-a', { sourceId: 'default', sourcePath: 'a.md', sourceUri: null });
    const first = await origin('notes/origin-a');
    await engine.refreshPageOrigin('notes/origin-a', { sourceId: 'default', sourcePath: 'b.md', sourceUri: 'file://b' });
    const withUri = await origin('notes/origin-a');
    await engine.refreshPageOrigin('notes/origin-a', { sourceId: 'default', sourcePath: 'c.md' });
    const keptUri = await origin('notes/origin-a');
    const missing = await outcome(() => engine.refreshPageOrigin('notes/never-written', { sourceId: 'default', sourcePath: 'x.md' }), /$^/);
    await engine.refreshPageOrigin('notes/origin-gone', { sourceId: 'default', sourcePath: 'back.md' });
    const tombstone = await origin('notes/origin-gone');
    const answers = { first, withUri, keptUri, missing, tombstone };
    expect(answers).toEqual({
      first: ['a.md', null], withUri: ['b.md', 'file://b'], keptUri: ['c.md', 'file://b'], missing: 'ok', tombstone: ['gone.md', null],
    });
    return answers;
  });

  parityTest('replaceDerivedAliases replaces only the declared and subject rows and refuses an unknown origin', {
    methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'resolveAliases'],
  }, async (engine) => {
    await engine.putPage('notes/alias-a', NOTE);
    await engine.setPageAliases('notes/alias-a', 'default', ['frontname']);
    await engine.replaceDerivedAliases('notes/alias-a', 'default', [
      { alias_norm: 'declname', origin: 'declared', case_sensitive: true, alias_text: 'DeclName' },
      { alias_norm: 'declname', origin: 'declared', case_sensitive: false, alias_text: 'declname' },
      { alias_norm: 'frontname', origin: 'frontmatter', case_sensitive: false, alias_text: 'FrontName' },
      { alias_norm: 'subjname', origin: 'subject', case_sensitive: false, alias_text: 'SubjName' },
    ]);
    const names = ['declname', 'frontname', 'subjname'];
    const view = async () => {
      const found = await engine.resolveAliases(names);
      return names.map((n) => (found.get(n) ?? []).map((r) => `${r.source_id}:${r.slug}`));
    };
    const replaced = await view();
    const badOrigin = await outcome(() => engine.replaceDerivedAliases('notes/alias-a', 'default', [
      { alias_norm: 'other', origin: 'weird', case_sensitive: false, alias_text: 'Other' },
    ]), /page_aliases_origin_check/);
    const emptyNoSource = await outcome(() => engine.replaceDerivedAliases('notes/alias-a', 'parity-missing', []), /$^/);
    await engine.replaceDerivedAliases('notes/alias-a', 'default', [
      { alias_norm: 'subjname', origin: 'subject', case_sensitive: false, alias_text: 'SubjName' },
    ]);
    const second = await view();
    await engine.replaceDerivedAliases('notes/alias-a', 'default', []);
    const cleared = await view();
    const answers = { replaced, badOrigin, emptyNoSource, second, cleared };
    const a = 'default:notes/alias-a';
    expect(answers).toEqual({
      replaced: [[a], [a], [a]], badOrigin: 'page_aliases_origin_check', emptyNoSource: 'ok',
      second: [[], [a], [a]], cleared: [[], [a], []],
    });
    return answers;
  });

  parityTest('setChunkerVersion stamps a page as a smallint and refuses what the cast refuses', {
    methods: ['putPage', 'getPage', 'setChunkerVersion', 'getPageSealState'],
  }, async (engine) => {
    await engine.putPage('notes/stamp-a', NOTE);
    const id = await idOf(engine, 'notes/stamp-a');
    const stamps: unknown[] = [];
    for (const version of [7, 40000, 1.5, -3]) {
      const result = await outcome(() => engine.setChunkerVersion('notes/stamp-a', version),
        /out of range for type smallint|invalid input syntax for type smallint/);
      stamps.push([version, result, (await engine.getPageSealState(id))?.chunker_version]);
    }
    const missing = await outcome(() => engine.setChunkerVersion('notes/never-written', 5), /$^/);
    const answers = { stamps, missing };
    expect(answers).toEqual({
      stamps: [
        [7, 'ok', 7],
        [40000, 'out of range for type smallint', 7],
        [1.5, 'invalid input syntax for type smallint', 7],
        [-3, 'ok', -3],
      ],
      missing: 'ok',
    });
    return answers;
  });

  parityTest('readSourceChunkerVersion is null for a source with no stamp and for an unknown source', {
    methods: ['putPage', 'readSourceChunkerVersion'],
  }, async (engine) => {
    await engine.putPage('notes/source-a', NOTE);
    const answers = {
      known: await engine.readSourceChunkerVersion('default'),
      unknown: await engine.readSourceChunkerVersion('parity-missing'),
    };
    expect(answers).toEqual({ known: null, unknown: null });
    return answers;
  });

  parityTest('writeTextProjectionSeal seals only the current revision, in any case, and refuses a non-uuid', {
    methods: ['putPage', 'readPageSnapshot', 'getPage', 'writeTextProjectionSeal'],
  }, async (engine) => {
    await engine.putPage('notes/text-a', NOTE);
    const snapshot = await engine.readPageSnapshot('notes/text-a', { sourceId: 'default' });
    const revision = snapshot!.revision;
    const sealed = async () => (await engine.getPage('notes/text-a'))?.text_projection_revision === revision;
    const before = await sealed();
    const seal = (rev: string) => engine.writeTextProjectionSeal('notes/text-a', { sourceId: 'default', revision: rev, timelineText: 'a timeline' });
    const bad = await outcome(() => seal('nope'), /invalid input syntax for type uuid/);
    await seal(STALE_REVISION);
    const stale = await sealed();
    await seal(revision.toUpperCase());
    const current = await sealed();
    const missing = await outcome(() => engine.writeTextProjectionSeal('notes/never-written',
      { sourceId: 'default', revision, timelineText: '' }), /$^/);
    const answers = { before, bad, stale, current, missing };
    expect(answers).toEqual({ before: false, bad: 'invalid input syntax for type uuid', stale: false, current: true, missing: 'ok' });
    return answers;
  });

  parityTest('moveChunkIndexes moves chunks wave by wave with their vectors and spans, and refuses a duplicate index', {
    methods: ['putPage', 'getPage', 'sealChunks', 'getChunks', 'moveChunkIndexes'],
  }, async (engine) => {
    // The last column is the index of the vector's one non-zero component: the vector moved with its chunk.
    await engine.putPage('notes/move-a', NOTE);
    await installChunks(engine, 'notes/move-a', [
      chunk(0, 'first chunk text', { embedding: basisEmbedding(1), embedding_input_hash: 'h0' }),
      chunk(1, 'second chunk text'),
    ]);
    const pageId = await idOf(engine, 'notes/move-a');
    const chunks = await engine.getChunks('notes/move-a', { includeUnsealed: true });
    const ids = new Map(chunks.map((c) => [Number(c.id), c.chunk_text]));
    const [first, second] = [...chunks].sort((x, y) => x.chunk_index - y.chunk_index).map((c) => Number(c.id));
    const view = async () => (await engine.getChunks('notes/move-a', { includeUnsealed: true, includeEmbedding: true }))
      .map((c) => [ids.get(Number(c.id)), c.chunk_index, c.projected_byte_start ?? null, c.projected_byte_end ?? null, c.embedded_at != null, c.embedding == null ? null : Array.from(c.embedding as ArrayLike<number>).findIndex((v) => v !== 0)])
      .sort((x, y) => (x[1] as number) - (y[1] as number));
    const duplicate = await outcome(() => engine.moveChunkIndexes(pageId, [[{ id: first!, from: 0, to: 1 }]]), /idx_chunks_page_index/);
    const afterDuplicate = await view();
    await engine.moveChunkIndexes(pageId, [
      [{ id: first!, from: 0, to: -2 }],
      [{ id: second!, from: 1, to: 0, projected_byte_start: 5, projected_byte_end: 9 }],
      [{ id: first!, from: -2, to: 1 }],
    ]);
    const swapped = await view();
    const unknown = await outcome(() => engine.moveChunkIndexes(pageId, [[{ id: 999999999, from: 0, to: 7 }]]), /$^/);
    const empty = await outcome(() => engine.moveChunkIndexes(pageId, []), /$^/);
    const answers = { duplicate, afterDuplicate, swapped, unknown, empty, after: await view() };
    expect(answers).toEqual({
      duplicate: 'idx_chunks_page_index',
      afterDuplicate: [['first chunk text', 0, null, null, true, 1], ['second chunk text', 1, null, null, false, null]],
      swapped: [['second chunk text', 0, 5, 9, false, null], ['first chunk text', 1, null, null, true, 1]],
      unknown: 'ok', empty: 'ok',
      after: [['second chunk text', 0, 5, 9, false, null], ['first chunk text', 1, null, null, true, 1]],
    });
    return answers;
  });

  parityTest('getChunkReuseRows reads each chunk\'s input hash, text-only and unembedded flags and the page mode', {
    methods: ['putPage', 'sealChunks', 'updatePageContextualRetrievalState', 'getChunkReuseRows'],
  }, async (engine) => {
    await engine.putPage('notes/reuse-a', NOTE);
    await installChunks(engine, 'notes/reuse-a', [
      chunk(0, 'an embedded chunk', { embedding: basisEmbedding(2), embedding_input_hash: 'h0' }),
      chunk(1, 'a bare chunk'),
    ]);
    const byIndex = (rows: Awaited<ReturnType<BrainEngine['getChunkReuseRows']>>) => [...rows].sort((x, y) => x.chunk_index - y.chunk_index);
    const plain = byIndex(await engine.getChunkReuseRows('notes/reuse-a'));
    await engine.updatePageContextualRetrievalState('notes/reuse-a', 'default', 'none', null);
    const withMode = byIndex(await engine.getChunkReuseRows('notes/reuse-a', { sourceId: 'default' }));
    const missing = await engine.getChunkReuseRows('notes/never-written');
    const answers = { plain, withMode: withMode.map((r) => r.contextual_retrieval_mode), missing };
    expect(answers).toEqual({
      plain: [
        { chunk_index: 0, embedding_input_hash: 'h0', contextual_retrieval_mode: null, text_only: true, unembedded: false },
        { chunk_index: 1, embedding_input_hash: null, contextual_retrieval_mode: null, text_only: false, unembedded: true },
      ],
      withMode: ['none', 'none'],
      missing: [],
    });
    return answers;
  });
});
