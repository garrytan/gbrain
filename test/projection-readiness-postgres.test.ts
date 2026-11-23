/**
 * Projection readiness cache on Postgres: which open transactions turn the cached answer off.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on Postgres the probe's cached answer is reused while no session holds a write on this database's
 *    `pages` table and the caller's own transaction wrote nothing. A transaction open elsewhere on the server, or one
 *    in this database that writes another table, leaves the cache on; a page write another session has not committed
 *    turns it off, so the answer after the commit is read again.
 *  - Regression: the generation read once required the whole server to have no transaction with an id, so one open
 *    write in any database (another brain, a job queue update) turned the cache off, and the parity case
 *    "a probe with no write since the last reuses its answer" failed whenever another database on the server was busy.
 *  - Why existing coverage misses it: test/projection-readiness.test.ts runs on PGLite, which has one connection, and
 *    stubs the in-flight flag; the parity case ran on a server where nothing else was open.
 *  - Seam: none. A second postgres.js connection holds the other transaction.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import {
  __resetProjectionReadinessCacheForTests, PROJECTION_READINESS_CACHE_ENV, probeProjectionReadiness,
} from '../src/core/search/projection-readiness.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const DATABASE_URL = process.env.DATABASE_URL;
let engine: PostgresEngine;
let brainUrl: string;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  const pg = await isolatedPersistencePostgres(DATABASE_URL);
  engine = pg.engine; brainUrl = pg.databaseUrl; close = pg.close;
}, 120_000);
afterAll(async () => { await close?.(); });
beforeEach(async () => {
  if (!DATABASE_URL) return;
  __resetProjectionReadinessCacheForTests();
  await engine.executeRaw('DELETE FROM pages');
});

/** Runs `body` while another session holds an open transaction that ran `statement`; rolls it back after. */
async function whileOpen<T>(url: string, statement: string, body: () => Promise<T>): Promise<T> {
  const other = postgres(url, { max: 1, prepare: false });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let opened!: () => void;
  const open = new Promise<void>(resolve => { opened = resolve; });
  const held = other.begin(async sql => { await sql.unsafe(statement); opened(); await released; throw new Error('rollback'); })
    .catch((error: unknown) => { if (!(error instanceof Error && error.message === 'rollback')) throw error; });
  try {
    await Promise.race([open, held]);
    return await body();
  } finally { release(); await held; await other.end(); }
}

const insertPage = `INSERT INTO pages (source_id, slug, title, type, page_kind, compiled_truth, chunker_version, frontmatter)
  VALUES ('default', 'notes/uncommitted', 'Uncommitted', 'concept', 'markdown', 'body', 999, '{}'::jsonb)`;

const pgTest = DATABASE_URL ? test : test.skip;

pgTest('a transaction open in another database on the server leaves the cache on', async () => {
  await withEnv({ [PROJECTION_READINESS_CACHE_ENV]: undefined }, async () => {
    await whileOpen(DATABASE_URL!, 'SELECT txid_current()', async () => {
      // A write that commits after the other transaction took its id: the server's snapshot no longer looks idle.
      await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'A body', timeline: '' });
      const first = await probeProjectionReadiness(engine);
      expect(typeof await engine.readProjectionReadinessGeneration()).toBe('string');
      expect(await probeProjectionReadiness(engine)).toBe(first);
    });
  });
});

pgTest('a transaction in this database that writes no page leaves the cache on', async () => {
  await withEnv({ [PROJECTION_READINESS_CACHE_ENV]: undefined }, async () => {
    await whileOpen(brainUrl, 'SELECT txid_current()', async () => {
      // A write that commits after the other transaction took its id: the server's snapshot no longer looks idle.
      await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'A body', timeline: '' });
      const first = await probeProjectionReadiness(engine);
      expect(typeof await engine.readProjectionReadinessGeneration()).toBe('string');
      expect(await probeProjectionReadiness(engine)).toBe(first);
    });
  });
});

pgTest('a page write another session has not committed turns the cache off, so its commit is read', async () => {
  await withEnv({ [PROJECTION_READINESS_CACHE_ENV]: undefined }, async () => {
    const other = postgres(brainUrl, { max: 1, prepare: false });
    try {
      await other.unsafe('BEGIN');
      await other.unsafe(insertPage);
      expect(await engine.readProjectionReadinessGeneration()).toBeNull();
      expect((await probeProjectionReadiness(engine)).status).toBe('ready');
      await other.unsafe('COMMIT');
      expect((await probeProjectionReadiness(engine)).status).toBe('projection_pending');
    } finally { await other.end(); }
  });
});

pgTest('a page write in the caller\'s own transaction turns the cache off', async () => {
  await withEnv({ [PROJECTION_READINESS_CACHE_ENV]: undefined }, async () => {
    const seen = await engine.transaction(async tx => {
      await tx.putPage('notes/own', { type: 'note', title: 'Own', compiled_truth: 'Own body', timeline: '' });
      return tx.readProjectionReadinessGeneration();
    });
    expect(seen).toBeNull();
    expect(typeof await engine.readProjectionReadinessGeneration()).toBe('string');
  });
});
