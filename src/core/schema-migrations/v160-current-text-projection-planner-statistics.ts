import type { Migration } from './types.ts';
import { PROJECTION_STATISTICS_SQL, verifyProjectionStatistics } from '../search/projection-statistics.ts';

export const v160: Migration = {
  version: 160,
  name: 'current_text_projection_planner_statistics',
  idempotent: true,
  sql: PROJECTION_STATISTICS_SQL,
  sqlFor: { postgres: "SET LOCAL statement_timeout = '30s'; SET LOCAL lock_timeout = '2s';" + PROJECTION_STATISTICS_SQL },
  handler: verifyProjectionStatistics,
};
