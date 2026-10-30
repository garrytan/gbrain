import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../drain-lease-key-share-7442.test.ts'));
