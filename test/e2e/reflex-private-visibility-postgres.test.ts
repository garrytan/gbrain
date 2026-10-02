import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../reflex-private-visibility.test.ts'));
