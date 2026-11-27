import { registerPostgresTests } from '../helpers/test-backends.ts';

// #9968: the PostgreSQL arm of the connector deadline and recovery-stop suite.
await registerPostgresTests(() => import('../connector-recovery-deadline-9968.test.ts'));
