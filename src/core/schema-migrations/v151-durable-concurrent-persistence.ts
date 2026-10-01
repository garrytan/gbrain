import type { Migration } from './types.ts';
import { PERSISTENCE_SCHEMA_STATEMENTS } from '../persistence/schema.ts';

export const v151: Migration = { version: 151, name: 'durable_concurrent_persistence', idempotent: true, sql: PERSISTENCE_SCHEMA_STATEMENTS.join(';\n') + ';' };
