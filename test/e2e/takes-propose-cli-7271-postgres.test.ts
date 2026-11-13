import { registerPostgresTests } from '../helpers/test-backends.ts';

// #7271: the PostgreSQL arm of the takes propose --accept CLI test.
await registerPostgresTests(() => import('../takes-propose-cli-7271.test.ts'));
