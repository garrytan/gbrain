/**
 * #8729: the supersession probe's connector-retry branch tests the failed row's own intent kind (when the caller passes
 * it) before it reads a candidate's intent, so a page with many later committed sync writes is not detoasted once per
 * failed row and candidate. Postgres evaluates an AND inside an OR left to right; the order is the contract.
 */
import { expect, test } from 'bun:test';
import { supersessionSql } from '../src/core/persistence/terminal-classify.ts';

test('the connector branch reads the candidate intent only after the failed row is a connector write', () => {
  const sql = supersessionSql('r', 'c', 'r.intent_kind');
  const kind = sql.indexOf("r.intent_kind IN ('connector_v2_import'");
  expect(kind).toBeGreaterThan(-1);
  expect(kind).toBeLessThan(sql.indexOf("c.intent ? 'retryOf'"));
  expect(supersessionSql('r', 'c')).not.toContain('r.intent_kind');
});
