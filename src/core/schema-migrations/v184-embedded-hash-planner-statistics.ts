import type { Migration } from './types.ts';
import { EMBEDDED_HASH_STATISTICS_SQL, verifyEmbeddedHashStatistics } from '../search/embedded-hash-statistics.ts';

export const v184: Migration = {
  version: 184,
  name: 'embedded_hash_planner_statistics',
  idempotent: true,
  sql: EMBEDDED_HASH_STATISTICS_SQL,
  sqlFor: { postgres: "SET LOCAL statement_timeout = '30s'; SET LOCAL lock_timeout = '2s';" + EMBEDDED_HASH_STATISTICS_SQL },
  handler: verifyEmbeddedHashStatistics,
};
