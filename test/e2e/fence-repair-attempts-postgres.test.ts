import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../fence-repair-attempts.test.ts'));
