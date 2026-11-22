/**
 * Search's readiness counts (pending projections, embedding-held pages and the upgrade rebuild's progress) run with
 * JIT off (`executeRaw({ jitOff: true })`): a remote caller's visibility subplans lift their estimates past
 * `jit_above_cost`, and on a large brain the compilation cost more than a second on every search. The plan
 * assertions run on a one-connection engine whose session sets `jit_above_cost = 0`, so every statement that keeps
 * JIT on compiles and shows a `JIT` block: the control proves the assertion can fail.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { countEmbeddingHeld, countPendingProjections, countProjectionRebuild, type CoverageRelevance } from '../../src/core/search/retrieval-coverage.ts';

const url = process.env.DATABASE_URL!;
type Raw = { sql: string; params: unknown[]; opts?: { jitOff?: boolean } };

async function oneConnection(settings: string[]): Promise<PostgresEngine> {
  const engine = new PostgresEngine();
  await engine.connect({ engine: 'postgres', database_url: url, poolSize: 1 });
  for (const setting of settings) await engine.executeRaw(setting);
  return engine;
}

async function hasJit(engine: PostgresEngine, raw: Raw, opts?: { jitOff?: boolean }): Promise<boolean> {
  const [row] = await engine.executeRaw<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${raw.sql}`, raw.params, opts);
  return JSON.stringify(row!['QUERY PLAN']).includes('"JIT"');
}

async function captureReadinessCounts(engine: PostgresEngine): Promise<Raw[]> {
  const statements: Raw[] = [];
  const execute = engine.executeRaw.bind(engine);
  const spy = Object.assign(Object.create(engine), {
    executeRaw: (sql: string, params?: unknown[], opts?: Raw['opts']) => {
      statements.push({ sql, params: params ?? [], opts });
      return execute(sql, params, opts);
    },
  }) as PostgresEngine;
  const scope = { sourceId: 'default', excludePrivate: true };
  const relevance: CoverageRelevance = { all: false, types: ['note'], patterns: ['jit'], pageIds: [], exactTopPageId: null, imageArm: false };
  expect(await countPendingProjections(spy, scope, relevance)).not.toBeNull();
  expect(await countEmbeddingHeld(spy, scope, relevance)).not.toBeNull();
  await countProjectionRebuild(spy, scope);
  return statements;
}

(hasDatabase() ? describe : describe.skip)('search readiness counts without JIT (Postgres)', () => {
  beforeAll(async () => {
    const engine = await setupDB();
    for (const slug of ['notes/jit-alpha', 'notes/jit-beta']) {
      await importFromContent(engine, slug, serializeMarkdown({}, `${slug} body`, '', { type: 'note', title: slug, tags: [] }), { noEmbed: true, forceRechunk: true });
    }
  }, 120_000);
  afterAll(async () => { await teardownDB(); });

  test('each count statement shows no JIT block; with JIT on it does', async () => {
    const reader = await oneConnection(['SET jit = on', 'SET jit_above_cost = 0']);
    try {
      const statements = await captureReadinessCounts(reader);
      expect(statements.length).toBe(3);
      for (const statement of statements) {
        expect(statement.opts).toEqual({ jitOff: true });
        expect(await hasJit(reader, statement, statement.opts)).toBe(false);
        expect(await hasJit(reader, statement)).toBe(true);
      }
      expect(await reader.executeRaw(`SELECT current_setting('jit') AS jit`)).toEqual([{ jit: 'on' }]);
    } finally { await reader.disconnect(); }
  }, 60_000);
});
