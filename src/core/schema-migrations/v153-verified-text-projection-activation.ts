import type { Migration } from './types.ts';
import { PAGE_PROJECTION_ACTIVATION_SQL, PAGE_PROJECTION_SCHEMA_SQL } from '../page-state/projection-schema.ts';

export const v153: Migration = { version: 153, name: 'verified_text_projection_activation', idempotent: true, sql: PAGE_PROJECTION_SCHEMA_SQL + PAGE_PROJECTION_ACTIVATION_SQL };
