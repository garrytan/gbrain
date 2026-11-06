/** Slug handles in keyword search (GBRA-108) on PostgreSQL: the dual-backend cases in test/search/slug-handles.serial.test.ts. */
import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/slug-handles.serial.test.ts'));
