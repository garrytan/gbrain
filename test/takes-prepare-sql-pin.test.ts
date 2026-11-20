/**
 * The typed members the takes publication's prepare step (persistence/takes-prepare.ts) and the fence hold clear
 * (generations/fence.ts `clearFenceHold`) call send Postgres the statements those callers sent through `executeRaw`
 * before they became typed members: the same text and the same bound values.
 *
 * Protects: a takes write keeps its exact Postgres statements for the trust-row read, the resolution stamp, the
 * request's recorded holders (the `$2::text::jsonb` bind, so the array is stored as jsonb, not a jsonb string) and the
 * fence hold clear. findTakeId and deleteTakeRows already had pins (extract-takes-sql-pin, takes members); the caller's
 * old trust-row read selected `id,trust_tier` where readTakeTrustRow selects `id,claim,trust_tier`, so that pin names the
 * member's text.
 * Fails when a member's text or parameter order drifts from the statement its caller wrote by hand.
 * No database: the engine runs on the recording fake.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

/** The (text, params) of every query statement `fn` sends. */
async function sent(fn: (engine: PostgresEngine) => Promise<unknown>): Promise<Array<{ text: string; params: unknown[] }>> {
  const fake = makeFakeSql(() => undefined);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  await fn(engine);
  return fake.trace.flatMap(s => (s.kind === 'query' ? [{ text: s.text, params: s.params }] : []));
}

async function same(old: (e: PostgresEngine) => Promise<unknown>, typed: (e: PostgresEngine) => Promise<unknown>) {
  const before = await sent(old);
  expect(before).toHaveLength(1);
  expect(await sent(typed)).toEqual(before);
}

describe('the takes prepare step sends the hand-written Postgres statements', () => {
  test('readTakeTrustRow (takes_remove, takes_supersede, the written row)', () => same(
    e => e.executeRaw('SELECT id,claim,trust_tier FROM takes WHERE page_id=$1 AND row_num=$2', [7, 3]),
    e => e.readTakeTrustRow(7, 3)));

  test('stampTakeResolvedAt (a resolution with its own date)', () => same(
    e => e.executeRaw('UPDATE takes SET resolved_at=$3::timestamptz WHERE page_id=$1 AND row_num=$2', [7, 1, '2026-11-20']),
    e => e.stampTakeResolvedAt(7, 1, '2026-11-20')));

  test('recordTakeHoldersUsed (the holders the write used)', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    return same(
      e => e.executeRaw(`UPDATE persistence_requests
      SET authority=jsonb_set(authority,'{takeHoldersUsed}',$2::text::jsonb)
      WHERE id=$1::uuid`, [id, JSON.stringify(['people/alice-example', 'world'])]),
      e => e.recordTakeHoldersUsed(id, ['people/alice-example', 'world']));
  });

  test('clearFenceHoldRows (generations/fence.ts clearFenceHold)', () => same(
    e => e.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND held_reason IN ('fence_absent','no_proof')`,
      ['default', 'takes_fence', 'page:people/alice-example']),
    e => e.clearFenceHoldRows('default', 'takes_fence', 'page:people/alice-example')));
});
