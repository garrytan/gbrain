/** GST-3199 on PostgreSQL: the requester-scope grace boundary inside one second. Cases: test/helpers/serves-since-same-second.ts. */
import { describe } from 'bun:test';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { sameSecondTests } from '../helpers/serves-since-same-second.ts';

describe('requester-scope grace within one second (Postgres)', () => {
  sameSecondTests(() => isolatedPersistencePostgres(requirePostgresTestDatabase()));
});
