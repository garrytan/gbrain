import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../put-page-parent-casing-9286.test.ts'));
