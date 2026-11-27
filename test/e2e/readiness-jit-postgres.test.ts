/**
 * The counts search adds while projections are pending (pending pages by class, and the upgrade rebuild's progress)
 * run with JIT off (`executeRaw({ jitOff: true })`): the class's subplans and a remote caller's visibility subplans
 * lift their estimates past `jit_above_cost`, and on a large brain the compilation cost more than a second on every
 * search. The embedding-held count, which runs on every search and prices low, stays a plain statement, so a search
 * on a ready brain pays no extra statements. The plan assertions run on a one-connection engine whose session sets
 * `jit_above_cost = 0`, so every statement that keeps JIT on compiles and shows a `JIT` block: the control proves
 * the assertion can fail.
 *
 * On the Rust engine trunk the counts are typed engine members. The pending, held and rebuild members take the engine's
 * own `executeRaw`, so the spy on it sees their statements through the member. The capped counts also pass a statement
 * timeout and an unnamed-statement option, so the held count is checked for the absence of `jitOff`, not for no options.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { countPendingProjections, countProjectionRebuild, type CoverageRelevance } from '../../src/core/search/retrieval-coverage.ts';
import { countEmbeddingHeldPages } from '../../src/core/engine-sql/retrieval-coverage.ts';

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

async function capture(engine: PostgresEngine, count: (spy: PostgresEngine) => Promise<unknown>): Promise<Raw[]> {
  const statements: Raw[] = [];
  const execute = engine.executeRaw.bind(engine);
  const spy = Object.assign(Object.create(engine), {
    executeRaw: (sql: string, params?: unknown[], opts?: Raw['opts']) => {
      statements.push({ sql, params: params ?? [], opts });
      return execute(sql, params, opts);
    },
  }) as PostgresEngine;
  await count(spy);
  return statements;
}

const scope = { sourceId: 'default', excludePrivate: true };
const relevance: CoverageRelevance = { all: false, types: ['note'], patterns: ['jit'], pageIds: [], exactTopPageId: null, imageArm: false };

(hasDatabase() ? describe : describe.skip)('search readiness counts without JIT (Postgres)', () => {
  beforeAll(async () => {
    const engine = await setupDB();
    for (const slug of ['notes/jit-alpha', 'notes/jit-beta']) {
      await importFromContent(engine, slug, serializeMarkdown({}, `${slug} body`, '', { type: 'note', title: slug, tags: [] }), { noEmbed: true, forceRechunk: true });
    }
  }, 120_000);
  afterAll(async () => { await teardownDB(); });

  test('the pending and rebuild counts show no JIT block; with JIT on they do', async () => {
    const reader = await oneConnection(['SET jit = on', 'SET jit_above_cost = 0']);
    try {
      const statements = [
        ...await capture(reader, async spy => expect(await countPendingProjections(spy, scope, relevance)).not.toBeNull()),
        ...await capture(reader, spy => countProjectionRebuild(spy, scope)),
      ];
      expect(statements.length).toBe(2);
      for (const statement of statements) {
        // The pending count also carries its statement timeout and unnamed-statement option (capped counts); the rebuild read only jitOff.
        expect(statement.opts?.jitOff).toBe(true);
        expect(await hasJit(reader, statement, statement.opts)).toBe(false);
        expect(await hasJit(reader, statement)).toBe(true);
      }
      expect(await reader.executeRaw(`SELECT current_setting('jit') AS jit`)).toEqual([{ jit: 'on' }]);
    } finally { await reader.disconnect(); }
  }, 60_000);

  test('the embedding-held count on every search stays one plain statement', async () => {
    const reader = await oneConnection(['SET jit = on']);
    try {
      const statements = await capture(reader, async spy => expect(await countEmbeddingHeldPages(spy.executeRaw.bind(spy), scope, relevance)).not.toBeNull());
      expect(statements.length).toBe(1);
      expect(statements[0]!.opts?.jitOff).toBeUndefined();
      expect(await reader.countEmbeddingHeldPages(scope, relevance)).not.toBeNull();
    } finally { await reader.disconnect(); }
  }, 60_000);
});
