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
 *    types, doctor counts, code readiness, search's unsealed-page probe, qualified names, withdrawal chunks,
 *    the chunks two deletes leave, contextual-mode candidates and frozen hits.
 *  - Regression: an engine whose read drifts gives a different code-def or
 *    code-refs answer, doctor finding, readiness status, walk candidate,
 *    withdrawal target, kept chunk set, repair plan or delivered hit per backend.
 *  - Why existing coverage misses it: the caller tests run these reads on
 *    PGLite only and never compare arms.
 *  - Owner-only sources: the last describe adds a source of kind imessage and one with owner_only set, then reads the
 *    chunk pages and windows and the code reads under `excludePrivate` as a non-owner. Every page is hidden while one
 *    exists (the closed form, no schema version in context); at schema 320 (the fn form) only the pages in those
 *    sources and the concepts synthesized from them are (`ownerOnlyAllowedSql`, src/core/search/private-visibility.ts).
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
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

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
    'hasUnsealedPages finds a live page below the safe-chunk fence under the source, privacy, type and slug-prefix filters',
    { methods: ['putPage', 'sealChunks', 'softDeletePage', 'hasUnsealedPages'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const note = (slug: string, frontmatter: Record<string, unknown> = {}): PageInput =>
        ({ type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '', frontmatter });
      // A brain whose every page is sealed has nothing below the fence.
      await engine.putPage('notes/sealed', note('notes/sealed'));
      await installChunks(engine, 'notes/sealed', [chunk(0, 'sealed body')]);
      const sealedBrain = await engine.hasUnsealedPages({});
      // other: one unsealed note under a hard-excluded prefix, one unsealed private note.
      await engine.putPage('archive/old', note('archive/old'), { sourceId: 'other' });
      await engine.putPage('notes/secret', note('notes/secret', { visibility: 'private' }), { sourceId: 'other' });
      // default: an unsealed concept page, and an unsealed page that is deleted.
      await engine.putPage('concepts/idea', { ...note('concepts/idea'), type: 'concept' });
      await engine.putPage('notes/gone', note('notes/gone'));
      await engine.softDeletePage('notes/gone');
      const result = {
        sealedBrain,
        all: await engine.hasUnsealedPages({}),
        def: await engine.hasUnsealedPages({ sourceId: 'default' }),
        defNotes: await engine.hasUnsealedPages({ sourceId: 'default', types: ['note'] }),
        defConcepts: await engine.hasUnsealedPages({ sourceId: 'default', types: ['concept'] }),
        defNoTypes: await engine.hasUnsealedPages({ sourceId: 'default', types: [] }),
        other: await engine.hasUnsealedPages({ sourceIds: ['other'] }),
        otherPublic: await engine.hasUnsealedPages({ sourceIds: ['other'], excludePrivate: true }),
        otherPublicKept: await engine.hasUnsealedPages({ sourceIds: ['other'], excludePrivate: true, excludeSlugPrefixes: ['archive/'] }),
        otherKept: await engine.hasUnsealedPages({ sourceIds: ['other'], excludeSlugPrefixes: ['archive/'] }),
        bothSources: await engine.hasUnsealedPages({ sourceIds: ['default', 'other'], types: ['note'], excludeSlugPrefixes: ['archive/', 'notes/'] }),
        none: await engine.hasUnsealedPages({ sourceIds: [] }),
      };
      expect(result).toEqual({
        sealedBrain: false, all: true, def: true, defNotes: false, defConcepts: true, defNoTypes: false,
        other: true, otherPublic: true, otherPublicKept: false, otherKept: true, bothSources: false, none: false,
      });
      return result;
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

  parityTest(
    'code reads, code chunk probes and frozen hits under excludePrivate apply a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'sealChunks', 'findCodeDefinitions', 'listSymbolTypesForName', 'findCodeRefChunks', 'codeChunksExist', 'currentCodeChunksExist', 'resolveFrozenHits'] },
    async (engine) => {
      const pages = [
        ['src/open', {}], ['src/private', { visibility: 'private' }], ['src/readers', { readable_by: ['alice-example'] }],
        ['src/team', { readable_by: 'group:team-a' }], ['src/bob-only', { readable_by: ['bob-example'] }],
        ['src/pinned', { visibility: 'private', pinned_question: true }],
      ] as const;
      for (const [slug, frontmatter] of pages) {
        await sealedCode(engine, slug, [sym(0, `function run() { /* ${slug} */ }`, 'run', 'function')], undefined, {
          frontmatter: { file: `${slug}.ts`, ...frontmatter },
        });
      }
      const hits = pages.map(([slug], ord) => ({ source_id: 'default', slug, chunk_id: 0, ord }));
      // The scope turns the chunker-version fence off, so the case reads privacy alone.
      const scope = { excludePrivate: true, requireSafeChunks: false, sourceId: 'default' };
      const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access, async () => ({
        defs: sorted((await engine.findCodeDefinitions('run', scope)).map(r => r.slug)),
        types: await engine.listSymbolTypesForName('run', scope),
        refs: sorted((await engine.findCodeRefChunks('run', scope)).map(r => r.slug)),
        stored: await engine.codeChunksExist('default', { excludePrivate: true }),
        current: await engine.currentCodeChunksExist(scope, 'with_symbol'),
        frozen: sorted((await engine.resolveFrozenHits(hits, { excludePrivate: true, requireSafeChunks: false })).map(r => r.slug)),
      }));
      const member = await read({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true });
      const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true });
      const stranger = await read({ identity: ['member:carol-example'], hidePrivate: true });
      expect(stranger.defs).toEqual(['src/open']);
      expect(member.defs).toEqual(['src/open', 'src/readers', 'src/team']);
      expect(granted.frozen).toEqual(['src/open', 'src/private', 'src/readers']);
      return { member, granted, stranger };
    },
  );

  parityTest(
    'code reads, code readiness and frozen hits under a safe-chunk scope serve only pages at or above the chunker-version fence',
    { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'findCodeDefinitions', 'listSymbolTypesForName', 'findCodeRefChunks', 'currentCodeChunksExist', 'resolveFrozenHits'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await sealedCode(engine, 'src/fenced', [sym(0, 'function run() { /* fenced */ }', 'run', 'function')]);
      // Sealed and served, but stamped short of the safe fence: only a safe-chunk read drops them.
      await sealedCode(engine, 'src/old', [sym(0, 'class Run { /* old */ }', 'run', 'class')]);
      await engine.setChunkerVersion('src/old', 3);
      await sealedCode(engine, 'src/old-other', [sym(0, 'function run() { /* old other */ }', 'run', 'function')], 'other');
      await engine.setChunkerVersion('src/old-other', 3, { sourceId: 'other' });
      const hits = [['default', 'src/fenced'], ['default', 'src/old'], ['other', 'src/old-other']]
        .map(([source_id, slug], ord) => ({ source_id, slug, chunk_id: 0, ord }));
      const read = async (scope: { requireSafeChunks?: boolean; excludePrivate?: boolean }) => ({
        defs: (await engine.findCodeDefinitions('run', { ...scope, allSources: true })).map(r => `${r.source_id}:${r.slug}`),
        types: await engine.listSymbolTypesForName('run', { ...scope, allSources: true }),
        refs: (await engine.findCodeRefChunks('run', { ...scope, allSources: true })).map(r => `${r.source_id}:${r.slug}`),
        otherReady: await engine.currentCodeChunksExist({ ...scope, sourceId: 'other' }, 'with_symbol'),
        frozen: sorted((await engine.resolveFrozenHits(hits, scope)).map(r => `${r.source_id}:${r.slug}`)),
      });
      const out = {
        fenced: await read({ requireSafeChunks: true }),
        // An excludePrivate read asks for safe chunks unless it says otherwise.
        privateImplied: await read({ excludePrivate: true }),
        privateOff: await read({ excludePrivate: true, requireSafeChunks: false }),
        open: await read({}),
      };
      expect(out.fenced).toEqual({ defs: ['default:src/fenced'], types: ['function'], refs: ['default:src/fenced'], otherReady: false, frozen: ['default:src/fenced'] });
      expect(out.privateImplied).toEqual(out.fenced);
      expect(out.open.frozen).toEqual(['default:src/fenced', 'default:src/old', 'other:src/old-other']);
      expect(out.privateOff).toEqual(out.open);
      return out;
    },
  );
});

