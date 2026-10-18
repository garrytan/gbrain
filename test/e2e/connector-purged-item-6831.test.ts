import { registerPostgresTests } from '../helpers/test-backends.ts';

// #6831: the PostgreSQL arm of the per-item purged skip and the stopped-source status suite.
await registerPostgresTests(() => import('../connector-purged-item-6831.test.ts'));
