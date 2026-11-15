import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../takes-citation-8390.test.ts'));
