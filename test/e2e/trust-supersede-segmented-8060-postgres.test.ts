import { registerPostgresTests } from '../helpers/test-backends.ts';

// #8060: the PostgreSQL arm of deciding a supersede_fact proposal on a segmented page.
await registerPostgresTests(() => import('../trust-supersede-segmented-8060.test.ts'));
