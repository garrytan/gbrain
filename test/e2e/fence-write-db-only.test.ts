import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../fence-write-db-only.test.ts'));
