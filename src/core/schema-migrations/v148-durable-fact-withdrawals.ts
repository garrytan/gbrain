import type { Migration } from './types.ts';
import { FACT_WITHDRAWAL_BACKFILL_SQL, FACT_WITHDRAWAL_SCHEMA_SQL } from '../facts/withdrawal-schema.ts';

export const v148: Migration = {
  version: 148,
  name: 'durable_fact_withdrawals',
  idempotent: true,
  sql: FACT_WITHDRAWAL_SCHEMA_SQL + FACT_WITHDRAWAL_BACKFILL_SQL,
};
