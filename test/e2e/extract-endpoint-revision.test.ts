import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';

requirePostgresTestDatabase();
await import('../extract-endpoint-revision.serial.test.ts');
