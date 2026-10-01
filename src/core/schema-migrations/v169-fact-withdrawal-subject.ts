import type { Migration } from './types.ts';
import { FACT_WITHDRAWAL_SUBJECT_SQL } from '../facts/withdrawal-schema.ts';

export const v169: Migration = {
  // A withdrawal keyed only on the claim text expired and blocked that claim
  // for every entity in the source. New withdrawals carry the forgotten
  // row's subject; existing rows keep the source-wide '*' subject.
  version: 169,
  name: 'fact_withdrawal_subject',
  idempotent: true,
  sql: FACT_WITHDRAWAL_SUBJECT_SQL,
};
