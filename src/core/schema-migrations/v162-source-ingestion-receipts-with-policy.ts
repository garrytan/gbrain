import type { Migration } from './types.ts';
import { SOURCE_INGESTION_RECEIPTS_SCHEMA_SQL } from '../company-brain/receipt-schema.ts';

export const v162: Migration = { version: 162, name: 'source_ingestion_receipts_with_policy', idempotent: true, sql: SOURCE_INGESTION_RECEIPTS_SCHEMA_SQL };
