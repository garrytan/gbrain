/**
 * Postgres twin of test/entity-records.test.ts: entity reference fields and
 * the record view on real Postgres (bound text[]/int[] targets, the batched
 * referrer CTE, LATERAL top-N and the temporal `since` join).
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import * as S from '../helpers/entity-records-scenarios.ts';

const d = hasDatabase() ? describe : describe.skip;
let engine: BrainEngine;

d('entity records (Postgres)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw('DELETE FROM mention_gazetteer_entries');
    await engine.executeRaw('DELETE FROM mention_index_status');
  }, 120_000);
  afterAll(async () => { await S.resetRecordsWorld(engine); await teardownDB(); });

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
