import type { Migration } from './types.ts';
import { FACT_WITHDRAWAL_NORMALIZED_SQL } from '../facts/withdrawal-schema.ts';

export const v174: Migration = {
  // Exact-text fingerprints let a punctuation or casing variant of a
  // forgotten claim come back on re-extraction (write-path audit B-9).
  // Fingerprints now fold punctuation; legacy exact rows keep matching.
  version: 174,
  name: 'fact_withdrawal_normalized_fingerprint',
  idempotent: true,
  sql: FACT_WITHDRAWAL_NORMALIZED_SQL,
};
