/**
 * #7871: a corpus file is classified by its real path as well as its spelled
 * path. Transcript listing follows symlinks, so a meeting dir (or an --input
 * path) that aliases the session corpus, a corpus dir configured through a
 * symlink, or a spool dir linked outside the corpus all name corpus files by a
 * path outside the corpus. Before the fix `corpusLocation` compared
 * `resolve()` paths only, so those files passed as non-corpus transcripts
 * and were synthesized (or atom-extracted) into the cycle's source. A file
 * whose real path cannot be read is held, never passed through.
 *
 * A multi-source brain with repo-less directories; PGLite and, with
 * DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { CORPUS_SPOOL_SUBDIR, sessionCorpusFileName } from '../src/core/context/corpus-segments.ts';
import { emptySessionSourceRouting, keepSessionSourceTranscripts } from '../src/core/cycle/synthesize-source-routing.ts';
import type { DiscoveredTranscript } from '../src/core/cycle/transcript-discovery.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
});

const transcript = (filePath: string): DiscoveredTranscript =>
  ({ filePath, content: 'x', contentHash: 'h', basename: basename(filePath, '.txt'), inferredDate: null });

async function route(engine: BrainEngine, files: string[], corpusDir: string, sourceId: string) {
  const routing = emptySessionSourceRouting();
  const kept = await keepSessionSourceTranscripts(engine, files.map(transcript), { corpusDir, sourceId }, routing);
  return { kept: kept.map(t => t.filePath), routing };
}

async function brain(run: (engine: BrainEngine, dir: string, other: string) => Promise<void>): Promise<void> {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-corpus-realpath-'));
    const other = `source-b-${randomUUID().slice(0, 8)}`;
    try {
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [other]);
      await run(engine, dir, other);
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id = $1', [other]);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

describe('#7871 corpus files are recognized through symlinks', () => {
  test('a meeting dir that aliases the corpus: its legacy file is held and its stamped file goes to its own source', async () => {
    await brain(async (engine, dir, other) => {
      const corpus = join(dir, 'corpus');
      mkdirSync(join(corpus, CORPUS_SPOOL_SUBDIR), { recursive: true });
      writeFileSync(join(corpus, 'sess-legacy.txt'), 'x');
      const stamped = sessionCorpusFileName('sess-stamped', other);
      writeFileSync(join(corpus, CORPUS_SPOOL_SUBDIR, stamped), 'x');
      const meetings = join(dir, 'meetings');
      symlinkSync(corpus, meetings);
      const { kept, routing } = await route(engine, [join(meetings, 'sess-legacy.txt'), join(meetings, CORPUS_SPOOL_SUBDIR, stamped)], corpus, 'default');
      expect(kept).toEqual([]);
      expect(routing).toEqual({ corpus_source_other: { [other]: 1 }, held: { corpus_legacy_unstamped: 1 } });
    });
  }, 60_000);

  test('a corpus dir configured through a symlink still owns the files listed by their real path', async () => {
    await brain(async (engine, dir, other) => {
      const real = join(dir, 'corpus-real');
      mkdirSync(join(real, CORPUS_SPOOL_SUBDIR), { recursive: true });
      const stamped = sessionCorpusFileName('sess-stamped', other);
      writeFileSync(join(real, CORPUS_SPOOL_SUBDIR, stamped), 'x');
      const link = join(dir, 'corpus');
      symlinkSync(real, link);
      const { kept, routing } = await route(engine, [join(real, CORPUS_SPOOL_SUBDIR, stamped)], link, 'default');
      expect(kept).toEqual([]);
      expect(routing.corpus_source_other).toEqual({ [other]: 1 });
    });
  }, 60_000);

  test('a spool dir linked outside the corpus still classifies its files as spool files', async () => {
    await brain(async (engine, dir, other) => {
      const corpus = join(dir, 'corpus');
      const elsewhere = join(dir, 'spool-elsewhere');
      mkdirSync(corpus);
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(corpus, CORPUS_SPOOL_SUBDIR));
      const stamped = sessionCorpusFileName('sess-stamped', other);
      writeFileSync(join(elsewhere, stamped), 'x');
      const { kept, routing } = await route(engine, [join(elsewhere, stamped)], corpus, 'default');
      expect(kept).toEqual([]);
      expect(routing.corpus_source_other).toEqual({ [other]: 1 });
    });
  }, 60_000);

  test('a corpus entry that links to a file outside stays a corpus file; a real outside file still passes', async () => {
    await brain(async (engine, dir) => {
      const corpus = join(dir, 'corpus');
      mkdirSync(corpus);
      const outside = join(dir, 'notes.txt');
      writeFileSync(outside, 'x');
      symlinkSync(outside, join(corpus, 'sess-link.txt'));
      const { kept, routing } = await route(engine, [join(corpus, 'sess-link.txt'), outside], corpus, 'default');
      expect(kept).toEqual([outside]);
      expect(routing.held).toEqual({ corpus_legacy_unstamped: 1 });
    });
  }, 60_000);

  test('a listed path whose real path cannot be read is held, never passed to the cycle source', async () => {
    await brain(async (engine, dir) => {
      const corpus = join(dir, 'corpus');
      mkdirSync(corpus);
      const dangling = join(dir, 'meetings', 'gone.txt');
      mkdirSync(join(dir, 'meetings'));
      symlinkSync(join(dir, 'nowhere.txt'), dangling);
      const { kept, routing } = await route(engine, [dangling], corpus, 'default');
      expect(kept).toEqual([]);
      expect(routing.held).toEqual({ corpus_path_unresolvable: 1 });
    });
  }, 60_000);

  test('a path outside the corpus that no longer exists is not a corpus file, so it is not held as a captured session', async () => {
    await brain(async (engine, dir) => {
      const corpus = join(dir, 'corpus');
      mkdirSync(corpus);
      const gone = join(dir, 'meetings', 'gone.txt');
      const { kept, routing } = await route(engine, [gone], corpus, 'default');
      expect(kept).toEqual([gone]);
      expect(routing.held).toEqual({});
    });
  }, 60_000);
});
