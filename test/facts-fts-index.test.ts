/**
 * The facts keyword index (`idx_facts_fts`) is built and replaced without
 * blocking writers or leaving search without an index (facts/fts-index.ts,
 * the facts question-recall index migration, `gbrain reindex-search-vector`).
 * Postgres builds CONCURRENTLY; PGLite inline. Every interrupted state (an
 * invalid or stale `_next`, a stray `_old`, a failed build) converges on a
 * rerun, and keyword search finds the facts at every step of the swap.
 * Postgres arm: test/e2e/facts-fts-index-postgres.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { factsFtsDocument, factsFtsIndexSql, getFtsLanguage } from '../src/core/fts-language.ts';
import { ensureFactsFtsIndex, type FactsFtsSwapStep } from '../src/core/facts/fts-index.ts';
import { v237 } from '../src/core/schema-migrations/v237-facts-question-recall-indexes.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const LANG = getFtsLanguage();
const NAMES = ['idx_facts_fts', 'idx_facts_fts_next', 'idx_facts_fts_old'];

for (const kind of testBackends()) {
  describe(`facts keyword index swap (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      for (const [i, text] of ['KAYAK Alice Example paddles a Wavecraft kayak', 'OFFSITE The quarterly offsite moved to Denver'].entries()) {
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, source) VALUES ('default', $1, $2, 'fact', 'world', now(), 'test')`,
          [i === 0 ? 'people/alice-example' : null, text]);
      }
    }, 180_000);
    afterAll(async () => { await close?.(); });

    /** name → missing | valid | invalid, plus each present index's language. */
    const states = async (): Promise<Record<string, string>> => Object.fromEntries(await Promise.all(NAMES.map(async name => {
      const [row] = await engine.executeRaw<{ valid: boolean; def: string }>(
        'SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i WHERE i.indexrelid = to_regclass($1)', [name]);
      return [name, row ? `${row.valid ? 'valid' : 'invalid'}:${/to_tsvector\('(\w+)'/.exec(row.def)?.[1]}` : 'missing'];
    })));
    const keywordHits = async () => (await engine.executeRaw<{ fact: string }>(
      `SELECT f.fact FROM facts f WHERE f.expired_at IS NULL AND ${factsFtsDocument('f', LANG)} @@ plainto_tsquery('${LANG}'::regconfig, 'kayak wavecraft')`)).map(r => r.fact.split(' ')[0]);
    /** Search works and a valid keyword index stays on facts at this step. */
    const expectServing = async (label: string) => {
      expect(await keywordHits(), label).toEqual(['KAYAK']);
      const valid = Object.entries(await states()).filter(([, s]) => s.startsWith('valid:'));
      expect(valid.length, `${label}: a valid keyword index exists`).toBeGreaterThan(0);
    };
    const dropAll = async () => { for (const name of NAMES) await engine.executeRaw(`DROP INDEX IF EXISTS ${name}`); };
    const createAs = (name: string, lang: string) => engine.executeRaw(factsFtsIndexSql(name, lang));
    const ensure = (onStep?: (step: FactsFtsSwapStep) => Promise<void>) => ensureFactsFtsIndex(engine, { lang: LANG, version: 237, onStep });

    beforeEach(async () => { await dropAll(); });

    test('the migration leaves the three indexes valid and no swap leftovers; a rerun changes nothing', async () => {
      await v237.handler!(engine);
      expect(await states()).toEqual({ idx_facts_fts: `valid:${LANG}`, idx_facts_fts_next: 'missing', idx_facts_fts_old: 'missing' });
      const others = await engine.executeRaw<{ valid: boolean }>(
        `SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid IN (to_regclass('idx_facts_unembedded'), to_regclass('idx_facts_embedding_model'))`);
      expect(others.map(r => r.valid)).toEqual([true, true]);
      expect(await ensure()).toBe('present');
      await expectServing('after the migration');
    });

    test('a language change builds the new index beside the old one and swaps it in; search works at every step', async () => {
      await createAs('idx_facts_fts', 'simple');
      const seen: Record<string, Record<string, string>> = {};
      await expectServing('before');
      expect(await ensure(async step => { seen[step] = await states(); await expectServing(step); })).toBe('swapped');
      expect(seen.built).toEqual({ idx_facts_fts: 'valid:simple', idx_facts_fts_next: `valid:${LANG}`, idx_facts_fts_old: 'missing' });
      expect(seen.renamed).toEqual({ idx_facts_fts: `valid:${LANG}`, idx_facts_fts_next: 'missing', idx_facts_fts_old: 'valid:simple' });
      expect(await states()).toEqual({ idx_facts_fts: `valid:${LANG}`, idx_facts_fts_next: 'missing', idx_facts_fts_old: 'missing' });
      await expectServing('after');
    });

    test('an INVALID _next leftover of an interrupted build is dropped and rebuilt', async () => {
      await createAs('idx_facts_fts', 'simple');
      await createAs('idx_facts_fts_next', LANG);
      await engine.executeRaw(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_facts_fts_next'::regclass`);
      expect((await states()).idx_facts_fts_next).toBe(`invalid:${LANG}`);
      expect(await ensure()).toBe('swapped');
      expect(await states()).toEqual({ idx_facts_fts: `valid:${LANG}`, idx_facts_fts_next: 'missing', idx_facts_fts_old: 'missing' });
      await expectServing('after');
    });

    test('a valid _next under another language (a reindex interrupted before a second language change) is replaced', async () => {
      await createAs('idx_facts_fts_next', 'simple');
      expect(await ensure()).toBe('swapped');
      expect(await states()).toEqual({ idx_facts_fts: `valid:${LANG}`, idx_facts_fts_next: 'missing', idx_facts_fts_old: 'missing' });
    });

    test('half-swapped: a current index with _old and _next leftovers clears both and keeps the index', async () => {
      await createAs('idx_facts_fts', LANG);
      await createAs('idx_facts_fts_old', 'simple');
      await createAs('idx_facts_fts_next', 'simple');
      expect(await ensure()).toBe('present');
      expect(await states()).toEqual({ idx_facts_fts: `valid:${LANG}`, idx_facts_fts_next: 'missing', idx_facts_fts_old: 'missing' });
      await expectServing('after');
    });

    test('a stray _old beside a stale index does not block the rename', async () => {
      await createAs('idx_facts_fts', 'simple');
      await createAs('idx_facts_fts_old', 'simple');
      expect(await ensure()).toBe('swapped');
      expect(await states()).toEqual({ idx_facts_fts: `valid:${LANG}`, idx_facts_fts_next: 'missing', idx_facts_fts_old: 'missing' });
    });

    test('a failed build leaves the live index serving, and a rerun finishes the swap', async () => {
      await createAs('idx_facts_fts', 'simple');
      const fail = (sql: string) => sql.includes('idx_facts_fts_next') && sql.trimStart().startsWith('CREATE INDEX');
      if (kind === 'postgres') {
        const reserve = engine.withReservedConnection.bind(engine);
        engine.withReservedConnection = (async (fn: Parameters<BrainEngine['withReservedConnection']>[0]) => reserve(conn => fn({
          executeRaw: async (sql: string, params?: unknown[]) => {
            if (fail(sql)) throw new Error('synthetic interrupted index build');
            return conn.executeRaw(sql, params);
          },
        } as never))) as BrainEngine['withReservedConnection'];
        try { await expect(ensure()).rejects.toThrow('synthetic interrupted index build'); } finally { engine.withReservedConnection = reserve; }
      } else {
        const run = engine.runMigration.bind(engine);
        engine.runMigration = async (version: number, sql: string) => { if (fail(sql)) throw new Error('synthetic interrupted index build'); return run(version, sql); };
        try { await expect(ensure()).rejects.toThrow('synthetic interrupted index build'); } finally { engine.runMigration = run; }
      }
      expect((await states()).idx_facts_fts).toBe('valid:simple');
      await expectServing('after the failed build');
      expect(await ensure()).toBe('swapped');
      expect(await states()).toEqual({ idx_facts_fts: `valid:${LANG}`, idx_facts_fts_next: 'missing', idx_facts_fts_old: 'missing' });
    });

    test.skipIf(kind !== 'postgres')('Postgres builds every index CONCURRENTLY on its own connection and drops CONCURRENTLY', async () => {
      await createAs('idx_facts_fts', 'simple');
      for (const name of ['idx_facts_unembedded', 'idx_facts_embedding_model']) await engine.executeRaw(`DROP INDEX IF EXISTS ${name}`);
      const reserved: string[] = [];
      const ddl: string[] = [];
      const reserve = engine.withReservedConnection.bind(engine);
      const run = engine.runMigration.bind(engine);
      engine.withReservedConnection = (async (fn: Parameters<BrainEngine['withReservedConnection']>[0]) => reserve(conn => fn({
        executeRaw: async (sql: string, params?: unknown[]) => { reserved.push(sql); return conn.executeRaw(sql, params); },
      } as never))) as BrainEngine['withReservedConnection'];
      engine.runMigration = async (version: number, sql: string) => { ddl.push(sql); return run(version, sql); };
      try { await v237.handler!(engine); } finally { engine.withReservedConnection = reserve; engine.runMigration = run; }
      expect(reserved.map(sql => sql.trim().split(/\s+/).slice(0, 8).join(' '))).toEqual([
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facts_fts_next ON',
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facts_unembedded ON',
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facts_embedding_model ON',
      ]);
      expect(ddl).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS idx_facts_fts_old', 'DROP INDEX CONCURRENTLY IF EXISTS idx_facts_fts_old']);
      expect(await states()).toEqual({ idx_facts_fts: `valid:${LANG}`, idx_facts_fts_next: 'missing', idx_facts_fts_old: 'missing' });
    });
  });
}
