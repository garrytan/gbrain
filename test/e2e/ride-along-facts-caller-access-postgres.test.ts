import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../ride-along-facts-caller-access.test.ts'));
