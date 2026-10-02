import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../preview-approval.test.ts'));
