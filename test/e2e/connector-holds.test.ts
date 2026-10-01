import { registerPostgresTests } from '../helpers/test-backends.ts';

// Fix wave 4 lane B: the PostgreSQL arm of the connector item-hold, #5752, #5740 and #5581 suites.
await registerPostgresTests(() => import('../connector-holds.test.ts'), () => import('../connector-dispatch-gate.test.ts'));
