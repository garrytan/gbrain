import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../lost-ownership-reservation-10260.test.ts'));
