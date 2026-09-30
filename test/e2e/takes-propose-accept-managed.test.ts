import { registerPostgresTests } from '../helpers/test-backends.ts';

// Fix wave 4 lane E (#5764): the PostgreSQL arm of the managed take-proposal accept suite.
await registerPostgresTests(() => import('../takes-propose-accept-managed.test.ts'));
