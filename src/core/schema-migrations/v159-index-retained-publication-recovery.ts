import type { Migration } from './types.ts';
import { PERSISTENCE_REQUEST_RECOVERY_INDEX_SQL } from '../persistence/schema.ts';

export const v159: Migration = { version: 159, name: 'index_retained_publication_recovery', idempotent: true, sql: PERSISTENCE_REQUEST_RECOVERY_INDEX_SQL + ';' };
