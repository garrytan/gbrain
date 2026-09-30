import type { Migration } from './types.ts';
import { LEASE_TOKEN_SCHEMA_SQL } from '../lease-schema.ts';

export const v152: Migration = { version: 152, name: 'unique_lock_acquisition_tokens', idempotent: true, sql: LEASE_TOKEN_SCHEMA_SQL };
