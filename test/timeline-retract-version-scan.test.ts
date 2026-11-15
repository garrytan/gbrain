/**
 * #9362, PGLite arm: timeline retraction reads stored versions one body at a time before the publication transaction
 * and only checks them inside it. Postgres arm (with the reported page shape): test/e2e/timeline-retract-version-scan-postgres.test.ts.
 */
import { test } from 'bun:test';
import { scanBeforeTransactionNeverRetractsMore, segmentedPageRetractsLikeMaster, smallPageRetractsLikeMaster } from './helpers/timeline-version-scan-scenarios.ts';

test('a small page retracts what master retracts', () => smallPageRetractsLikeMaster(), 120_000);
test('a page stored in segments retracts what master retracts', () => segmentedPageRetractsLikeMaster(), 120_000);
test('a scan read before the transaction never retracts more than one inside it', () => scanBeforeTransactionNeverRetractsMore(), 120_000);
