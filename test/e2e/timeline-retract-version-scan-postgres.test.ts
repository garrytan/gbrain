/**
 * #9362, Postgres arm: a maintenance timeline extract on a page with hundreds of large stored versions used to read
 * every version body in one statement inside the publication transaction, hit its statement timeout (57014) and fail
 * write_interrupted on every run. Scenarios: test/helpers/timeline-version-scan-scenarios.ts.
 */
import { describe, test } from 'bun:test';
import { manyLargeVersionsPublish, scanBeforeTransactionNeverRetractsMore, segmentedPageRetractsLikeMaster, smallPageRetractsLikeMaster } from '../helpers/timeline-version-scan-scenarios.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres timeline retraction over many stored versions (#9362)', () => {
  test('a page with 300 versions of ~300 KB publishes its timeline extract over an 8 MB/s link', () => manyLargeVersionsPublish(url!), 360_000);
  test('a small page retracts what master retracts', () => smallPageRetractsLikeMaster(url), 180_000);
  test('a page stored in segments retracts what master retracts', () => segmentedPageRetractsLikeMaster(url), 180_000);
  test('a scan read before the transaction never retracts more than one inside it', () => scanBeforeTransactionNeverRetractsMore(url), 180_000);
});
