/**
 * access/members.ts verifiedMember on a brain whose member table lacks a later column.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a member-bound credential verifies on an engine that runs raw SQL even when `access_members` has not
 *    yet gained a later column (labelled_only); the engine's readAccessMembers member would select it and refuse.
 *  - Regression: sign-in read the member through readAccessMembers on every engine, so a brain with member migrations
 *    still pending refused a valid member key with access_member_disabled (found in the first /ship review).
 *  - Why existing coverage misses it: every parity and binding suite runs on a fully migrated schema.
 *  - Seam: none. A real PGLite brain; the column is dropped to stand in for a pending migration.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { verifiedMember } from '../src/core/access/members.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO access_members (id, display_name) VALUES ('alice-example', 'Alice')`);
});
afterAll(async () => { await engine.disconnect(); });

test('a member key verifies when access_members lacks a later column', async () => {
  const sql = sqlQueryForEngine(engine);
  expect(await verifiedMember(sql, 'alice-example', engine)).toEqual({ id: 'alice-example', groups: [] });
  await engine.executeRaw('ALTER TABLE access_members DROP COLUMN labelled_only');
  expect(await verifiedMember(sql, 'alice-example', engine)).toEqual({ id: 'alice-example', groups: [] });
});
