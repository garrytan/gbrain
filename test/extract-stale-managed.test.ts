/**
 * #5609: `extract --stale` on a managed-persistence brain publishes through a
 * coordinated write, stamps the extraction watermark in that transaction, and
 * the `extract.stale` recommendation stops once extraction is current or is
 * withheld when the sweep cannot run. Postgres arm: test/e2e/w5-persistence-postgres.test.ts.
 */
import { expect, test } from 'bun:test';
import { managedStaleSweep, managedStaleSweepKeepsNormalizedTimeline, staleExtractionWithheldWhenItCannotRun } from './helpers/w5-scenarios.ts';

test('managed extract --stale publishes through the coordinator and clears the recommendation', () => managedStaleSweep(), 120_000);
test('managed extract --stale does not duplicate a stored row that differs only by whitespace', () => managedStaleSweepKeepsNormalizedTimeline(), 120_000);
test('extract.stale is withheld while the sweep cannot run', () => staleExtractionWithheldWhenItCannotRun(), 120_000);

test('the remediation plan reports blocked stale extraction with its reason', async () => {
  const { SYNTHETIC_CHECK_NAMES } = await import('../src/core/remediation/plan.ts');
  const { classifyChecks } = await import('../src/core/brain-score-recommendations.ts');
  const checks = SYNTHETIC_CHECK_NAMES.map(name => ({ name, status: 'ok' as const, message: '' }));
  expect(classifyChecks(checks, { staleExtractionBlocked: 'pack unavailable' })).toContainEqual(
    { check: 'links_extraction_lag', status: 'blocked', reason: 'pack unavailable' });
});
