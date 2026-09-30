import type { Migration } from './types.ts';
import { PAGE_VERSION_DELETION_SCHEMA_SQL } from '../page-state/schema.ts';

export const v158: Migration = { version: 158, name: 'canonical_version_deletion_state', idempotent: true, sql: PAGE_VERSION_DELETION_SCHEMA_SQL };
