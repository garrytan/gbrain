import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../takes-row-reservation.test.ts'));
