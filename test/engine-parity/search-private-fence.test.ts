/**
 * BrainEngine parity: text inside a protected fence never reaches a search read (review pass 2, finding F3 of PR 9730).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a world-readable page whose body holds a protected takes fence, written by the engine's own default
 *    `putPage` (the native store's put on the Rust arm, which chunks the page itself; the typed `putPage` on the SQL
 *    arms, which never chunks), leaves the fenced secret out of every search member's output when the read asks for
 *    privacy (`excludePrivate`, which also means `requireSafeChunks`): searchKeyword,
 *    searchKeywordPages, searchKeywordChunks, searchTitles and getChunkWindows, whether the query names the page or the
 *    secret itself. The page the same engine sealed from sanitized chunks stays searchable.
 *  - Regression: the native put split the raw body into chunks and stamped the page at the safe fence chunker, so a
 *    `requireSafeChunks` read treated chunks no sanitizer saw as safe and returned the fenced text.
 *  - Why existing coverage misses it: the TypeScript Rust wrapper always writes with `index: false`, so no parity case
 *    reached the native default chunking; chunk-safe-fence.test.ts covers the stamp after sealChunks and upsertChunks.
 *  - Seam: yes, one. The Rust arm's default put goes to the native store directly (`openStore().brain.putPage` with no
 *    `index` option), because the typed API cannot ask for it. Every read is a typed method.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import type { RustEngine } from '../../src/core/rust-engine.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest, arms } = parityArms(testBackends());

const FENCED_WORD = 'zephyr9vault';
const WORLD = 'notes/world';
const CLEAN = 'notes/clean';
const FENCE = `<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| 1 | heron guards the ${FENCED_WORD} | fact | world | 1.0 | 2026-01 | note |\n<!--- gbrain:takes:end -->`;

/** The default put of the engine's own arm: native and chunking on Rust, the typed put (no chunking) on the SQL arms. */
async function defaultPut(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  const page = { type: 'note', title: 'Heron Overview', compiled_truth: `heron overview of the marsh\n\n${FENCE}\n`, timeline: '' } as const;
  if (backend === 'rust') {
    const own = arms().find((arm) => arm.backend === 'rust')!.engine as unknown as RustEngine;
    await own.openStore('putPage').brain.putPage(WORLD, page, {});
    return;
  }
  await engine.putPage(WORLD, page);
}

/** Run `read` as a served brain does (`excludePrivate`; the schema version the connect gate records is noted first). */
async function served<T>(backend: ParityBackend, read: () => Promise<T>): Promise<T> {
  const own = arms().find((arm) => arm.backend === backend)!.engine;
  noteSchemaVersion(own, LATEST_SCHEMA_VERSION);
  return withEngineScope(own, read);
}

const leaks = (value: unknown): boolean => JSON.stringify(value).toLowerCase().includes(FENCED_WORD);

describe('protected fence text and the search members', () => {
  parityTest(
    'a page the default put wrote never returns its fenced secret from searchKeyword under excludePrivate',
    { methods: ['putPage', 'sealChunks', 'searchKeyword'] },
    async (engine, backend) => {
      // The control: a page sealed from sanitized chunks is searchable, so a silent read could not pass for safe.
      await seedPage(engine, {
        slug: CLEAN,
        input: { type: 'note', title: 'Heron Field Notes', compiled_truth: 'heron field notes', timeline: '' },
        chunks: [chunk(0, 'heron field notes')],
      });
      await defaultPut(engine, backend);
      const search = (q: string) => served(backend, () => engine.searchKeyword(q, { limit: 20, excludePrivate: true }));
      const byPage = await search('heron');
      const bySecret = await search(FENCED_WORD);
      expect({ byPage: leaks(byPage), bySecret: leaks(bySecret) }).toEqual({ byPage: false, bySecret: false });
      expect(byPage.map((r) => r.slug)).toEqual([CLEAN]);
      return { byPage: byPage.map((r) => r.slug), bySecret: bySecret.map((r) => r.slug) };
    },
  );

  // The Rust store does not serve these three under `excludePrivate` yet: each case stops on the typed refusal there (so
  // no secret can come out), and on both SQL engines the secret stays out.
  const noLeak = async (engine: BrainEngine, backend: ParityBackend, read: (q: string) => Promise<unknown[]>) => {
    await defaultPut(engine, backend);
    const leaked = await served(backend, async () => leaks([...await read('heron'), ...await read(FENCED_WORD)]));
    expect(leaked).toBe(false);
    return { leaked };
  };

  parityTest(
    'searchKeywordChunks under excludePrivate never returns the fenced secret of a default-put page',
    { methods: ['putPage', 'searchKeywordChunks'] },
    (engine, backend) => noLeak(engine, backend, (q) => engine.searchKeywordChunks(q, { limit: 20, excludePrivate: true })),
  );

  parityTest(
    'searchKeywordPages under excludePrivate never returns the fenced secret of a default-put page',
    { methods: ['putPage', 'searchKeywordPages'] },
    (engine, backend) => noLeak(engine, backend, (q) => engine.searchKeywordPages(q, { limit: 20, excludePrivate: true }, { limit: 20 })),
  );

  // The Rust store serves searchTitles under `excludePrivate`, as it does searchKeyword, so this case ends on an answer
  // there and not on a refusal. Like the searchKeyword case it seeds a sealed control page through the typed put, which
  // is also what puts `putPage` among the calls the Rust arm records.
  parityTest(
    'searchTitles under excludePrivate never returns the fenced secret of a default-put page',
    { methods: ['putPage', 'sealChunks', 'searchTitles'] },
    async (engine, backend) => {
      await seedPage(engine, {
        slug: CLEAN,
        input: { type: 'note', title: 'Heron Field Notes', compiled_truth: 'heron field notes', timeline: '' },
        chunks: [chunk(0, 'heron field notes')],
      });
      await defaultPut(engine, backend);
      const search = (q: string) => served(backend, () => engine.searchTitles(q, { limit: 20, excludePrivate: true }));
      const byPage = await search('heron');
      const bySecret = await search(FENCED_WORD);
      expect({ byPage: leaks(byPage), bySecret: leaks(bySecret) }).toEqual({ byPage: false, bySecret: false });
      return { byPage: byPage.map((r) => r.slug), bySecret: bySecret.map((r) => r.slug) };
    },
  );

  parityTest(
    'getChunkWindows under excludePrivate never returns the fenced secret of a default-put page',
    { methods: ['putPage', 'getChunkWindows'] },
    (engine, backend) => noLeak(engine, backend, async () => engine.getChunkWindows(
      [{ page_id: (await engine.getPage(WORLD))!.id, from_index: 0, to_index: 20, priority: 0 }],
      { chunkSources: ['compiled_truth', 'timeline'], maxRows: 50, excludePrivate: true })),
  );
});
