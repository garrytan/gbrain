import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../facts-withdrawal-fingerprint-once.test.ts'));
