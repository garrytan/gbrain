import { registerPostgresTests } from '../helpers/test-backends.ts';

// #9062: the PostgreSQL arm of the connector segmented-page suite.
await registerPostgresTests(() => import('../connector-segmented-page-9062.test.ts'));
