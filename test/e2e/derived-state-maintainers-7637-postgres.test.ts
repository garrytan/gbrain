import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../derived-state-maintainers-7637.test.ts'));
