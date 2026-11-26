import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search-keyword-offset-9922.test.ts'));
