import { registerPostgresTests } from '../helpers/test-backends.ts';

// #9669: the PostgreSQL arm of the starter descriptor and listing continuation follow-ups.
await registerPostgresTests(() => import('../surface-followups-9669.test.ts'));
