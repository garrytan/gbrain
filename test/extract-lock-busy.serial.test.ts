import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { extractLockTimeoutMs, extractStaleFromDB, runExtract } from '../src/commands/extract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

describe.skipIf(!process.env.DATABASE_URL)('extract skips busy page write locks', () => {
  let engine: BrainEngine;
  let databaseUrl: string;
  let close: () => Promise<void>;
  let priorLockTimeoutEnv: string | undefined;
  let fixture = 0;

  beforeAll(async () => {
    priorLockTimeoutEnv = process.env.GBRAIN_EXTRACT_LOCK_TIMEOUT_MS;
    process.env.GBRAIN_EXTRACT_LOCK_TIMEOUT_MS = '500';
    ({ engine, databaseUrl, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
  }, 120_000);

  afterAll(async () => {
    if (priorLockTimeoutEnv === undefined) delete process.env.GBRAIN_EXTRACT_LOCK_TIMEOUT_MS;
    else process.env.GBRAIN_EXTRACT_LOCK_TIMEOUT_MS = priorLockTimeoutEnv;
    await close?.();
  });

  async function seed() {
    const sourceId = `extract-lock-busy-${++fixture}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
    for (const [slug, target] of [['notes/a', 'notes/c'], ['notes/b', 'notes/c'], ['notes/c', 'notes/a']]) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Links to [[${target}]].` }, { sourceId });
    }
    await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1', [sourceId]);
    const [{ source_incarnation }] = await engine.executeRaw<{ source_incarnation: string }>(
      'SELECT incarnation AS source_incarnation FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw(
      'INSERT INTO page_write_guards(source_incarnation, slug) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING',
      [source_incarnation, 'notes/b'],
    );
    return { sourceId, sourceIncarnation: source_incarnation };
  }

  async function holdPage(sourceIncarnation: string) {
    const sql = postgres(databaseUrl, { max: 1 });
    const reserved = await sql.reserve();
    await reserved`BEGIN`;
    await reserved`SELECT slug FROM page_write_guards WHERE source_incarnation=${sourceIncarnation}::uuid AND slug='notes/b' FOR UPDATE`;
    let releasePromise: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const release = async () => {
      if (releasePromise) return releasePromise;
      clearTimeout(timer);
      releasePromise = (async () => {
        await reserved`ROLLBACK`;
        reserved.release();
        await sql.end();
      })();
      return releasePromise;
    };
    timer = setTimeout(() => { void release(); }, 5000);
    return release;
  }

  async function stamps(sourceId: string) {
    return engine.executeRaw<{ slug: string; links_extracted_at: Date | null }>(
      'SELECT slug, links_extracted_at FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId]);
  }

  async function markdownOrigins(sourceId: string) {
    return engine.executeRaw<{ slug: string }>(`SELECT f.slug
      FROM links l JOIN pages f ON f.id=l.from_page_id
      WHERE f.source_id=$1 AND l.link_source='markdown' ORDER BY f.slug`, [sourceId]);
  }

  test('stale extraction skips the busy page and leaves it stale', async () => {
    const { sourceId, sourceIncarnation } = await seed();
    const release = await holdPage(sourceIncarnation);
    const started = Date.now();
    try {
      const result = await extractStaleFromDB(engine, {
        dryRun: false, jsonMode: true, quiet: true, sourceIdFilter: sourceId,
        includeFrontmatter: false, catchUp: false,
      });
      expect(result.skippedLockBusy).toBe(1);
      const extractionStamps = await stamps(sourceId);
      expect(extractionStamps.map(row => row.slug)).toEqual(['notes/a', 'notes/b', 'notes/c']);
      expect(extractionStamps[0].links_extracted_at).not.toBeNull();
      expect(extractionStamps[1].links_extracted_at).toBeNull();
      expect(extractionStamps[2].links_extracted_at).not.toBeNull();
      expect((await markdownOrigins(sourceId)).map(row => row.slug)).toEqual(['notes/a', 'notes/c']);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await release();
    }
  }, 30_000);

  test('non-stale extraction skips the busy page and continues', async () => {
    const { sourceId, sourceIncarnation } = await seed();
    const release = await holdPage(sourceIncarnation);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runExtract(engine, ['links', '--source', 'db', '--source-id', sourceId, '--json']);
      expect((await markdownOrigins(sourceId)).map(row => row.slug)).toEqual(['notes/a', 'notes/c']);
      expect(logSpy.mock.calls.flat().join('\n')).toContain('"skipped_lock_busy": 1');
    } finally {
      logSpy.mockRestore();
      await release();
    }
  }, 30_000);

  test('non-lock errors still abort stale extraction', async () => {
    const { sourceId } = await seed();
    const originalTransaction = engine.transaction.bind(engine);
    engine.transaction = async <T>(fn: (tx: BrainEngine) => Promise<T>) => originalTransaction(async tx => {
      tx.readPageSnapshot = async () => { throw new Error('boom'); };
      return fn(tx);
    });
    try {
      await expect(extractStaleFromDB(engine, {
        dryRun: false, jsonMode: true, quiet: true, sourceIdFilter: sourceId,
        includeFrontmatter: false, catchUp: false,
      })).rejects.toThrow(/boom/);
    } finally {
      engine.transaction = originalTransaction;
    }
  });

  test('restores lock_timeout after acquiring each page lock', async () => {
    const { sourceId } = await seed();
    const observed: string[] = [];
    const originalTransaction = engine.transaction.bind(engine);
    engine.transaction = async <T>(fn: (tx: BrainEngine) => Promise<T>) => originalTransaction(async tx => {
      const originalReadPageSnapshot = tx.readPageSnapshot.bind(tx);
      tx.readPageSnapshot = async (...args) => {
        const [{ lock_timeout }] = await tx.executeRaw<{ lock_timeout: string }>(
          "SELECT current_setting('lock_timeout') AS lock_timeout");
        observed.push(lock_timeout);
        return originalReadPageSnapshot(...args);
      };
      return fn(tx);
    });
    try {
      await extractStaleFromDB(engine, {
        dryRun: false, jsonMode: true, quiet: true, sourceIdFilter: sourceId,
        includeFrontmatter: false, catchUp: false,
      });
      expect(observed).toEqual(['0', '0', '0']);
    } finally {
      engine.transaction = originalTransaction;
    }
  });

  test('validates the extraction lock timeout override', () => {
    const prior = process.env.GBRAIN_EXTRACT_LOCK_TIMEOUT_MS;
    try {
      delete process.env.GBRAIN_EXTRACT_LOCK_TIMEOUT_MS;
      expect(extractLockTimeoutMs()).toBe(5000);
      process.env.GBRAIN_EXTRACT_LOCK_TIMEOUT_MS = '500';
      expect(extractLockTimeoutMs()).toBe(500);
      process.env.GBRAIN_EXTRACT_LOCK_TIMEOUT_MS = 'abc';
      expect(() => extractLockTimeoutMs()).toThrow('GBRAIN_EXTRACT_LOCK_TIMEOUT_MS must be an integer >= 100 (ms)');
      process.env.GBRAIN_EXTRACT_LOCK_TIMEOUT_MS = '50';
      expect(() => extractLockTimeoutMs()).toThrow('GBRAIN_EXTRACT_LOCK_TIMEOUT_MS must be an integer >= 100 (ms)');
    } finally {
      if (prior === undefined) delete process.env.GBRAIN_EXTRACT_LOCK_TIMEOUT_MS;
      else process.env.GBRAIN_EXTRACT_LOCK_TIMEOUT_MS = prior;
    }
  });
});
