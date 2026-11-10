import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../invocation-admission-reservations-9086.test.ts'));