/** The schema-320 form of the owner-only rule ('fn'): the read runs in an engine scope that records the latest schema version. */
async function underFnForm<T>(engine: BrainEngine, read: () => Promise<T>): Promise<T> {
  noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
  try {
    return await withEngineScope(engine, read);
  } finally {
    noteSchemaVersion(engine, Number.NaN);
  }
}

const READER = { identity: ['member:alice-example'], hidePrivate: true };

/** Reads `run` with no caller record and as a reader caller. */
async function asNoneAndReader<T>(run: () => Promise<T>) {
  return { none: await run(), reader: await withCallerAccess(READER, run) };
}

describe('engine parity: owner-only sources on excludePrivate chunk and code reads', () => {
  parityTest(
    'getChunkPage and getChunkWindows under excludePrivate hide every page while a source is owner-only (closed form) and only owner-only pages and their concepts at schema 320 (fn form)',
    { methods: ['putPage', 'addLink', 'sealChunks', 'getPage', 'getChunkPage', 'getChunkWindows'] },
    async (engine, backend) => {
      const refs: Array<[slug: string, sourceId: string]> = [];
      const seed = async (slug: string, sourceId: string, extra: Partial<PageInput> = {}) => {
        const opts = sourceId === 'default' ? undefined : { sourceId };
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `About ${slug}.`, timeline: '', ...extra }, opts);
        await installChunks(engine, slug, [chunk(0, `About ${slug}.`)], opts);
        refs.push([slug, sourceId]);
      };
      const concept: Partial<PageInput> = { type: 'concept', frontmatter: { visibility: 'world', synthesized_by: 'dream' } };
      await seed('notes/open', 'default');
      await seed('concepts/from-open', 'default', concept);
      await engine.addLink('concepts/from-open', 'notes/open', '', 'synthesized_from', 'concept-provenance');

      const read = () => asNoneAndReader(async () => {
        const pages: string[] = [];
        const ids = new Map<number, string>();
        for (const [slug, sourceId] of refs) {
          const page = await engine.getChunkPage(slug, { sourceId, fromIndex: 0, limit: 10, excludePrivate: true });
          if (page.total_chunks > 0) pages.push(`${sourceId}:${slug}:${page.chunks.map((c) => c.chunk_text).join('|')}`);
          ids.set((await engine.getPage(slug, { sourceId }))!.id, `${sourceId}:${slug}`);
        }
        const requests = [...ids.keys()].map((page_id) => ({ page_id, from_index: 0, to_index: 5, priority: 0 }));
        const windows = (await engine.getChunkWindows(requests, {
          chunkSources: ['compiled_truth'], maxRows: 100, sourceIds: ['default', 'chat', 'vault'], excludePrivate: true,
        })).map((p) => ids.get(p.page_id)!);
        return { pages: sorted(pages), windows: sorted(windows) };
      });
      const kept = {
        pages: ['default:concepts/from-open:About concepts/from-open.', 'default:notes/open:About notes/open.'],
        windows: ['default:concepts/from-open', 'default:notes/open'],
      };

      // Before an owner-only source exists the default pages read: the case is not vacuous.
      const before = await read();
      expect(before.none).toEqual(kept);

      await createSource(engine, backend, 'chat', { kind: 'imessage' });
      await createSource(engine, backend, 'vault', { owner_only: true });
      await seed('notes/chat-note', 'chat');
      await seed('notes/vault-note', 'vault');
      await seed('concepts/from-chat', 'default', concept);
      await engine.addLink('concepts/from-chat', 'notes/chat-note', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: 'chat' });

      // Closed form: no schema version in context. A non-owner reads nothing while any source is owner-only.
      const closed = await read();
      expect(closed.none).toEqual({ pages: [], windows: [] });
      expect(closed.reader).toEqual({ pages: [], windows: [] });

      // Fn form (schema 320): only owner-only pages, and the concept synthesized from one, are hidden.
      const fn = await underFnForm(engine, read);
      expect(fn.none).toEqual(kept);
      expect(fn.reader).toEqual(kept);
      return { before, closed, fn };
    },
  );

  parityTest(
    'code reads, code chunk probes and frozen hits under excludePrivate hide every page while a source is owner-only (closed form) and only owner-only pages at schema 320 (fn form)',
    { methods: ['putPage', 'sealChunks', 'findCodeDefinitions', 'listSymbolTypesForName', 'findCodeRefChunks', 'codeChunksExist', 'resolveFrozenHits'] },
    async (engine, backend) => {
      const seedCode = (slug: string, sourceId: string) =>
        sealedCode(engine, slug, [sym(0, `function run() { /* ${sourceId}:${slug} */ }`, 'run', 'function')], sourceId === 'default' ? undefined : sourceId);
      await seedCode('src/open', 'default');

      const hits = ['default', 'chat', 'vault'].map((source_id, ord) => ({ source_id, slug: 'src/open', chunk_id: 0, ord }));
      const labels = (rows: Array<{ source_id?: string | null; slug: string }>) => sorted(rows.map((r) => `${r.source_id}:${r.slug}`));
      // The scope turns the chunker-version fence off, so the case reads privacy alone.
      const scope = { excludePrivate: true, requireSafeChunks: false };
      const read = () => asNoneAndReader(async () => ({
        defs: labels(await engine.findCodeDefinitions('run', scope)),
        types: await engine.listSymbolTypesForName('run', scope),
        refs: labels(await engine.findCodeRefChunks('run', scope)),
        stored: await engine.codeChunksExist('default', { excludePrivate: true }),
        frozen: labels(await engine.resolveFrozenHits(hits, scope)),
      }));
      const kept = { defs: ['default:src/open'], types: ['function'], refs: ['default:src/open'], stored: true, frozen: ['default:src/open'] };

      const before = await read();
      expect(before.none).toEqual(kept);

      await createSource(engine, backend, 'chat', { kind: 'imessage' });
      await createSource(engine, backend, 'vault', { owner_only: true });
      await seedCode('src/open', 'chat');
      await seedCode('src/open', 'vault');

      const closed = await read();
      const hidden = { defs: [], types: [], refs: [], stored: false, frozen: [] };
      expect(closed.none).toEqual(hidden);
      expect(closed.reader).toEqual(hidden);

      const fn = await underFnForm(engine, read);
      expect(fn.none).toEqual(kept);
      expect(fn.reader).toEqual(kept);
      return { before, closed, fn };
    },
  );
});

