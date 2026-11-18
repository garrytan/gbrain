/**
 * BrainEngine parity: the chunk reads and deletes of engine-sql/chunk-reads.ts,
 * which code-def, code-refs, doctor, code readiness, the recursive code walk,
 * withdrawal, the page projection, repair contextual-mode and evidence
 * delivery used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts): definition and reference rows, symbol
 *    types, doctor counts, code readiness, qualified names, withdrawal chunks,
 *    the chunks two deletes leave, contextual-mode candidates and frozen hits.
 *  - Regression: an engine whose read drifts gives a different code-def or
 *    code-refs answer, doctor finding, readiness status, walk candidate,
 *    withdrawal target, kept chunk set, repair plan or delivered hit per backend.
 *  - Why existing coverage misses it: the caller tests run these reads on
 *    PGLite only and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw). Page and chunk ids are
 *    serial and engine-dependent, so every case maps them back to slugs and
 *    chunk indexes. Fixtures have no ties where the SQL leaves the row order to
 *    the plan; reads whose order the SQL does not fix are compared sorted.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput, PageInput } from '../../src/core/types.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

function codePage(slug: string, extra: Partial<PageInput> = {}): PageInput {
  return { type: 'code', page_kind: 'code', title: slug, compiled_truth: `${slug} source`, timeline: '', frontmatter: { file: `${slug}.ts` }, ...extra };
}

function sym(i: number, text: string, name: string | null, type: string | null, extra: Partial<ChunkInput> = {}): ChunkInput {
  return chunk(i, text, {
    language: 'typescript', symbol_name: name ?? undefined, symbol_type: type ?? undefined,
    symbol_name_qualified: name ? `mod.${name}` : undefined, start_line: 10 * (i + 1), end_line: 10 * (i + 1) + 5, ...extra,
  } as Partial<ChunkInput>);
}

/** A sealed code page with these chunks. */
async function sealedCode(engine: BrainEngine, slug: string, chunks: ChunkInput[], sourceId?: string, extra: Partial<PageInput> = {}) {
  const opts = sourceId ? { sourceId } : undefined;
  await engine.putPage(slug, codePage(slug, extra), opts);
  await installChunks(engine, slug, chunks, opts);
}

/** Chunk id -> `slug#index` for these pages (unsealed chunks included). */
async function chunkLabels(engine: BrainEngine, pages: Array<[string, string?]>): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const [slug, sourceId] of pages) {
    for (const c of await engine.getChunks(slug, { sourceId, includeUnsealed: true })) out.set(c.id, `${sourceId ?? 'default'}:${slug}#${c.chunk_index}`);
  }
  return out;
}

async function codeFixture(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  await createSource(engine, backend, 'other');
  await sealedCode(engine, 'src/b', [
    sym(0, 'export function run() { helper(); }', 'run', 'export statement'),
    sym(1, 'function run() { helper(); }', 'run', 'function'),
    sym(2, 'const runner = run;', 'runner', 'variable'),
    sym(3, 'class Run {}', 'run', 'class', { start_line: undefined, end_line: undefined } as Partial<ChunkInput>),
  ]);
  await sealedCode(engine, 'src/a', [
    sym(0, 'function run() {}', 'run', 'function', { language: 'python' } as Partial<ChunkInput>),
    sym(1, 'helper() // calls run', 'helper', 'method'),
    sym(2, 'no symbol here, RUN', null, null),
  ]);
  await sealedCode(engine, 'src/c', [sym(0, 'function run() { return 1; }', 'run', 'function')], 'other');
  await sealedCode(engine, 'src/gone', [sym(0, 'function run() {}', 'run', 'function')]);
  await engine.softDeletePage('src/gone');
  // Unsealed: stored chunks, but not served.
  await engine.putPage('src/unsealed', codePage('src/unsealed'));
  await engine.upsertChunks('src/unsealed', [sym(0, 'function run() {}', 'run', 'function')]);
  // A markdown page with a chunk named run is not a code page.
  await engine.putPage('notes/run', { type: 'note', title: 'run', compiled_truth: 'run', timeline: '' });
  await installChunks(engine, 'notes/run', [sym(0, 'function run() {}', 'run', 'function')]);
}

