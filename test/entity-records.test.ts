/**
 * Entity reference fields and the record view (PGLite). The same scenarios run
 * on Postgres in test/e2e/entity-records-postgres.test.ts.
 *
 * Protects: compact `entity names` rows carry `referenced_by_count` and a card
 * `next` by default, and enrolled record types as `records` (page date labeled
 * as such, status, amends with its recorded `since`, supersedes), bounded per
 * page and per call with exact-remainder continuations, from one batched read
 * that equals the single-target read; hidden referrers and private dates never
 * reach untrusted callers; a late read is marked unavailable, never empty.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mentionBrain } from './helpers/mention-brain.ts';
import * as S from './helpers/entity-records-scenarios.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('entity records (PGLite)', () => {
  test('names rows carry the count and a card next by default; the key turns them off', () => S.namesRowDefaults(engine), 60_000);
  test('enrolled records on names rows: groups, order, row shape, metadata, caps, continuations', () => S.recordsOnNamesRows(engine), 60_000);
  test('batched read equals the single-target read for every target, type and caller', () => S.batchedMatchesSingle(engine), 60_000);
  test('the per-call cap allots rows in input order and keeps every total and next', () => S.callCapInInputOrder(engine), 60_000);
  test('a forced-slow read is marked unavailable with a degraded notice', () => S.deadlineGivesUnavailable(engine), 60_000);
  test('context_pack records: structured, packed text, hidden referrers excluded, push path unchanged', () => S.contextPackRecords(engine), 60_000);
  test('the full card keeps referenced_by and gains records; an undeclared type says so', () => S.fullCardRecords(engine), 60_000);
  test('a failing read is marked unavailable on the card and names rows, with one notice', () => S.readFailureGivesUnavailable(engine), 60_000);
  test('zero records is an empty list; the firing counter separates listed, zero and unavailable', () => S.zeroRecordsAndFiring(engine), 60_000);
  test('every optional record field validates against the v1 response schemas', () => S.recordFieldsSchemaValid(engine), 60_000);
  test('records pack last under 1,500 and 2,000 token budgets; newer mentions unaffected', () => S.recordsPackLast(engine), 60_000);
  test('F3 page_status on get_backlinks and context_pack rows: additive, bounded, hidden pages none; its key removes it there', () => S.pageStatusOnRows(engine), 60_000);
  test('F1 on, F3 off: record rows keep page_status on initial and continued outputs; other rows have none', () => S.recordsKeepPageStatusWithRowKeyOff(engine), 60_000);
  test('amends and supersedes targets outside the caller\'s sources never reach record rows', () => S.recordLinksStayInSources(engine), 60_000);
  test('card in-edges come back in link order, stable when page rows move', () => S.cardInEdgesInLinkOrder(engine), 60_000);
});
