import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/qualified-alias-visibility.test.ts'));
