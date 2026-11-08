import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../serve-http-github-items-8799.test.ts'));