describe('engine parity: chunk reads', () => {
  parityTest(
    'findCodeDefinitions, listSymbolTypesForName and findCodeRefChunks read served code chunks in scope, in master order',
    { methods: ['putPage', 'sealChunks', 'upsertChunks', 'softDeletePage', 'findCodeDefinitions', 'listSymbolTypesForName', 'findCodeRefChunks'] },
    async (engine, backend) => {
      await codeFixture(engine, backend);
      const defs = {
        all: await engine.findCodeDefinitions('run', { allSources: true }),
        def: await engine.findCodeDefinitions('run', { sourceId: 'default' }),
        other: await engine.findCodeDefinitions('run', { sourceIds: ['other'] }),
        none: await engine.findCodeDefinitions('run', { sourceIds: [] }),
        python: await engine.findCodeDefinitions('run', { language: 'python', allSources: true }),
        top: await engine.findCodeDefinitions('run', { limit: 2, allSources: true }),
        allSourcesWins: await engine.findCodeDefinitions('run', { sourceId: 'other', allSources: true }),
        missing: await engine.findCodeDefinitions('nope'),
      };
      const types = {
        run: await engine.listSymbolTypesForName('run', { allSources: true }),
        runner: await engine.listSymbolTypesForName('runner', { sourceId: 'default' }),
        other: await engine.listSymbolTypesForName('runner', { sourceId: 'other' }),
        none: await engine.listSymbolTypesForName('run', { sourceIds: [] }),
      };
      // A chunk with no start line ahead of one with a line, on one page: the line order puts NULL last.
      await sealedCode(engine, 'src/e', [
        sym(0, 'run with no line', 'q', 'function', { start_line: undefined, end_line: undefined } as Partial<ChunkInput>),
        sym(1, 'run on a line', 'r', 'function'),
      ]);
      const refs = {
        all: await engine.findCodeRefChunks('run', { allSources: true }),
        def: await engine.findCodeRefChunks('helper', { sourceId: 'default' }),
        top: await engine.findCodeRefChunks('run', { limit: 3, allSources: true }),
        ts: await engine.findCodeRefChunks('run', { language: 'typescript', sourceIds: ['default', 'other'] }),
        none: await engine.findCodeRefChunks('run', { sourceIds: [] }),
      };
      expect(defs.all.map(r => `${r.source_id}:${r.slug}:${r.symbol_type}`)).toEqual([
        'default:src/a:function', 'default:src/b:function', 'other:src/c:function', 'default:src/b:class', 'default:src/b:export statement',
      ]);
      expect(types.run).toEqual(['class', 'export statement', 'function']);
      expect(refs.all.map(r => `${r.slug}#${r.start_line}`)).toEqual(['src/a#10', 'src/a#20', 'src/a#30', 'src/b#10', 'src/b#20', 'src/b#30', 'src/b#null', 'src/c#10', 'src/e#20', 'src/e#null']);
      return { defs, types, refs };
    },
  );

  parityTest(
    'countOversizedEmbedSkips, countOrphanChunks and countCodeChunkPages count what doctor reports',
    { methods: ['putPage', 'sealChunks', 'softDeletePage', 'deletePage', 'countOversizedEmbedSkips', 'countOrphanChunks', 'countCodeChunkPages'] },
    async (engine) => {
      const before = { skips: await engine.countOversizedEmbedSkips(100), orphans: await engine.countOrphanChunks(), code: await engine.countCodeChunkPages() };
      const skip = { embed_skip: { reason: 'oversized' } };
      await engine.putPage('notes/fits-chunkless', { type: 'note', title: 't', compiled_truth: 'x'.repeat(40), timeline: 'y'.repeat(20), frontmatter: skip });
      await engine.putPage('notes/fits-chunked', { type: 'note', title: 't', compiled_truth: 'small', timeline: '', frontmatter: skip });
      await installChunks(engine, 'notes/fits-chunked', [chunk(0, 'small')]);
      await engine.putPage('notes/too-big', { type: 'note', title: 't', compiled_truth: 'z'.repeat(200), timeline: '', frontmatter: skip });
      await engine.putPage('notes/other-reason', { type: 'note', title: 't', compiled_truth: 'w', timeline: '', frontmatter: { embed_skip: { reason: 'manual' } } });
      await engine.putPage('notes/gone', { type: 'note', title: 't', compiled_truth: 'g', timeline: '', frontmatter: skip });
      await engine.softDeletePage('notes/gone');
      await engine.putPage('notes/multibyte', { type: 'note', title: 't', compiled_truth: 'é'.repeat(45), timeline: '', frontmatter: skip });
      // Code pages: chunks with neither symbol_name nor language count; a deleted page and a non-code page do not.
      await sealedCode(engine, 'src/bare', [chunk(0, 'a'), chunk(1, 'b'), sym(2, 'function f() {}', 'f', 'function')]);
      await sealedCode(engine, 'src/lang-only', [chunk(0, 'c', { language: 'go' } as Partial<ChunkInput>)]);
      await sealedCode(engine, 'src/bare-gone', [chunk(0, 'd')]);
      await engine.softDeletePage('src/bare-gone');
      await sealedCode(engine, 'src/bare-two', [chunk(0, 'e')]);
      await engine.putPage('notes/bare', { type: 'note', title: 't', compiled_truth: 'f', timeline: '' });
      await installChunks(engine, 'notes/bare', [chunk(0, 'f')]);
      await engine.deletePage('src/bare-two');
      const after = {
        skips: await engine.countOversizedEmbedSkips(100),
        tight: await engine.countOversizedEmbedSkips(60),
        orphans: await engine.countOrphanChunks(),
        code: await engine.countCodeChunkPages(),
      };
      expect(before).toEqual({ skips: { marked: 0, chunkless: 0 }, orphans: 0, code: { chunks: 0, pages: 0 } });
      expect(after.skips).toEqual({ marked: 3, chunkless: 2 });
      expect(after.tight).toEqual({ marked: 2, chunkless: 1 });
      expect(after.code).toEqual({ chunks: 2, pages: 1 });
      return { before, after };
    },
  );

  parityTest(
    'codeChunksExist sees any stored code chunk; currentCodeChunksExist sees served ones, optionally with a symbol',
    { methods: ['putPage', 'sealChunks', 'upsertChunks', 'softDeletePage', 'codeChunksExist', 'currentCodeChunksExist'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await createSource(engine, backend, 'third');
      const empty = { stored: await engine.codeChunksExist(undefined), current: await engine.currentCodeChunksExist({}, 'any') };
      // default: an unsealed code page only.
      await engine.putPage('src/unsealed', codePage('src/unsealed'));
      await engine.upsertChunks('src/unsealed', [sym(0, 'function f() {}', 'f', 'function')]);
      // other: a sealed code page with no symbols.
      await sealedCode(engine, 'src/plain', [chunk(0, 'text')], 'other');
      // third: a sealed code page with a symbol, deleted.
      await sealedCode(engine, 'src/gone', [sym(0, 'function g() {}', 'g', 'function')], 'third');
      await engine.softDeletePage('src/gone', { sourceId: 'third' });
      const read = async (scope: Parameters<BrainEngine['currentCodeChunksExist']>[0]) => ({
        any: await engine.currentCodeChunksExist(scope, 'any'),
        symbol: await engine.currentCodeChunksExist(scope, 'with_symbol'),
      });
      const result = {
        empty,
        stored: {
          all: await engine.codeChunksExist(undefined),
          def: await engine.codeChunksExist('default'),
          third: await engine.codeChunksExist('third'),
          other: await engine.codeChunksExist(undefined, { sourceIds: ['other'] }),
          none: await engine.codeChunksExist(undefined, { sourceIds: [] }),
        },
        current: {
          all: await read({}),
          def: await read({ sourceId: 'default' }),
          other: await read({ sourceId: 'other' }),
          third: await read({ sourceIds: ['third'] }),
          none: await read({ sourceIds: [] }),
          allSources: await read({ sourceId: 'default', allSources: true }),
        },
      };
      // Seal a symbol in default: now served with a symbol.
      await sealedCode(engine, 'src/sym', [sym(0, 'function h() {}', 'h', 'function')]);
      const sealed = await read({ sourceId: 'default' });
      expect(result.stored.def).toBe(true);
      expect(result.current.def).toEqual({ any: false, symbol: false });
      expect(result.current.other).toEqual({ any: true, symbol: false });
      expect(sealed).toEqual({ any: true, symbol: true });
      return { ...result, sealed };
    },
  );

  parityTest(
    'listQualifiedSymbolNames: exact bare or qualified names, or names containing the text, served pages of one source, sorted',
    { methods: ['putPage', 'sealChunks', 'upsertChunks', 'softDeletePage', 'listQualifiedSymbolNames'] },
    async (engine, backend) => {
      await codeFixture(engine, backend);
      await sealedCode(engine, 'src/d', [
        sym(0, 'x', 'Run', 'function', { symbol_name_qualified: 'Other.Run' } as Partial<ChunkInput>),
        sym(1, 'y', 'go', 'function', { symbol_name_qualified: 'mod.run' } as Partial<ChunkInput>),
        sym(2, 'z', 'zz', 'function', { symbol_name_qualified: 'a.runAll' } as Partial<ChunkInput>),
      ]);
      const out = {
        exact: await engine.listQualifiedSymbolNames('default', 'run', { match: 'exact', limit: 25 }),
        qualified: await engine.listQualifiedSymbolNames('default', 'mod.helper', { match: 'exact', limit: 25 }),
        contains: await engine.listQualifiedSymbolNames('default', 'RUN', { match: 'contains', limit: 5 }),
        top: await engine.listQualifiedSymbolNames('default', 'run', { match: 'contains', limit: 2 }),
        other: await engine.listQualifiedSymbolNames('other', 'run', { match: 'exact', limit: 25 }),
        // `runner` lives only in default: the other source has none.
        otherOnly: await engine.listQualifiedSymbolNames('other', 'runner', { match: 'exact', limit: 25 }),
        missing: await engine.listQualifiedSymbolNames('default', 'nope', { match: 'contains', limit: 5 }),
      };
      expect(out.exact).toEqual(['mod.run']);
      expect(out.contains).toEqual(['Other.Run', 'a.runAll', 'mod.run', 'mod.runner']);
      expect(out.otherOnly).toEqual([]);
      return out;
    },
  );

  parityTest(
    'listWithdrawalChunks: chunks of one source whose lowered text matches every pattern of a key for the page, by id after a cursor',
    { methods: ['putPage', 'sealChunks', 'getChunks', 'listWithdrawalChunks'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const note = (slug: string, sourceId?: string) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '' }, sourceId ? { sourceId } : undefined);
      await note('people/alice-example');
      await installChunks(engine, 'people/alice-example', [chunk(0, 'Alice likes TEA and cake'), chunk(1, 'alice likes coffee'), chunk(2, 'tea_time 100%')]);
      await note('people/bob-example');
      await installChunks(engine, 'people/bob-example', [chunk(0, 'Bob likes tea'), chunk(1, 'nothing')]);
      await note('people/alice-example', 'other');
      await installChunks(engine, 'people/alice-example', [chunk(0, 'alice likes tea')], { sourceId: 'other' });
      const labels = await chunkLabels(engine, [['people/alice-example'], ['people/bob-example'], ['people/alice-example', 'other']]);
      const view = (rows: Awaited<ReturnType<BrainEngine['listWithdrawalChunks']>>) => rows.map(r => ({ label: labels.get(r.id), slug: r.slug, text: r.chunk_text, samePage: labels.get(r.id)?.includes(r.slug) }));
      const tea = [{ subject: '*', patterns: ['%likes%', '%tea%'] }];
      const all = await engine.listWithdrawalChunks('default', tea, { after: 0, limit: 100, subjects: null });
      const firstPage = await engine.listWithdrawalChunks('default', tea, { after: 0, limit: 1, subjects: null });
      const rest = await engine.listWithdrawalChunks('default', tea, { after: firstPage[0]!.id, limit: 100, subjects: null });
      const scoped = await engine.listWithdrawalChunks('default', [{ subject: 'people/bob-example', patterns: ['%tea%'] }], { after: 0, limit: 100, subjects: ['people/bob-example'] });
      const subjectMismatch = await engine.listWithdrawalChunks('default', [{ subject: 'people/bob-example', patterns: ['%alice%'] }], { after: 0, limit: 100, subjects: null });
      const escaped = await engine.listWithdrawalChunks('default', [{ subject: '*', patterns: ['%tea\\_time%', '%100\\%%'] }], { after: 0, limit: 100, subjects: null });
      const noPatterns = await engine.listWithdrawalChunks('default', [{ subject: 'people/bob-example', patterns: [] }], { after: 0, limit: 100, subjects: null });
      const other = await engine.listWithdrawalChunks('other', tea, { after: 0, limit: 100, subjects: null });
      expect(view(all).map(r => r.label)).toEqual(['default:people/alice-example#0', 'default:people/bob-example#0']);
      expect(view(noPatterns).map(r => r.label)).toEqual(['default:people/bob-example#0', 'default:people/bob-example#1']);
      return {
        all: view(all), firstPage: view(firstPage), rest: view(rest), scoped: view(scoped), subjectMismatch: view(subjectMismatch),
        escaped: view(escaped), noPatterns: view(noPatterns), other: view(other),
      };
    },
  );

  parityTest(
    'deleteChunksForPages and deleteChunksExcept remove exactly the named chunks, of the named page and source',
    { methods: ['putPage', 'sealChunks', 'getPage', 'getChunks', 'deleteChunksForPages', 'deleteChunksExcept'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const note = (slug: string, sourceId?: string) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '' }, sourceId ? { sourceId } : undefined);
      const three = [chunk(0, 'zero'), chunk(1, 'one'), chunk(2, 'two')];
      await note('notes/a');
      await installChunks(engine, 'notes/a', three);
      await note('notes/b');
      await installChunks(engine, 'notes/b', three);
      await note('notes/c');
      await installChunks(engine, 'notes/c', three);
      await note('notes/a', 'other');
      await installChunks(engine, 'notes/a', three, { sourceId: 'other' });
      const indexes = async (slug: string, sourceId?: string) => (await engine.getChunks(slug, { sourceId })).map(c => c.chunk_index);
      const ids = async (slug: string, sourceId?: string) => (await engine.getChunks(slug, { sourceId })).map(c => c.id);
      const pageB = (await engine.getPage('notes/b'))!.id;
      await engine.deleteChunksForPages([pageB, 999_999]);
      await engine.deleteChunksForPages([]);
      const [, keepOne] = await ids('notes/a');
      await engine.deleteChunksExcept('notes/a', [keepOne!]);
      const otherIds = await ids('notes/a', 'other');
      await engine.deleteChunksExcept('notes/a', [otherIds[0]!, otherIds[2]!], { sourceId: 'other' });
      await engine.deleteChunksExcept('NOTES/C', []);
      await engine.deleteChunksExcept('notes/missing', []);
      const out = {
        a: await indexes('notes/a'),
        b: await indexes('notes/b'),
        c: await indexes('notes/c'),
        otherA: await indexes('notes/a', 'other'),
      };
      expect(out).toEqual({ a: [1], b: [], c: [0, 1, 2], otherA: [0, 2] });
      // A delete keeps the page's sealed projection: the kept chunks stay served.
      const pageAfter = await engine.getPage('notes/a');
      return { ...out, sealedA: pageAfter?.text_projection_revision === pageAfter?.knowledge_revision };
    },
  );

  parityTest(
    'listContextualModeCandidates: live markdown pages of the sources with no contextual mode, sealed or not, embed_skip and chunk characters',
    { methods: ['putPage', 'sealChunks', 'upsertChunks', 'softDeletePage', 'getPage', 'listContextualModeCandidates'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await createSource(engine, backend, 'third');
      const note = (slug: string, frontmatter: Record<string, unknown> = {}, sourceId?: string) =>
        engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '', frontmatter }, sourceId ? { sourceId } : undefined);
      await note('notes/sealed');
      await installChunks(engine, 'notes/sealed', [chunk(0, 'héllo'), chunk(1, 'world!')]);
      await note('notes/unsealed');
      await engine.upsertChunks('notes/unsealed', [chunk(0, 'abc')]);
      await note('notes/skip', { embed_skip: { reason: 'manual' } });
      await installChunks(engine, 'notes/skip', [chunk(0, 'abcd')]);
      await note('notes/no-chunks');
      await note('notes/gone');
      await engine.softDeletePage('notes/gone');
      // Sealed, then edited: the edit clears the projection seal, so the page reads as not sealed (NULL).
      await note('notes/stale');
      await installChunks(engine, 'notes/stale', [chunk(0, 'old')]);
      await engine.putPage('notes/stale', { type: 'note', title: 'notes/stale', compiled_truth: 'notes/stale edited', timeline: '' });
      await sealedCode(engine, 'src/code', [chunk(0, 'code')]);
      await note('notes/other', {}, 'other');
      await installChunks(engine, 'notes/other', [chunk(0, 'xy')], { sourceId: 'other' });
      await note('notes/third', {}, 'third');
      const slugOf = new Map<number, string>();
      for (const [slug, sourceId] of [['notes/sealed'], ['notes/unsealed'], ['notes/skip'], ['notes/no-chunks'], ['notes/stale'], ['notes/other', 'other'], ['notes/third', 'third']] as Array<[string, string?]>) {
        const page = await engine.getPage(slug, sourceId ? { sourceId } : undefined);
        if (page) slugOf.set(page.id, `${sourceId ?? 'default'}:${slug}`);
      }
      const view = (rows: Awaited<ReturnType<BrainEngine['listContextualModeCandidates']>>) =>
        rows.map(r => ({ page: slugOf.get(r.id), source_id: r.source_id, slug: r.slug, sealed: r.sealed, embed_skip: r.embed_skip, chars: r.chars }));
      const out = {
        both: view(await engine.listContextualModeCandidates(['default', 'other'])),
        third: view(await engine.listContextualModeCandidates(['third'])),
        none: view(await engine.listContextualModeCandidates([])),
      };
      expect(out.both.find(r => r.slug === 'notes/sealed')).toMatchObject({ sealed: true, embed_skip: false, chars: 11 });
      expect(out.both.find(r => r.slug === 'notes/stale')).toMatchObject({ sealed: null, chars: 3 });
      return out;
    },
  );

  parityTest(
    'resolveFrozenHits: the page row of each hit in scope, with the named chunk (or the first for chunk 0) when the page holds it',
    { methods: ['putPage', 'sealChunks', 'upsertChunks', 'softDeletePage', 'getChunks', 'resolveFrozenHits'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const note = (slug: string, sourceId?: string, extra: Partial<PageInput> = {}) =>
        engine.putPage(slug, { type: 'note', title: `T ${slug}`, compiled_truth: slug, timeline: '', ...extra }, sourceId ? { sourceId } : undefined);
      await note('notes/a', undefined, { frontmatter: { date: '2026-03-04' }, effective_date: new Date('2026-03-04T00:00:00Z'), effective_date_source: 'date' });
      await installChunks(engine, 'notes/a', [chunk(0, 'a zero'), chunk(1, 'a one', { chunk_source: 'timeline' })]);
      await note('notes/b', 'other');
      await installChunks(engine, 'notes/b', [chunk(0, 'b zero')], { sourceId: 'other' });
      await note('notes/no-chunks');
      await installChunks(engine, 'notes/no-chunks', []);
      await note('notes/unsealed');
      await engine.upsertChunks('notes/unsealed', [chunk(0, 'u zero')]);
      await note('notes/gone');
      await installChunks(engine, 'notes/gone', [chunk(0, 'g')]);
      await engine.softDeletePage('notes/gone');
      const labels = await chunkLabels(engine, [['notes/a'], ['notes/b', 'other']]);
      const idOf = (label: string) => [...labels.entries()].find(([, l]) => l === label)![0];
      const hits = [
        { source_id: 'default', slug: 'notes/a', chunk_id: idOf('default:notes/a#1'), ord: 0 },
        { source_id: 'default', slug: 'notes/a', chunk_id: 0, ord: 1 },
        { source_id: 'other', slug: 'notes/b', chunk_id: idOf('other:notes/b#0'), ord: 2 },
        { source_id: 'default', slug: 'notes/a', chunk_id: idOf('other:notes/b#0'), ord: 3 },
        { source_id: 'default', slug: 'notes/no-chunks', chunk_id: 0, ord: 4 },
        { source_id: 'default', slug: 'notes/unsealed', chunk_id: 0, ord: 5 },
        { source_id: 'default', slug: 'notes/gone', chunk_id: 0, ord: 6 },
        { source_id: 'default', slug: 'notes/missing', chunk_id: 0, ord: 7 },
        // A negative chunk id falls to the CASE's ELSE: the page's first chunk (the caller marks it unresolved).
        { source_id: 'default', slug: 'notes/a', chunk_id: -1, ord: 8 },
      ];
      const view = (rows: Awaited<ReturnType<BrainEngine['resolveFrozenHits']>>) => sorted(rows.map(r => ({
        ord: r.ord, page: `${r.source_id}:${r.slug}`, title: r.title, type: r.type,
        effective_date: r.effective_date === null ? null : new Date(r.effective_date).toISOString(), effective_date_source: r.effective_date_source,
        effective_date_is_date: r.effective_date === null ? null : r.effective_date instanceof Date,
        chunk: r.chunk_id === null ? null : labels.get(r.chunk_id), chunk_index: r.chunk_index, chunk_text: r.chunk_text, chunk_source: r.chunk_source,
        pageIdMatches: typeof r.page_id === 'number',
      })), r => `${String(r.ord).padStart(3, '0')}:${r.chunk}`);
      const out = {
        all: view(await engine.resolveFrozenHits(hits, {})),
        def: view(await engine.resolveFrozenHits(hits, { sourceId: 'default' })),
        other: view(await engine.resolveFrozenHits(hits, { sourceIds: ['other'] })),
        none: view(await engine.resolveFrozenHits(hits, { sourceIds: [] })),
        empty: await engine.resolveFrozenHits([], {}),
      };
      expect(out.all.map(r => `${r.ord}:${r.chunk}`)).toEqual([
        '0:default:notes/a#1', '1:default:notes/a#0', '2:other:notes/b#0', '3:null', '4:null', '8:default:notes/a#0',
      ]);
      expect(out.all.find(r => r.ord === 0)).toMatchObject({ effective_date: '2026-03-04T00:00:00.000Z', effective_date_source: 'date', effective_date_is_date: true });
      return out;
    },
  );
});