describe('engine parity: the safe-chunk fence on getChunks', () => {
  parityTest(
    'getChunks with requireSafeChunks reads a page only when its chunker version meets the safe fence, as the import chunk reuse asks',
    { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'getChunks'] },
    async (engine) => {
      // sealChunks stamps the current chunker version, so each page's version under test is stamped after the seal.
      const versions: Array<[string, number]> = [['notes/fence-old', 3], ['notes/fence-safe', 4], ['notes/fence-high', 9], ['notes/fence-zero', 0]];
      for (const [slug] of versions) {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' });
        await installChunks(engine, slug, [chunk(0, `${slug} first`), chunk(1, `${slug} second`)]);
      }
      for (const [slug, version] of versions) await engine.setChunkerVersion(slug, version, { sourceId: 'default' });
      const read = async (slug: string, requireSafeChunks?: boolean) =>
        (await engine.getChunks(slug, { sourceId: 'default', includeEmbedding: true, requireSafeChunks })).map(c => `${c.chunk_index}:${c.chunk_text}`);
      const out: Record<string, unknown> = {};
      for (const slug of ['notes/fence-old', 'notes/fence-safe', 'notes/fence-high', 'notes/fence-zero', 'notes/missing']) {
        out[slug] = { safe: await read(slug, true), plain: await read(slug, false), unset: await read(slug) };
      }
      expect(out['notes/fence-old']).toEqual({ safe: [], plain: ['0:notes/fence-old first', '1:notes/fence-old second'], unset: ['0:notes/fence-old first', '1:notes/fence-old second'] });
      expect((out['notes/fence-safe'] as { safe: string[] }).safe).toEqual(['0:notes/fence-safe first', '1:notes/fence-safe second']);
      return out;
    },
  );
});
