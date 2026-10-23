import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../remember-replaces-valid-until-7214.test.ts'));
