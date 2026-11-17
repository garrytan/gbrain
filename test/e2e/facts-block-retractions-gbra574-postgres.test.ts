import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../facts-block-retractions-gbra574.test.ts'));
