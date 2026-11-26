import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../extract-atoms-held-backlog-10270.test.ts'));
