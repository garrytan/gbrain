/**
 * #5612: a Git or withdrawal target parks after five consecutive execution
 * failures instead of retrying forever, a scan moves past it, contention never
 * counts, and `retry-effects` authorizes one more attempt per parked target.
 * Postgres arm: test/e2e/w5-persistence-postgres.test.ts.
 */
import { test } from 'bun:test';
import { failuresDoNotCarryToAnotherTarget, healthyScanAndContentionNeverPark, scanParksOneTargetAndContinues, singleTargetParksAndRetries } from './helpers/w5-scenarios.ts';

test('a failing Git target parks after five failures and commits after an explicit retry', () => singleTargetParksAndRetries(), 120_000);
test('a Git scan parks its failing target, continues, and retries only that target', () => scanParksOneTargetAndContinues(), 120_000);
test('a healthy multi-page scan and worktree contention never park', () => healthyScanAndContentionNeverPark(), 120_000);
test('failures on a vanished target do not count against the next target', () => failuresDoNotCarryToAnotherTarget(), 120_000);
