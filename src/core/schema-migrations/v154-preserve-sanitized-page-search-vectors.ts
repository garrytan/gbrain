import type { Migration } from './types.ts';
import { PAGE_PROJECTION_SCHEMA_SQL } from '../page-state/projection-schema.ts';

export const v154: Migration = { version: 154, name: 'preserve_sanitized_page_search_vectors', idempotent: true, sql: PAGE_PROJECTION_SCHEMA_SQL };
