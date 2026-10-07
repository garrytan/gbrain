/**
 * #5234: get_versions `limit` and `include_body`.
 *
 * 1. Protects: a caller can ask for the newest N versions, or metadata only,
 *    and the bound and projection run in SQL after the scope and privacy
 *    predicates, so a bounded read never loads every body and hidden versions
 *    never shift the prefix.
 * 2. Fails when: the params are dropped, the bound is applied after loading
 *    (bodies still selected), the LIMIT runs before the privacy or source
 *    predicate, same-time snapshots order nondeterministically, or an invalid
 *    explicit limit silently returns the full history.
 * 3. Existing get_versions tests cover privacy and attribution of the full
 *    history only.
 * 4. No new seam: the real handler over PGLite (and Postgres when
 *    DATABASE_URL is set).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { toAgentError } from '../src/core/agent-output.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SOURCE = 'acme-example';
const OTHER = 'widget-co';
let engine: PGLiteEngine;
const databases: Array<{ name: string; engine: BrainEngine; close?: () => Promise<void> }> = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  databases.push({ name: 'pglite', engine });
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    databases.push({ name: 'postgres', engine: pg.engine, close: pg.close });
  }
  for (const { engine: e } of databases) {
    await e.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1), ($2, $2)', [SOURCE, OTHER]);
    await seed(e);
  }
}, 120_000);

afterAll(async () => {
  for (const { close } of databases) if (close) await close();
  await engine.disconnect();
});

/**
 * notes/history in SOURCE: versions v1..v4 (v3 and v4 share one snapshot_at,
 * so pv.id breaks the tie), then v5, a private snapshot, newest of all.
 * The same slug in OTHER has a version newer than everything in SOURCE.
 */
async function seed(e: BrainEngine): Promise<void> {
  const page = await e.putPage('notes/history', { type: 'note', title: 'History', compiled_truth: 'current body' }, { sourceId: SOURCE });
  const other = await e.putPage('notes/history', { type: 'note', title: 'Other', compiled_truth: 'other body' }, { sourceId: OTHER });
  const rows: Array<[number, string, string, string]> = [
    [page.id, 'body v1', '2026-01-01T00:00:00Z', '{"visibility":"world"}'],
    [page.id, 'body v2', '2026-01-02T00:00:00Z', '{"visibility":"world"}'],
    [page.id, 'body v3', '2026-01-03T00:00:00Z', '{"visibility":"world"}'],
    [page.id, 'body v4', '2026-01-03T00:00:00Z', '{"visibility":"world"}'],
    [page.id, 'body v5 private', '2026-01-05T00:00:00Z', '{"visibility":"private"}'],
    [other.id, 'other source body', '2026-02-01T00:00:00Z', '{"visibility":"world"}'],
  ];
  for (const [pageId, body, at, fm] of rows) {
    await e.executeRaw(
      `INSERT INTO page_versions (page_id, compiled_truth, timeline, frontmatter, snapshot_at, title)
       VALUES ($1, $2, $3, $4::text::jsonb, $5::timestamptz, $2)`,
      [pageId, body, `${body} timeline`, fm, at]);
  }
}

function ctx(e: BrainEngine, remote: boolean): OperationContext {
  return { engine: e, config: { engine: e.kind }, sourceId: SOURCE, remote, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
}

const getVersions = (e: BrainEngine, remote: boolean, params: Record<string, unknown> = {}) =>
  operationsByName.get_versions.handler(ctx(e, remote), { slug: 'notes/history', ...params }) as Promise<Array<Record<string, unknown>>>;

const bodies = (rows: Array<Record<string, unknown>>) => rows.map(r => r.compiled_truth);

describe('get_versions limit and include_body (#5234)', () => {
  test('without params the full history comes back, newest first, pv.id breaking a snapshot tie', async () => {
    for (const { engine: e } of databases) {
      expect(bodies(await getVersions(e, false))).toEqual(['body v5 private', 'body v4', 'body v3', 'body v2', 'body v1']);
    }
  });

  test('limit is the newest-first prefix of what the caller may read, local and remote', async () => {
    for (const { engine: e } of databases) {
      expect(bodies(await getVersions(e, false, { limit: 2 }))).toEqual(['body v5 private', 'body v4']);
      // The private newest snapshot and the other source's newer version are
      // filtered in WHERE, so the remote prefix is still two visible versions.
      expect(bodies(await getVersions(e, true, { limit: 2 }))).toEqual(['body v4', 'body v3']);
      expect(bodies(await getVersions(e, true, { limit: 50 }))).toEqual(['body v4', 'body v3', 'body v2', 'body v1']);
    }
  });

  test('include_body false never selects the body columns and keeps metadata and attribution', async () => {
    for (const { engine: e } of databases) {
      const rows = await e.getVersions('notes/history', { sourceId: SOURCE, includeBody: false, limit: 1 });
      expect(rows).toHaveLength(1);
      expect(Object.hasOwn(rows[0], 'compiled_truth')).toBe(false);
      expect(Object.hasOwn(rows[0], 'timeline')).toBe(false);
      expect(rows[0].title).toBe('body v5 private');

      for (const remote of [false, true]) {
        const meta = await getVersions(e, remote, { include_body: false });
        expect(meta.map(r => r.title)).toEqual(remote
          ? ['body v4', 'body v3', 'body v2', 'body v1']
          : ['body v5 private', 'body v4', 'body v3', 'body v2', 'body v1']);
        for (const row of meta) {
          expect(Object.hasOwn(row, 'compiled_truth')).toBe(false);
          expect(Object.hasOwn(row, 'timeline')).toBe(false);
          for (const key of ['id', 'page_id', 'frontmatter', 'snapshot_at']) expect(Object.hasOwn(row, key)).toBe(true);
          expect(Object.hasOwn(row, 'written_by')).toBe(!remote);
        }
      }
    }
  });

  test('limit and include_body combine; include_body must be exactly false to drop bodies', async () => {
    for (const { engine: e } of databases) {
      const [only] = await getVersions(e, true, { limit: 1, include_body: false });
      expect(only.title).toBe('body v4');
      expect(Object.hasOwn(only, 'compiled_truth')).toBe(false);
      for (const include_body of [true, undefined]) {
        expect(bodies(await getVersions(e, true, { limit: 1, include_body }))).toEqual(['body v4']);
      }
    }
  });

  test('an invalid explicit limit is refused with invalid_params, never answered with the full history', async () => {
    const render = { transport: 'stdio' as const, isCallable: () => true, preapproved: () => false };
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 'two', '2', true, 2 ** 60]) {
      const err = await getVersions(engine, true, { limit }).then(() => undefined, (e: unknown) => e);
      const env = toAgentError(err, { transport: 'stdio', op: 'get_versions', render });
      expect(env.code).toBe('invalid_params');
      expect(env.message).toBe('get_versions: limit must be a positive integer.');
      expect(env.suggestion).toContain('"limit": 5');
      expect(JSON.stringify(env)).not.toContain('two');
    }
    expect(bodies(await getVersions(engine, true, { limit: null }))).toHaveLength(4);
  });
});
