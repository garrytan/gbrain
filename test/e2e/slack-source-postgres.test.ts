import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../slack-source.test.ts'));
