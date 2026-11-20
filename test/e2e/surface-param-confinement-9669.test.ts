import { registerPostgresTests } from '../helpers/test-backends.ts';

// #9669: the PostgreSQL arm of the starter-surface parameter refusal.
await registerPostgresTests(() => import('../surface-param-confinement-9669.test.ts'));
