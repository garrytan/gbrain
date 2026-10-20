import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/remote-keyword-private.test.ts'));
