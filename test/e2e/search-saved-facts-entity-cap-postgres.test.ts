import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../search-saved-facts-entity-cap-7938.test.ts'));
