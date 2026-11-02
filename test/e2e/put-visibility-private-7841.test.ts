import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../put-visibility-private-7841.test.ts'));
