/**
 * The reads behind `describeJobs` (engine-sql/jobs-insight.ts), served by the store (rust/docs/store/jobs-insight.md).
 * The lease timestamps cross the binding as ISO strings and come back as `Date`s, as PGLite returns them. The store
 * reads the holders under the same cut the SQL has (`HOLDER_LIMIT`).
 */
import { HOLDER_LIMIT, type JobInsightRows, type JobInsightSpec } from '../../engine-sql/jobs-insight.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readJobInsight: StoreMember<[spec: JobInsightSpec], JobInsightRows> = async (brain, spec) => {
  const rows: JobInsightRows = await storeCall({ member: 'readJobInsight' }, () => brain.readJobInsight({ ...spec, holderLimit: HOLDER_LIMIT }));
  return { ...rows, locks: rows.locks.map(l => withDates(l, ['acquired_at', 'ttl_expires_at'] as const)) };
};
