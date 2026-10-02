import type { Migration } from './types.ts';
import { PERSISTENCE_TOPOLOGY_SCHEMA_SQL } from '../persistence/topology-schema.ts';

export const v157: Migration = { version: 157, name: 'recoverable_source_topology', idempotent: true, sql: PERSISTENCE_TOPOLOGY_SCHEMA_SQL };
